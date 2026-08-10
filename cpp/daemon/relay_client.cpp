#include "daemon/relay_client.hpp"

#include <arpa/inet.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <openssl/evp.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

#include <algorithm>
#include <cerrno>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <optional>
#include <random>
#include <utility>

#include "daemon/outbound.hpp"

namespace ap {
namespace {

using sv = std::string_view;

long long now_ms() {
    using namespace std::chrono;
    return duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
}

int left_ms(long long deadline) {
    const long long left = deadline - now_ms();
    return left > 0 ? static_cast<int>(left) : 0;
}

char lower(char c) { return (c >= 'A' && c <= 'Z') ? static_cast<char>(c - 'A' + 'a') : c; }

std::string lowered(sv s) {
    std::string out;
    out.reserve(s.size());
    for (char c : s) out.push_back(lower(c));
    return out;
}

bool iequals(sv a, sv b) {
    if (a.size() != b.size()) return false;
    for (size_t i = 0; i < a.size(); ++i) {
        if (lower(a[i]) != lower(b[i])) return false;
    }
    return true;
}

sv trim(sv s) {
    while (!s.empty() && (s.front() == ' ' || s.front() == '\t')) s.remove_prefix(1);
    while (!s.empty() && (s.back() == ' ' || s.back() == '\t')) s.remove_suffix(1);
    return s;
}

// -- a JSON reader just big enough for the relay's frames --------------------
//
// Not a general parser. It walks an object one key at a time and hands back the
// raw slice of a value, which is all this file ever needs: four string fields, a
// nested region object and one array of them. Writing a DOM would be more code
// and one more thing to keep correct.

constexpr size_t npos = sv::npos;

size_t skip_ws(sv s, size_t i) {
    while (i < s.size() && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) ++i;
    return i;
}

/// One past the closing quote of the string literal at `i`, or npos.
size_t scan_string(sv s, size_t i) {
    if (i >= s.size() || s[i] != '"') return npos;
    ++i;
    while (i < s.size()) {
        if (s[i] == '\\') {
            i += 2;
            continue;
        }
        if (s[i] == '"') return i + 1;
        ++i;
    }
    return npos;
}

/// One past the end of the value starting at `i`, or npos when it is truncated.
size_t scan_value(sv s, size_t i) {
    i = skip_ws(s, i);
    if (i >= s.size()) return npos;

    const char c = s[i];
    if (c == '"') return scan_string(s, i);

    if (c == '{' || c == '[') {
        const char open = c;
        const char close = (c == '{') ? '}' : ']';
        int depth = 0;
        while (i < s.size()) {
            if (s[i] == '"') {
                const size_t e = scan_string(s, i);
                if (e == npos) return npos;
                i = e;
                continue;
            }
            if (s[i] == open) {
                ++depth;
            } else if (s[i] == close) {
                if (--depth == 0) return i + 1;
            }
            ++i;
        }
        return npos;
    }

    // Number, true, false or null: everything up to the next structural byte.
    size_t j = i;
    while (j < s.size() && s[j] != ',' && s[j] != '}' && s[j] != ']' && s[j] != ' ' &&
           s[j] != '\t' && s[j] != '\n' && s[j] != '\r') {
        ++j;
    }
    return j > i ? j : npos;
}

void append_utf8(std::string& out, unsigned cp) {
    if (cp < 0x80) {
        out += static_cast<char>(cp);
    } else if (cp < 0x800) {
        out += static_cast<char>(0xC0 | (cp >> 6));
        out += static_cast<char>(0x80 | (cp & 0x3F));
    } else if (cp < 0x10000) {
        out += static_cast<char>(0xE0 | (cp >> 12));
        out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
        out += static_cast<char>(0x80 | (cp & 0x3F));
    } else {
        out += static_cast<char>(0xF0 | (cp >> 18));
        out += static_cast<char>(0x80 | ((cp >> 12) & 0x3F));
        out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
        out += static_cast<char>(0x80 | (cp & 0x3F));
    }
}

bool hex4(sv s, size_t pos, unsigned& out) {
    if (pos + 4 > s.size()) return false;
    unsigned v = 0;
    for (int i = 0; i < 4; ++i) {
        const char c = s[pos + i];
        v <<= 4;
        if (c >= '0' && c <= '9') v |= static_cast<unsigned>(c - '0');
        else if (c >= 'a' && c <= 'f') v |= static_cast<unsigned>(c - 'a' + 10);
        else if (c >= 'A' && c <= 'F') v |= static_cast<unsigned>(c - 'A' + 10);
        else return false;
    }
    out = v;
    return true;
}

/// `lit` includes its quotes. Escapes are decoded, so a path arrives here
/// byte-identical to the one the other machine's hook was handed.
std::string decode_string(sv lit) {
    if (lit.size() < 2 || lit.front() != '"') return {};
    std::string out;
    size_t i = 1;
    const size_t end = lit.size() - 1;
    while (i < end) {
        const char c = lit[i];
        if (c != '\\') {
            out += c;
            ++i;
            continue;
        }
        if (i + 1 >= end) break;
        const char e = lit[i + 1];
        i += 2;
        switch (e) {
            case 'n': out += '\n'; break;
            case 't': out += '\t'; break;
            case 'r': out += '\r'; break;
            case 'b': out += '\b'; break;
            case 'f': out += '\f'; break;
            case 'u': {
                unsigned cp = 0;
                if (!hex4(lit, i, cp)) return out;
                i += 4;
                if (cp >= 0xD800 && cp <= 0xDBFF) {
                    unsigned lo = 0;
                    if (i + 6 <= end && lit[i] == '\\' && lit[i + 1] == 'u' &&
                        hex4(lit, i + 2, lo) && lo >= 0xDC00 && lo <= 0xDFFF) {
                        cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                        i += 6;
                    } else {
                        cp = 0xFFFD;
                    }
                } else if (cp >= 0xDC00 && cp <= 0xDFFF) {
                    cp = 0xFFFD;
                }
                append_utf8(out, cp);
                break;
            }
            default: out += e; break;  // \" \\ \/ and anything odd
        }
    }
    return out;
}

/// The raw slice of `key`'s value in the object `obj`, which must start with
/// '{'. Nothing is returned for a truncated or malformed object.
std::optional<sv> object_get(sv obj, sv key) {
    const size_t start = skip_ws(obj, 0);
    if (start >= obj.size() || obj[start] != '{') return std::nullopt;

    size_t i = start + 1;
    for (;;) {
        i = skip_ws(obj, i);
        if (i >= obj.size() || obj[i] == '}') return std::nullopt;
        if (obj[i] != '"') return std::nullopt;

        const size_t ke = scan_string(obj, i);
        if (ke == npos) return std::nullopt;
        const sv klit = obj.substr(i, ke - i);

        i = skip_ws(obj, ke);
        if (i >= obj.size() || obj[i] != ':') return std::nullopt;

        const size_t vs = skip_ws(obj, i + 1);
        const size_t ve = scan_value(obj, vs);
        if (ve == npos) return std::nullopt;

        if (decode_string(klit) == key) return obj.substr(vs, ve - vs);

        i = skip_ws(obj, ve);
        if (i < obj.size() && obj[i] == ',') {
            ++i;
            continue;
        }
        return std::nullopt;
    }
}

std::vector<sv> array_elements(sv arr) {
    std::vector<sv> out;
    const size_t start = skip_ws(arr, 0);
    if (start >= arr.size() || arr[start] != '[') return out;

    size_t i = start + 1;
    for (;;) {
        i = skip_ws(arr, i);
        if (i >= arr.size() || arr[i] == ']') return out;
        const size_t ve = scan_value(arr, i);
        if (ve == npos) return out;
        out.push_back(arr.substr(i, ve - i));
        i = skip_ws(arr, ve);
        if (i < arr.size() && arr[i] == ',') {
            ++i;
            continue;
        }
        return out;
    }
}

std::string str_field(sv obj, sv key) {
    const auto v = object_get(obj, key);
    if (!v || v->empty() || v->front() != '"') return {};
    return decode_string(*v);
}

std::optional<double> num_field(sv obj, sv key) {
    const auto v = object_get(obj, key);
    if (!v || v->empty()) return std::nullopt;
    const char c = v->front();
    if (c != '-' && c != '+' && c != '.' && !(c >= '0' && c <= '9')) return std::nullopt;
    const std::string s(*v);
    char* end = nullptr;
    const double d = std::strtod(s.c_str(), &end);
    if (end == s.c_str()) return std::nullopt;
    return d;
}

bool bool_field(sv obj, sv key) {
    const auto v = object_get(obj, key);
    return v && *v == "true";
}

std::string json_escape(sv s) {
    std::string out;
    out.reserve(s.size() + 8);
    for (unsigned char c : s) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            case '\b': out += "\\b"; break;
            case '\f': out += "\\f"; break;
            default:
                if (c < 0x20) {
                    static const char* hexd = "0123456789abcdef";
                    out += "\\u00";
                    out += hexd[c >> 4];
                    out += hexd[c & 0xF];
                } else {
                    out += static_cast<char>(c);
                }
        }
    }
    return out;
}

