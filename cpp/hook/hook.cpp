#include "hook/hook.hpp"

#include <fcntl.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#include <algorithm>
#include <cerrno>
#include <chrono>
#include <cstddef>
#include <cstdio>
#include <string>
#include <string_view>

namespace ap {
namespace {

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

/// Four hex digits at `pos`, or false.
bool hex4(std::string_view s, size_t pos, unsigned& out) {
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

/// Minimal scalar extractor. A full JSON parser is deliberately avoided: this
/// binary runs before every tool call and its cost must be near zero. String
/// escapes are still decoded, because a path can legally contain a quote, a
/// backslash or a newline and stopping at the first bare '"' would truncate it.
std::string field(std::string_view json, std::string_view key) {
    std::string needle = "\"";
    needle += key;
    needle += "\":\"";
    auto pos = json.find(needle);
    if (pos == std::string_view::npos) return {};
    pos += needle.size();

    std::string out;
    while (pos < json.size()) {
        const char c = json[pos];
        if (c == '"') return out;
        if (c != '\\') {
            out += c;
            ++pos;
            continue;
        }
        if (pos + 1 >= json.size()) break;  // truncated payload
        const char e = json[pos + 1];
        pos += 2;
        switch (e) {
            case 'n': out += '\n'; break;
            case 't': out += '\t'; break;
            case 'r': out += '\r'; break;
            case 'b': out += '\b'; break;
            case 'f': out += '\f'; break;
            case 'u': {
                unsigned cp = 0;
                if (!hex4(json, pos, cp)) return {};
                pos += 4;
                if (cp >= 0xD800 && cp <= 0xDBFF) {  // surrogate pair
                    unsigned lo = 0;
                    if (pos + 6 <= json.size() && json[pos] == '\\' && json[pos + 1] == 'u' &&
                        hex4(json, pos + 2, lo) && lo >= 0xDC00 && lo <= 0xDFFF) {
                        cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                        pos += 6;
                    } else {
                        cp = 0xFFFD;  // lone high surrogate
                    }
                } else if (cp >= 0xDC00 && cp <= 0xDFFF) {
                    cp = 0xFFFD;  // lone low surrogate
                }
                append_utf8(out, cp);
                break;
            }
            default: out += e; break;  // covers \" \\ \/ and anything odd
        }
    }
    return {};  // unterminated string: no value worth sending
}

/// Append `v` as the body of a JSON string. Without this a path holding a quote
/// or a backslash produces malformed JSON, and the relay drops the line without
/// telling anyone.
void append_json_string(std::string& out, const std::string& v) {
    for (const char raw : v) {
        const unsigned char c = static_cast<unsigned char>(raw);
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\t': out += "\\t"; break;
            case '\r': out += "\\r"; break;
            case '\b': out += "\\b"; break;
            case '\f': out += "\\f"; break;
            default:
                if (c < 0x20) {
                    char buf[7];
                    std::snprintf(buf, sizeof(buf), "\\u%04x", c);
                    out += buf;
                } else {
                    out += raw;
                }
        }
    }
}

std::string verb_for(const std::string& tool) {
    if (tool == "Edit" || tool == "Write" || tool == "NotebookEdit") return "edit";
    if (tool == "Read") return "read";
    if (tool == "Grep" || tool == "Glob") return "search";
    if (tool == "Bash") return "run";
    return "think";
}

/// Milliseconds left of the budget, floored at zero.
int remaining_ms(std::chrono::steady_clock::time_point start, int budget_ms) {
    const auto spent = std::chrono::duration_cast<std::chrono::milliseconds>(
                           std::chrono::steady_clock::now() - start)
                           .count();
    const long left = static_cast<long>(budget_ms) - static_cast<long>(spent);
    return left > 0 ? static_cast<int>(left) : 0;
}

}  // namespace

std::string build_event(const std::string& hook_json) {
    const std::string tool = field(hook_json, "tool_name");
    const std::string path = field(hook_json, "file_path");
    const std::string session = field(hook_json, "session_id");

    std::string out = "{\"verb\":\"";
    append_json_string(out, verb_for(tool));
    out += "\",\"agent\":\"";
    append_json_string(out, session);
    out += "\",\"path\":\"";
    append_json_string(out, path);
    out += "\"}";
    return out;
}

bool write_line(const std::string& sock_path, const std::string& line, int timeout_ms) {
    if (sock_path.empty() || sock_path.size() >= sizeof(sockaddr_un::sun_path)) return false;

    const auto start = std::chrono::steady_clock::now();

    int fd = ::socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return false;
    ::fcntl(fd, F_SETFL, ::fcntl(fd, F_GETFL, 0) | O_NONBLOCK);

    sockaddr_un addr{};
    addr.sun_family = AF_UNIX;
    std::snprintf(addr.sun_path, sizeof(addr.sun_path), "%s", sock_path.c_str());

    // Non-blocking connect. If the daemon is absent we abandon the event rather
    // than delay the agent. A dropped event costs one animation frame; a blocked
    // hook costs the user's patience on every tool call.
    if (::connect(fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0) {
        // A full listen backlog is the one case worth a bounded wait.
        if (errno != EINPROGRESS && errno != EAGAIN) {
            ::close(fd);
            return false;
        }
        pollfd pfd{fd, POLLOUT, 0};
        if (::poll(&pfd, 1, remaining_ms(start, timeout_ms)) != 1 || (pfd.revents & POLLOUT) == 0) {
            ::close(fd);
            return false;
        }
        int err = 0;
        socklen_t len = sizeof(err);
        if (::getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &len) != 0 || err != 0) {
            ::close(fd);
            return false;
        }
    }

    std::string payload = line;
    payload.push_back('\n');

    size_t sent = 0;
    while (sent < payload.size()) {
        ssize_t n = ::write(fd, payload.data() + sent, payload.size() - sent);
        if (n > 0) {
            sent += static_cast<size_t>(n);
            continue;
        }
        if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
            const int left = remaining_ms(start, timeout_ms);
            if (left == 0) break;
            pollfd pfd{fd, POLLOUT, 0};
            if (::poll(&pfd, 1, left) != 1 || (pfd.revents & POLLOUT) == 0) break;
            continue;
        }
        break;  // EPIPE and friends: drop the event, never signal the agent.
    }

