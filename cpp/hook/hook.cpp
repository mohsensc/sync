#include "hook/hook.hpp"

#include <fcntl.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
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

// A response is one short line. Anything on this machine can write to that
// socket, so the reply is capped rather than trusted to end.
constexpr size_t kMaxReply = 8192;

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
    if (tool == "Edit" || tool == "Write" || tool == "MultiEdit" || tool == "NotebookEdit") {
        return "edit";
    }
    if (tool == "Read") return "read";
    if (tool == "Grep" || tool == "Glob") return "search";
    if (tool == "Bash") return "run";
    return "think";
}

/// Integer scalar, or `missing` when the key is absent or not a bare number.
/// A quoted "3" is rejected on purpose: a daemon that sends the wrong type is a
/// daemon we should not be guessing on behalf of.
int int_field(std::string_view json, std::string_view key, int missing) {
    std::string needle = "\"";
    needle += key;
    needle += "\":";
    auto pos = json.find(needle);
    if (pos == std::string_view::npos) return missing;
    pos += needle.size();
    while (pos < json.size() && (json[pos] == ' ' || json[pos] == '\t')) ++pos;

    bool negative = false;
    if (pos < json.size() && (json[pos] == '-' || json[pos] == '+')) {
        negative = json[pos] == '-';
        ++pos;
    }
    if (pos >= json.size() || json[pos] < '0' || json[pos] > '9') return missing;

    long long v = 0;
    while (pos < json.size() && json[pos] >= '0' && json[pos] <= '9') {
        v = v * 10 + (json[pos] - '0');
        if (v > 1000000) v = 1000000;  // saturate; nothing sane is this big
        ++pos;
    }
    return static_cast<int>(negative ? -v : v);
}

/// Blocks SIGPIPE on this thread for as long as it lives, and swallows one if
/// the socket work generated it.
///
/// SO_NOSIGPIPE and MSG_NOSIGNAL cover send(); they are set below and they are
/// not enough on their own, because a library has no business depending on
/// which syscall the kernel picked or on the signal disposition its caller
/// happened to install. The default disposition for SIGPIPE is death, and a
/// hook that dies fails the tool call it exists to be invisible to.
class SigPipeGuard {
public:
    SigPipeGuard() {
        sigset_t pipe_only;
        sigemptyset(&pipe_only);
        sigaddset(&pipe_only, SIGPIPE);
        armed_ = ::pthread_sigmask(SIG_BLOCK, &pipe_only, &old_) == 0;
    }

    ~SigPipeGuard() {
        if (!armed_) return;
        // If the caller was already blocking SIGPIPE, a pending one may well be
        // theirs and eating it would be theft. Only clean up after ourselves.
        if (!sigismember(&old_, SIGPIPE)) {
            sigset_t pending;
            if (::sigpending(&pending) == 0 && sigismember(&pending, SIGPIPE)) {
                sigset_t pipe_only;
                sigemptyset(&pipe_only);
                sigaddset(&pipe_only, SIGPIPE);
                int sig = 0;
                // Returns immediately: SIGPIPE is generated synchronously by the
                // offending thread, so a pending one is pending on this thread
                // and no other thread can take it first. (sigtimedwait would say
                // that outright, but Darwin does not have it.)
                ::sigwait(&pipe_only, &sig);
            }
        }
        ::pthread_sigmask(SIG_SETMASK, &old_, nullptr);
    }

    SigPipeGuard(const SigPipeGuard&) = delete;
    SigPipeGuard& operator=(const SigPipeGuard&) = delete;

private:
    sigset_t old_{};
    bool armed_ = false;
};

/// Milliseconds left of the budget, floored at zero.
int remaining_ms(std::chrono::steady_clock::time_point start, int budget_ms) {
    const auto spent = std::chrono::duration_cast<std::chrono::milliseconds>(
                           std::chrono::steady_clock::now() - start)
                           .count();
    const long left = static_cast<long>(budget_ms) - static_cast<long>(spent);
    return left > 0 ? static_cast<int>(left) : 0;
}