// -- sockets ----------------------------------------------------------------

bool set_nonblocking(int fd) {
    const int flags = ::fcntl(fd, F_GETFL, 0);
    if (flags < 0) return false;
    return ::fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0;
}

/// A write to a socket the relay already closed must return an error, not kill
/// the daemon with SIGPIPE. Linux says so per call, BSD per socket.
void suppress_sigpipe(int fd) {
#ifdef SO_NOSIGPIPE
    int one = 1;
    ::setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one));
#else
    (void)fd;
#endif
}

int send_flags() {
#ifdef MSG_NOSIGNAL
    return MSG_NOSIGNAL;
#else
    return 0;
#endif
}

bool is_numeric_host(const std::string& host) {
    in_addr v4{};
    in6_addr v6{};
    return ::inet_pton(AF_INET, host.c_str(), &v4) == 1 ||
           ::inet_pton(AF_INET6, host.c_str(), &v6) == 1;
}

/// Blocking. Only ever called on a worker thread — see RelayClient::begin_resolve.
std::vector<std::string> resolve_host(std::string host) {
    std::vector<std::string> out;
    addrinfo hints{};
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;

    addrinfo* res = nullptr;
    if (::getaddrinfo(host.c_str(), nullptr, &hints, &res) != 0) return out;
    for (addrinfo* p = res; p != nullptr; p = p->ai_next) {
        char buf[INET6_ADDRSTRLEN] = {0};
        if (p->ai_family == AF_INET) {
            ::inet_ntop(AF_INET, &reinterpret_cast<sockaddr_in*>(p->ai_addr)->sin_addr, buf,
                        sizeof(buf));
        } else if (p->ai_family == AF_INET6) {
            ::inet_ntop(AF_INET6, &reinterpret_cast<sockaddr_in6*>(p->ai_addr)->sin6_addr, buf,
                        sizeof(buf));
        } else {
            continue;
        }
        if (buf[0] != '\0') out.emplace_back(buf);
    }
    ::freeaddrinfo(res);
    return out;
}