    ::close(fd);
    return sent == payload.size();
}

std::string read_bounded(int fd, std::size_t max_buffer, int timeout_ms) {
    const auto start = std::chrono::steady_clock::now();

    std::string out;
    char buf[65536];

    // poll() before every read so a blocking stdin never parks us. Setting
    // O_NONBLOCK is avoided on purpose: fd 0's flags live on a file description
    // the parent may still share, and a hook has no business mutating it.
    for (;;) {
        const int left = remaining_ms(start, timeout_ms);
        if (left == 0) break;

        pollfd pfd{fd, POLLIN, 0};
        const int r = ::poll(&pfd, 1, left);
        if (r < 0) {
            if (errno == EINTR) continue;
            break;
        }
        if (r == 0) break;  // out of budget

        // POLLNVAL is treated as fatal even though it costs us one exotic case:
        // on macOS poll() reports it for a character device (stdin redirected
        // from /dev/zero, say) that read() would happily serve, so the payload
        // is dropped. Reading anyway would mean a blocking read on an fd poll
        // just said it cannot vouch for, and the deadline is only enforceable
        // because every read here is one poll() already cleared. Claude Code
        // hands a hook a pipe, and pipes and regular files both report POLLIN
        // correctly; losing an event on a device beats risking a stuck one.
        if ((pfd.revents & (POLLERR | POLLNVAL)) != 0) break;

        const ssize_t n = ::read(fd, buf, sizeof(buf));
        if (n > 0) {
            if (out.size() < max_buffer) {
                out.append(buf, std::min(static_cast<std::size_t>(n), max_buffer - out.size()));
            }
            continue;  // past the cap the bytes are dropped, not the read
        }
        if (n == 0) break;  // EOF: the parent said everything it had
        if (errno == EINTR) continue;
        break;
    }

    return out;
}

}  // namespace ap