/// Connected non-blocking socket, or -1. Never waits past the deadline.
int open_conn(const std::string& sock_path, std::chrono::steady_clock::time_point start,
              int timeout_ms) {
    if (sock_path.empty() || sock_path.size() >= sizeof(sockaddr_un::sun_path)) return -1;

    int fd = ::socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return -1;
    ::fcntl(fd, F_SETFL, ::fcntl(fd, F_GETFL, 0) | O_NONBLOCK);

#ifdef SO_NOSIGPIPE
    // A daemon that hangs up mid-write otherwise kills this process outright,
    // and a hook that dies takes the tool call with it. Linux gets the same
    // protection from MSG_NOSIGNAL on the send below.
    const int on = 1;
    ::setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, sizeof(on));
#endif

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
            return -1;
        }
        pollfd pfd{fd, POLLOUT, 0};
        if (::poll(&pfd, 1, remaining_ms(start, timeout_ms)) != 1 || (pfd.revents & POLLOUT) == 0) {
            ::close(fd);
            return -1;
        }
        int err = 0;
        socklen_t len = sizeof(err);
        if (::getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &len) != 0 || err != 0) {
            ::close(fd);
            return -1;
        }
    }
    return fd;
}

/// Write `payload` whole, or give up. Returns bytes delivered.
size_t send_all(int fd, const std::string& payload, std::chrono::steady_clock::time_point start,
                int timeout_ms) {
#ifdef MSG_NOSIGNAL
    constexpr int kSendFlags = MSG_NOSIGNAL;
#else
    constexpr int kSendFlags = 0;
#endif

    size_t sent = 0;
    while (sent < payload.size()) {
        ssize_t n = ::send(fd, payload.data() + sent, payload.size() - sent, kSendFlags);
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
        if (n < 0 && errno == EINTR) continue;
        break;  // EPIPE and friends: drop the event, never signal the agent.
    }
    return sent;
}

/// One newline-terminated line off `fd`, or empty. Bounded by the deadline and
/// by `max_bytes`, because the daemon is not the only thing that can write to
/// this socket and a response is a short line or it is nothing.
std::string read_line(int fd, std::chrono::steady_clock::time_point start, int timeout_ms,
                      size_t max_bytes) {
    std::string buf;
    char chunk[4096];

    for (;;) {
        const auto nl = buf.find('\n');
        if (nl != std::string::npos) return buf.substr(0, nl);
        if (buf.size() >= max_bytes) return {};

        const int left = remaining_ms(start, timeout_ms);
        if (left == 0) return {};

        pollfd pfd{fd, POLLIN, 0};
        const int r = ::poll(&pfd, 1, left);
        if (r < 0) {
            if (errno == EINTR) continue;
            return {};
        }
        if (r == 0) return {};  // out of budget
        if ((pfd.revents & (POLLERR | POLLNVAL)) != 0) return {};

        const ssize_t n = ::read(fd, chunk, sizeof(chunk));
        if (n > 0) {
            buf.append(chunk, static_cast<size_t>(n));
            continue;
        }
        if (n == 0) return {};  // EOF with no line: the daemon had nothing to say
        if (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK) continue;
        return {};
    }
}

/// Rung 3 is the only rung that spends the agent's attention, so it is the only
/// one allowed to name a permission decision.
bool blocks_at(int rung) { return rung >= 3; }

/// Whatever we can call the holder without lying.
std::string holder_name(const Decision& d) {
    if (!d.human.empty()) return d.human;
    if (!d.holder.empty()) return d.holder;
    return "another agent";
}

void append_field(std::string& out, const char* key, const std::string& value) {
    out += '"';
    out += key;
    out += "\":\"";
    append_json_string(out, value);
    out += '"';
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
    const SigPipeGuard no_sigpipe;
    const auto start = std::chrono::steady_clock::now();

    const int fd = open_conn(sock_path, start, timeout_ms);
    if (fd < 0) return false;

    std::string payload = line;
    payload.push_back('\n');
    const size_t sent = send_all(fd, payload, start, timeout_ms);

    ::close(fd);
    return sent == payload.size();
}