bool fill_addr(const std::string& numeric, int port, sockaddr_storage& ss, socklen_t& len,
               int& family) {
    std::memset(&ss, 0, sizeof(ss));
    in_addr v4{};
    if (::inet_pton(AF_INET, numeric.c_str(), &v4) == 1) {
        auto* a = reinterpret_cast<sockaddr_in*>(&ss);
        a->sin_family = AF_INET;
        a->sin_addr = v4;
        a->sin_port = htons(static_cast<uint16_t>(port));
        len = sizeof(sockaddr_in);
        family = AF_INET;
        return true;
    }
    in6_addr v6{};
    if (::inet_pton(AF_INET6, numeric.c_str(), &v6) == 1) {
        auto* a = reinterpret_cast<sockaddr_in6*>(&ss);
        a->sin6_family = AF_INET6;
        a->sin6_addr = v6;
        a->sin6_port = htons(static_cast<uint16_t>(port));
        len = sizeof(sockaddr_in6);
        family = AF_INET6;
        return true;
    }
    return false;
}

void wait_idle(long long ms) {
    if (ms > 0) ::poll(nullptr, 0, static_cast<int>(ms));
}

}  // namespace

// ---------------------------------------------------------------------------
// ws
// ---------------------------------------------------------------------------

namespace ws {
namespace {

bool is_control(Opcode op) { return (static_cast<std::uint8_t>(op) & 0x8) != 0; }

bool known_opcode(std::uint8_t op) {
    return op == 0x0 || op == 0x1 || op == 0x2 || op == 0x8 || op == 0x9 || op == 0xA;
}

void put_header(std::string& out, Opcode op, std::size_t len, bool fin, bool masked) {
    out.push_back(static_cast<char>((fin ? 0x80 : 0x00) | static_cast<std::uint8_t>(op)));
    const std::uint8_t maskbit = masked ? 0x80 : 0x00;
    if (len < 126) {
        out.push_back(static_cast<char>(maskbit | static_cast<std::uint8_t>(len)));
    } else if (len <= 0xFFFF) {
        out.push_back(static_cast<char>(maskbit | 126));
        out.push_back(static_cast<char>((len >> 8) & 0xFF));
        out.push_back(static_cast<char>(len & 0xFF));
    } else {
        out.push_back(static_cast<char>(maskbit | 127));
        for (int shift = 56; shift >= 0; shift -= 8) {
            out.push_back(static_cast<char>((static_cast<std::uint64_t>(len) >> shift) & 0xFF));
        }
    }
}

}  // namespace

std::string encode_frame(Opcode op, sv payload, bool fin, std::uint32_t mask_key) {
    std::string out;
    out.reserve(payload.size() + 14);
    put_header(out, op, payload.size(), fin, true);

    unsigned char mask[4];
    for (int i = 0; i < 4; ++i) {
        mask[i] = static_cast<unsigned char>((mask_key >> (24 - 8 * i)) & 0xFF);
        out.push_back(static_cast<char>(mask[i]));
    }
    for (std::size_t i = 0; i < payload.size(); ++i) {
        out.push_back(static_cast<char>(static_cast<unsigned char>(payload[i]) ^ mask[i % 4]));
    }
    return out;
}

std::string encode_unmasked(Opcode op, sv payload, bool fin) {
    std::string out;
    out.reserve(payload.size() + 10);
    put_header(out, op, payload.size(), fin, false);
    out.append(payload);
    return out;
}

Parse parse_frame(sv buf, Frame& out, std::size_t& consumed) {
    if (buf.size() < 2) return Parse::NeedMore;

    const auto b0 = static_cast<std::uint8_t>(buf[0]);
    const auto b1 = static_cast<std::uint8_t>(buf[1]);

    if ((b0 & 0x70) != 0) return Parse::Error;  // RSV1-3 with nothing negotiated
    const std::uint8_t opcode = b0 & 0x0F;
    if (!known_opcode(opcode)) return Parse::Error;

    const bool fin = (b0 & 0x80) != 0;
    const bool masked = (b1 & 0x80) != 0;
    const std::uint8_t len7 = b1 & 0x7F;

    std::size_t pos = 2;
    std::uint64_t len = len7;
    if (len7 == 126) {
        if (buf.size() < 4) return Parse::NeedMore;
        len = (static_cast<std::uint64_t>(static_cast<std::uint8_t>(buf[2])) << 8) |
              static_cast<std::uint8_t>(buf[3]);
        pos = 4;
    } else if (len7 == 127) {
        if (buf.size() < 10) return Parse::NeedMore;
        len = 0;
        for (int i = 0; i < 8; ++i) {
            len = (len << 8) | static_cast<std::uint8_t>(buf[2 + i]);
        }
        // The high bit must be clear (5.2). It is also the cheapest way to ask
        // an unwary client for eight exabytes of heap.
        if ((len >> 63) != 0) return Parse::Error;
        pos = 10;
    }

    const Opcode op = static_cast<Opcode>(opcode);
    if (is_control(op)) {
        if (!fin) return Parse::Error;                 // control frames never fragment
        if (len > kMaxControlBytes) return Parse::Error;
    }
    if (len > kMaxMessageBytes) return Parse::Error;

    unsigned char mask[4] = {0, 0, 0, 0};
    if (masked) {
        if (buf.size() < pos + 4) return Parse::NeedMore;
        for (int i = 0; i < 4; ++i) mask[i] = static_cast<unsigned char>(buf[pos + i]);
        pos += 4;
    }

    const std::size_t total = pos + static_cast<std::size_t>(len);
    if (buf.size() < total) return Parse::NeedMore;

    out.op = op;
    out.fin = fin;
    out.masked = masked;
    out.payload.assign(buf.substr(pos, static_cast<std::size_t>(len)));
    if (masked) {
        for (std::size_t i = 0; i < out.payload.size(); ++i) {
            out.payload[i] = static_cast<char>(static_cast<unsigned char>(out.payload[i]) ^
                                               mask[i % 4]);
        }
    }
    consumed = total;
    return Parse::Ok;
}

bool Assembler::feed(sv bytes, std::vector<Message>& out) {
    if (failed_) return false;
    buf_.append(bytes);

    for (;;) {
        Frame f;
        std::size_t used = 0;
        const Parse r = parse_frame(buf_, f, used);

        if (r == Parse::NeedMore) {
            // A frame header that never completes must not become a memory
            // leak with extra steps.
            if (buf_.size() > kMaxMessageBytes + 16) {
                failed_ = true;
                return false;
            }
            return true;
        }
        if (r == Parse::Error) {
            failed_ = true;
            return false;
        }

        buf_.erase(0, used);

        // 5.1: a server never masks. A masked frame here means we are not
        // talking to a websocket server, whatever it said during the upgrade.
        if (f.masked) {
            failed_ = true;
            return false;
        }

        if (is_control(f.op)) {
            // Straight out, without disturbing a message in progress (5.4).
            out.push_back(Message{f.op, std::move(f.payload)});
            continue;
        }

        if (f.op == Opcode::Continuation) {
            if (!in_message_) {
                failed_ = true;
                return false;
            }
            if (partial_.size() + f.payload.size() > kMaxMessageBytes) {
                failed_ = true;
                return false;
            }
            partial_ += f.payload;
            if (f.fin) {
                out.push_back(Message{partial_op_, std::move(partial_)});
                partial_.clear();
                in_message_ = false;
            }
            continue;
        }

        if (in_message_) {
            failed_ = true;  // a new message on top of an unfinished one
            return false;
        }
        if (f.fin) {
            out.push_back(Message{f.op, std::move(f.payload)});
        } else {
            in_message_ = true;
            partial_op_ = f.op;
            partial_ = std::move(f.payload);
        }
    }
}

std::string base64(sv raw) {
    static const char* tbl = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    out.reserve(((raw.size() + 2) / 3) * 4);

    std::size_t i = 0;
    while (i + 3 <= raw.size()) {
        const std::uint32_t v = (static_cast<std::uint8_t>(raw[i]) << 16) |
                                (static_cast<std::uint8_t>(raw[i + 1]) << 8) |
                                static_cast<std::uint8_t>(raw[i + 2]);
        out.push_back(tbl[(v >> 18) & 0x3F]);
        out.push_back(tbl[(v >> 12) & 0x3F]);
        out.push_back(tbl[(v >> 6) & 0x3F]);
        out.push_back(tbl[v & 0x3F]);
        i += 3;
    }
    const std::size_t rest = raw.size() - i;
    if (rest == 1) {
        const std::uint32_t v = static_cast<std::uint8_t>(raw[i]) << 16;
        out.push_back(tbl[(v >> 18) & 0x3F]);
        out.push_back(tbl[(v >> 12) & 0x3F]);
        out += "==";
    } else if (rest == 2) {
        const std::uint32_t v = (static_cast<std::uint8_t>(raw[i]) << 16) |
                                (static_cast<std::uint8_t>(raw[i + 1]) << 8);
        out.push_back(tbl[(v >> 18) & 0x3F]);
        out.push_back(tbl[(v >> 12) & 0x3F]);
        out.push_back(tbl[(v >> 6) & 0x3F]);
        out.push_back('=');
    }
    return out;
}

std::string accept_token(sv key_b64) {
    static constexpr sv kGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    std::string input(key_b64);
    input.append(kGuid);

    unsigned char digest[EVP_MAX_MD_SIZE];
    unsigned int len = 0;
    // EVP rather than the deprecated one-shot SHA1(), same as repo.cpp does
    // for sha256. Same bytes out, no deprecation warnings in.
    if (EVP_Digest(input.data(), input.size(), digest, &len, EVP_sha1(), nullptr) != 1) return {};
    return base64(sv(reinterpret_cast<const char*>(digest), len));
}

std::string random_key() {
    std::random_device rd;
    std::string raw;
    raw.reserve(16);
    for (int i = 0; i < 16; ++i) raw.push_back(static_cast<char>(rd() & 0xFF));
    return base64(raw);
}

std::string handshake_request(const std::string& host, int port, const std::string& path,
                              const std::string& key_b64) {
    std::string req = "GET ";
    req += path.empty() ? "/" : path;
    req += " HTTP/1.1\r\nHost: ";
    req += host;
    req += ":";
    req += std::to_string(port);
    req += "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ";
    req += key_b64;
    req += "\r\nSec-WebSocket-Version: 13\r\n\r\n";
    return req;
}

Handshake check_handshake(sv buf, sv key_b64) {
    Handshake h;
    const auto end = buf.find("\r\n\r\n");
    if (end == sv::npos) {
        // A peer that answers with headers forever is not a relay.
        if (buf.size() > 16384) {
            h.done = true;
            h.ok = false;
        }
        return h;
    }

    h.done = true;
    h.consumed = end + 4;
    const sv head = buf.substr(0, end + 2);  // keep the trailing CRLF on the last header

    const auto eol = head.find("\r\n");
    const sv status = head.substr(0, eol);
    if (status.size() < 12 || lowered(status.substr(0, 5)) != "http/") return h;
    if (status.find(" 101 ") == sv::npos && status.substr(status.size() - 4) != " 101") return h;

    bool upgrade_ok = false;
    bool connection_ok = false;
    bool accept_ok = false;
    const std::string want = std::string(accept_token(key_b64));

    size_t pos = eol + 2;
    while (pos < head.size()) {
        const auto e = head.find("\r\n", pos);
        if (e == sv::npos) break;
        const sv line = head.substr(pos, e - pos);
        pos = e + 2;

        const auto colon = line.find(':');
        if (colon == sv::npos) continue;
        const sv name = trim(line.substr(0, colon));
        const sv value = trim(line.substr(colon + 1));

        if (iequals(name, "upgrade")) {
            upgrade_ok = iequals(value, "websocket");
        } else if (iequals(name, "connection")) {
            connection_ok = lowered(value).find("upgrade") != std::string::npos;
        } else if (iequals(name, "sec-websocket-accept")) {
            accept_ok = !want.empty() && value == want;
        }
    }

    h.ok = upgrade_ok && connection_ok && accept_ok;
    return h;
}

}  // namespace ws

// ---------------------------------------------------------------------------
// url + region key
// ---------------------------------------------------------------------------

namespace {

bool parse_port(sv s, int& out) {
    if (s.empty() || s.size() > 5) return false;
    int v = 0;
    for (char c : s) {
        if (c < '0' || c > '9') return false;
        v = v * 10 + (c - '0');
    }
    if (v <= 0 || v > 65535) return false;
    out = v;
    return true;
}

}  // namespace

RelayUrl parse_relay_url(const std::string& url) {
    RelayUrl out;
    // wss is refused rather than quietly downgraded: this client has no TLS,
    // and connecting in cleartext to an address the operator marked as
    // encrypted is the worst of the available answers.
    if (url.size() < 6 || lowered(sv(url).substr(0, 5)) != "ws://") return out;

    sv rest = sv(url).substr(5);
    if (rest.empty()) return out;

    sv hostpart;
    sv after;
    if (rest.front() == '[') {  // literal IPv6
        const auto rb = rest.find(']');
        if (rb == sv::npos || rb == 1) return out;
        hostpart = rest.substr(1, rb - 1);
        after = rest.substr(rb + 1);

        const auto slash = after.find('/');
        const sv portpart = after.substr(0, slash == sv::npos ? after.size() : slash);
        out.path = slash == sv::npos ? "/" : std::string(after.substr(slash));
        out.port = 80;
        if (!portpart.empty()) {
            if (portpart.front() != ':') return out;
            if (!parse_port(portpart.substr(1), out.port)) return out;
        }
    } else {
        const auto slash = rest.find('/');
        const sv hostport = rest.substr(0, slash == sv::npos ? rest.size() : slash);
        out.path = slash == sv::npos ? "/" : std::string(rest.substr(slash));

        const auto colon = hostport.rfind(':');
        out.port = 80;
        if (colon == sv::npos) {
            hostpart = hostport;
        } else {
            hostpart = hostport.substr(0, colon);
            if (!parse_port(hostport.substr(colon + 1), out.port)) return out;
        }
    }

    if (hostpart.empty()) return out;
    out.host = std::string(hostpart);
    out.ok = true;
    return out;
}