Decision request_decision(const std::string& sock_path, const std::string& line, int timeout_ms) {
    // Every early return is the same answer: no decision, therefore allow.
    const SigPipeGuard no_sigpipe;
    const auto start = std::chrono::steady_clock::now();

    const int fd = open_conn(sock_path, start, timeout_ms);
    if (fd < 0) return {};

    std::string payload = line;
    payload.push_back('\n');
    if (send_all(fd, payload, start, timeout_ms) != payload.size()) {
        ::close(fd);
        return {};
    }

    // Half close. A daemon that only drains lines now sees a clean EOF and
    // hangs up, so the hook finds out in microseconds that no answer is coming
    // instead of sitting out the whole budget. A daemon that does answer can
    // still write: only our write side is gone.
    ::shutdown(fd, SHUT_WR);

    const std::string reply = read_line(fd, start, timeout_ms, kMaxReply);
    ::close(fd);
    return parse_decision(reply);
}

bool wants_decision(const std::string& hook_json) {
    // PostToolUse cannot carry a permission decision, and a payload that does
    // not say which event it is gets the benefit of the doubt in the direction
    // that cannot break anything.
    if (field(hook_json, "hook_event_name") != "PreToolUse") return false;
    return verb_for(field(hook_json, "tool_name")) == "edit";
}

std::string build_request(const std::string& hook_json) {
    std::string out = build_event(hook_json);
    if (out.size() < 2 || out.back() != '}') return out;
    out.pop_back();
    out += ",\"want\":\"decision\"}";
    return out;
}

Decision parse_decision(const std::string& line) {
    Decision d;
    if (line.empty()) return d;
    d.rung = int_field(line, "rung", -1);
    if (d.rung < 0) return d;  // no rung, no answer; the rest is not worth reading
    d.decision = field(line, "decision");
    d.holder = field(line, "holder");
    d.human = field(line, "human");
    d.intent = field(line, "intent");
    return d;
}

std::string hook_output(const Decision& d, const std::string& path) {
    // No answer, and rung 0 — both agents merely present in the same file — are
    // the world's business, not the agent's. Silence is what allow looks like.
    if (d.rung <= 0) return {};

    const std::string who = holder_name(d);
    const std::string where = path.empty() ? "this file" : path;

    std::string message;
    if (blocks_at(d.rung)) {
        message = who;
        message += " is editing ";
        message += where;
        message += " right now, in the same region you are about to change";
        if (!d.intent.empty()) {
            message += ": \"";
            message += d.intent;
            message += "\"";
        }
        message +=
            ". This edit is blocked by agent presence so the two of you do not overwrite each "
            "other. Their claim expires on its own within 90 seconds. Wait for it, take a "
            "disjoint part of the file, hand your requirement to them, or say plainly why your "
            "change is independent and proceed anyway.";
    } else {
        message = who;
        message += " is editing ";
        message += where;
        message += " right now";
        if (!d.intent.empty()) {
            message += ": \"";
            message += d.intent;
            message += "\"";
        }
        message +=
            ". Nothing is blocked. Keep your change to a part of the file they are not in, and "
            "avoid reformatting or moving code around them.";
    }

    std::string out = "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",";
    if (blocks_at(d.rung)) {
        // A daemon may soften a block into a prompt. It may not talk us out of
        // one: anything on this machine can write to that socket.
        append_field(out, "permissionDecision", d.decision == "ask" ? "ask" : "deny");
        out += ',';
        append_field(out, "permissionDecisionReason", message);
    } else {
        append_field(out, "additionalContext", message);
    }
    out += "}}";
    return out;
}

std::string run_hook(const std::string& hook_json, const std::string& sock_path, int budget_ms) {
    if (!wants_decision(hook_json)) {
        write_line(sock_path, build_event(hook_json), budget_ms);
        return {};
    }
    const Decision d = request_decision(sock_path, build_request(hook_json), budget_ms);
    return hook_output(d, field(hook_json, "file_path"));
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