std::string region_key(const std::string& path, const std::string& symbol) {
    return path + "|" + symbol;
}

std::string relay_event_frame(const std::string& redacted_line) {
    const sv j(redacted_line);
    const std::string verb = str_field(j, "verb");
    const std::string path = str_field(j, "path");
    if (verb.empty() || path.empty()) return {};

    std::string out = "{\"type\":\"event\",\"source\":\"hook\",\"verb\":\"";
    out += json_escape(verb);
    out += "\",\"agent\":\"";
    out += json_escape(str_field(j, "agent"));
    out += "\",\"human\":\"";
    out += json_escape(str_field(j, "human"));
    // symbol and lines are spelled out rather than omitted: redact._clean_region
    // fills them in either way, and being explicit means the frame on the wire
    // is the frame the relay works with.
    out += "\",\"region\":{\"path\":\"";
    out += json_escape(path);
    out += "\",\"symbol\":null,\"lines\":null}}";
    return out;
}

// ---------------------------------------------------------------------------
// RelayClient
// ---------------------------------------------------------------------------

RelayClient::RelayClient(RelayConfig cfg, Outbound& outbound, LeaseCache& leases)
    : cfg_(std::move(cfg)),
      outbound_(outbound),
      leases_(leases),
      rng_(std::random_device{}()) {
    url_ = parse_relay_url(cfg_.url);
    if (cfg_.backoff_min_ms <= 0) cfg_.backoff_min_ms = 1;
    if (cfg_.backoff_max_ms < cfg_.backoff_min_ms) cfg_.backoff_max_ms = cfg_.backoff_min_ms;
}

RelayClient::~RelayClient() {
    close_socket();
    // A lookup still in flight owns this future. Waiting for it here is the
    // only blocking call in the class and it happens once, at shutdown.
    if (resolve_.valid()) resolve_.wait();
}

void RelayClient::on_peer(std::function<void(const RelayPeer&)> cb) { on_peer_ = std::move(cb); }

void RelayClient::send_text(std::string json) { outbound_.push(std::move(json)); }

void RelayClient::close_socket() {
    if (fd_ >= 0) {
        ::close(fd_);
        fd_ = -1;
    }
    rbuf_.clear();
    wbuf_.clear();
    assembler_ = ws::Assembler{};
}

void RelayClient::drop(const char* why) {
    if (state_ == State::Open) ++drops_;
    last_error_ = why;
    close_socket();

    backoff_ms_ = backoff_ms_ == 0 ? cfg_.backoff_min_ms
                                   : std::min(backoff_ms_ * 2, cfg_.backoff_max_ms);
    retry_at_ = now_ms() + backoff_ms_;
    state_ = State::Backoff;
    // Re-resolve on the next attempt. A relay that moved is indistinguishable
    // from one that is down, and a cached address would hide the move forever.
    addrs_.clear();
    addr_idx_ = 0;
}

void RelayClient::begin_resolve() {
    if (is_numeric_host(url_.host)) {
        addrs_ = {url_.host};
        state_ = State::Idle;
        return;
    }
    if (!resolve_.valid()) {
        // getaddrinfo blocks, sometimes for seconds. The daemon has hooks to
        // answer, so the lookup goes on its own thread and poll() keeps its
        // timeout.
        resolve_ = std::async(std::launch::async, resolve_host, url_.host);
    }
    state_ = State::Resolving;
}

bool RelayClient::step_resolving(long long deadline) {
    if (!resolve_.valid()) {
        state_ = State::Idle;
        return true;
    }
    const auto status = resolve_.wait_for(std::chrono::milliseconds(left_ms(deadline)));
    if (status != std::future_status::ready) return false;

    addrs_ = resolve_.get();
    if (addrs_.empty()) {
        drop("name lookup failed");
        return true;
    }
    addr_idx_ = 0;
    state_ = State::Idle;
    return true;
}

bool RelayClient::begin_connect() {
    if (!url_.ok) {
        drop("relay url is not ws://host[:port][/path]");
        return true;
    }
    if (addrs_.empty()) {
        begin_resolve();
        return true;
    }

    ++attempts_;
    const std::string& addr = addrs_[addr_idx_ % addrs_.size()];
    ++addr_idx_;

    sockaddr_storage ss{};
    socklen_t slen = 0;
    int family = 0;
    if (!fill_addr(addr, url_.port, ss, slen, family)) {
        drop("unusable address");
        return true;
    }

    fd_ = ::socket(family, SOCK_STREAM, 0);
    if (fd_ < 0) {
        drop("socket() failed");
        return true;
    }
    if (!set_nonblocking(fd_)) {
        drop("could not set O_NONBLOCK");
        return true;
    }
    suppress_sigpipe(fd_);
    int one = 1;
    ::setsockopt(fd_, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));

    const int r = ::connect(fd_, reinterpret_cast<sockaddr*>(&ss), slen);
    if (r == 0) {
        start_handshake();
        return true;
    }
    if (errno == EINPROGRESS || errno == EINTR) {
        state_ = State::Connecting;
        return true;
    }
    drop("connect failed");
    return true;
}

void RelayClient::start_handshake() {
    key_ = ws::random_key();
    rbuf_.clear();
    wbuf_ = ws::handshake_request(url_.host, url_.port, url_.path, key_);
    assembler_ = ws::Assembler{};
    state_ = State::Handshaking;
    if (!flush()) drop("write failed during upgrade");
}

bool RelayClient::step_connecting(long long deadline) {
    pollfd p{fd_, POLLOUT, 0};
    const int r = ::poll(&p, 1, left_ms(deadline));
    if (r < 0) return false;   // EINTR: try again next tick
    if (r == 0) return false;  // still connecting

    if ((p.revents & (POLLERR | POLLNVAL)) != 0) {
        drop("connect refused");
        return true;
    }
    int err = 0;
    socklen_t len = sizeof(err);
    if (::getsockopt(fd_, SOL_SOCKET, SO_ERROR, &err, &len) != 0 || err != 0) {
        drop("connect refused");
        return true;
    }
    if ((p.revents & (POLLOUT | POLLHUP)) == 0) return false;

    start_handshake();
    return true;
}

bool RelayClient::step_handshaking(long long deadline) {
    if (state_ != State::Handshaking) return true;  // flush() already dropped us

    pollfd p{fd_, static_cast<short>(POLLIN | (wbuf_.empty() ? 0 : POLLOUT)), 0};
    const int r = ::poll(&p, 1, left_ms(deadline));
    if (r <= 0) return false;

    if ((p.revents & POLLOUT) != 0 && !flush()) {
        drop("write failed during upgrade");
        return true;
    }

    if ((p.revents & POLLIN) != 0) {
        char chunk[4096];
        const ssize_t n = ::recv(fd_, chunk, sizeof(chunk), 0);
        if (n == 0) {
            drop("relay hung up during upgrade");
            return true;
        }
        if (n < 0) {
            if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) return false;
            drop("read failed during upgrade");
            return true;
        }
        rbuf_.append(chunk, static_cast<std::size_t>(n));

        const auto h = ws::check_handshake(rbuf_, key_);
        if (!h.done) return false;
        if (!h.ok) {
            drop("upgrade refused");
            return true;
        }

        // Whatever followed the headers is already frame data.
        const std::string leftover = rbuf_.substr(h.consumed);
        rbuf_.clear();

        state_ = State::Open;
        backoff_ms_ = 0;
        last_rx_ms_ = now_ms();
        last_ping_ms_ = last_rx_ms_;
        send_join();

        if (!leftover.empty()) {
            std::vector<ws::Message> msgs;
            if (!assembler_.feed(leftover, msgs)) {
                ++protocol_errors_;
                drop("protocol error");
                return true;
            }
            for (const auto& m : msgs) {
                on_message(m);
                if (state_ != State::Open) return true;
            }
        }
        return true;
    }

    if ((p.revents & (POLLERR | POLLHUP | POLLNVAL)) != 0) {
        drop("connection reset during upgrade");
        return true;
    }
    return false;
}

void RelayClient::send_join() {
    std::string j = "{\"type\":\"join\",\"room\":\"";
    j += json_escape(cfg_.room);
    j += "\",\"agent\":\"";
    j += json_escape(cfg_.agent);
    j += "\",\"human\":\"";
    j += json_escape(cfg_.human);
    j += "\"}";
    queue_frame(ws::Opcode::Text, j);
    ++sent_;
}

void RelayClient::queue_frame(ws::Opcode op, sv payload) {
    const auto mask = static_cast<std::uint32_t>(rng_());
    wbuf_ += ws::encode_frame(op, payload, true, mask);
}

bool RelayClient::flush() {
    while (!wbuf_.empty()) {
        const ssize_t n = ::send(fd_, wbuf_.data(), wbuf_.size(), send_flags());
        if (n > 0) {
            wbuf_.erase(0, static_cast<std::size_t>(n));
            continue;
        }
        if (n < 0 && errno == EINTR) continue;
        if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) return true;
        return false;
    }
    return true;
}

bool RelayClient::step_open(long long deadline) {
    const long long t = now_ms();

    // A half-open TCP connection reads exactly like a quiet relay. Only the
    // clock can tell them apart.
    if (t - last_rx_ms_ > cfg_.idle_timeout_ms) {
        drop("relay went quiet");
        return true;
    }
    if (t - last_ping_ms_ >= cfg_.ping_interval_ms) {
        queue_frame(ws::Opcode::Ping, "");
        last_ping_ms_ = t;
    }

    // Backpressure: once the socket is this far behind, leave the rest in
    // Outbound, which is bounded and drops oldest. Pulling it in here would
    // turn a bounded queue into an unbounded one.
    if (wbuf_.size() < cfg_.write_high_water) {
        for (auto& msg : outbound_.drain()) {
            queue_frame(ws::Opcode::Text, msg);
            ++sent_;
        }
    }
    if (!flush()) {
        drop("write failed");
        return true;
    }

    pollfd p{fd_, static_cast<short>(POLLIN | (wbuf_.empty() ? 0 : POLLOUT)), 0};
    const int r = ::poll(&p, 1, left_ms(deadline));
    if (r <= 0) return false;

    if ((p.revents & POLLOUT) != 0 && !flush()) {
        drop("write failed");
        return true;
    }

    if ((p.revents & POLLIN) != 0) {
        char chunk[8192];
        for (;;) {
            const ssize_t n = ::recv(fd_, chunk, sizeof(chunk), 0);
            if (n > 0) {
                last_rx_ms_ = now_ms();
                std::vector<ws::Message> msgs;
                if (!assembler_.feed(sv(chunk, static_cast<std::size_t>(n)), msgs)) {
                    ++protocol_errors_;
                    drop("protocol error");
                    return true;
                }
                for (const auto& m : msgs) {
                    on_message(m);
                    if (state_ != State::Open) return true;
                }
                if (static_cast<std::size_t>(n) < sizeof(chunk)) break;
                continue;
            }
            if (n == 0) {
                drop("relay hung up");
                return true;
            }
            if (errno == EINTR) continue;
            if (errno == EAGAIN || errno == EWOULDBLOCK) break;
            drop("read failed");
            return true;
        }
        return false;
    }

    if ((p.revents & (POLLERR | POLLHUP | POLLNVAL)) != 0) {
        drop("connection reset");
        return true;
    }
    return false;
}

void RelayClient::poll(int timeout_ms) {
    const long long deadline = now_ms() + (timeout_ms > 0 ? timeout_ms : 0);

    // Bounded so a state machine bug can never become a spin in the daemon's
    // main loop. Every iteration either changes state or returns.
    for (int guard = 0; guard < 32; ++guard) {
        switch (state_) {
            case State::Backoff: {
                const long long left = retry_at_ - now_ms();
                if (left > 0) {
                    wait_idle(std::min<long long>(left, left_ms(deadline)));
                    return;
                }
                state_ = State::Idle;
                break;
            }
            case State::Idle:
                if (!begin_connect()) return;
                break;
            case State::Resolving:
                if (!step_resolving(deadline)) return;
                break;
            case State::Connecting:
                if (!step_connecting(deadline)) return;
                break;
            case State::Handshaking:
                if (!step_handshaking(deadline)) return;
                break;
            case State::Open:
                if (!step_open(deadline)) return;
                break;
        }
        if (left_ms(deadline) == 0) return;
    }
}

// -- inbound frames ---------------------------------------------------------

void RelayClient::on_message(const ws::Message& m) {
    ++received_;
    switch (m.op) {
        case ws::Opcode::Text:
            on_text(m.payload);
            break;
        case ws::Opcode::Ping:
            queue_frame(ws::Opcode::Pong, m.payload);
            flush();
            break;
        case ws::Opcode::Pong:
            break;  // liveness only; last_rx_ms_ already moved
        case ws::Opcode::Close: {
            // Echo the status code back before hanging up (5.5.1).
            const std::string body = m.payload.size() >= 2 ? m.payload.substr(0, 2) : std::string();
            queue_frame(ws::Opcode::Close, body);
            flush();
            drop("relay closed the connection");
            break;
        }
        default:
            break;  // binary: the relay speaks JSON, so this is not for us
    }
}

void RelayClient::on_text(const std::string& json) {
    const sv j(json);
    const std::string kind = str_field(j, "type");
    if (kind.empty()) return;

    if (kind == "presence") {
        RelayPeer peer;
        peer.agent = str_field(j, "agent");
        if (peer.agent.empty()) return;  // an unattributable peer is not a peer
        peer.human = str_field(j, "human");
        peer.verb = str_field(j, "verb");
        if (const auto region = object_get(j, "region"); region && !region->empty()) {
            peer.path = str_field(*region, "path");
        }
        if (on_peer_) on_peer_(peer);
        return;
    }

    if (kind == "leases") {
        const auto arr = object_get(j, "leases");
        // Only a real array replaces the table. Garbage under that key means a
        // frame we do not understand, and wiping every lease on it would turn
        // one bad frame into a room with no protection.
        if (!arr || arr->empty() || arr->front() != '[') return;
        held_.clear();
        for (const sv e : array_elements(*arr)) upsert_lease(e, {});
        apply_leases();
        return;
    }

    if (kind == "lease") {
        const std::string state = str_field(j, "state");
        if (state == "released" || state == "expired") {
            const auto region = object_get(j, "region");
            if (!region) return;
            const std::string path = str_field(*region, "path");
            if (path.empty()) return;
            // Matched on the agent, not just the region — see erase_lease.
            if (erase_lease(region_key(path, str_field(*region, "symbol")),
                            str_field(j, "agent"))) {
                apply_leases();
            }
            return;
        }
        if (upsert_lease(j, {})) apply_leases();
        return;
    }

    if (kind == "claim_result") {
        // Granted means the holder is us; refused names whoever beat us to it.
        // Either way the cache learns something true about that region.
        const std::string holder = bool_field(j, "granted") ? cfg_.agent : str_field(j, "held_by");
        if (holder.empty()) return;
        if (upsert_lease(j, holder)) apply_leases();
        return;
    }
}

bool RelayClient::upsert_lease(sv entry, const std::string& holder_override) {
    const auto region = object_get(entry, "region");
    if (!region || region->empty() || region->front() != '{') return false;

    const std::string path = str_field(*region, "path");
    if (path.empty()) return false;

    CachedLease lease;
    lease.agent = holder_override.empty() ? str_field(entry, "agent") : holder_override;
    if (lease.agent.empty()) return false;
    lease.human = str_field(entry, "human");
    lease.intent = str_field(entry, "intent");

    // Time remaining, never an absolute timestamp. The relay stamps wall clock
    // seconds and LeaseCache is asked with the daemon's monotonic clock; the
    // two have no relationship at all, and mixing them would either expire
    // every lease instantly or none of them ever.
    long long ttl = cfg_.lease_ttl_ms;
    if (const auto ms = num_field(entry, "expires_in_ms")) {
        ttl = static_cast<long long>(*ms);
    } else if (const auto s = num_field(entry, "expires_in_s")) {
        ttl = static_cast<long long>(*s * 1000.0);
    }
    if (ttl < 0) ttl = 0;
    lease.expires_at_ms = now_ms() + ttl;

    held_[region_key(path, str_field(*region, "symbol"))] = std::move(lease);
    return true;
}

bool RelayClient::erase_lease(const std::string& key, const std::string& agent) {
    if (agent.empty()) return false;
    const auto it = held_.find(key);
    if (it == held_.end()) return false;
    if (it->second.agent != agent) return false;  // somebody else holds it now
    held_.erase(it);
    return true;
}

void RelayClient::apply_leases() {
    std::vector<std::pair<std::string, CachedLease>> entries;
    entries.reserve(held_.size());
    for (const auto& kv : held_) entries.emplace_back(kv.first, kv.second);
    leases_.replace(std::move(entries));
}

}  // namespace ap
