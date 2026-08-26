#include "hook/hook.hpp"
#include "hook/protocol.hpp"

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

// Overflow defense only, not a plausibility check on any one field: this cap
// has to clear the largest value we legitimately parse, which is
// lost_ms_ago riding a 30-minute window (1,800,000ms). Kept well above that
// so raising the window doesn't silently reintroduce the saturation bug.
// See HandoverNoteMs in go/internal/leases/leases.go.
constexpr long long kIntFieldCeiling = 10000000;  // ~2.8 hours in ms

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
        // Saturate well clear of overflow, not against what a well-behaved
        // sender would send. lost_ms_ago rides this field up to
        // leases.go's HandoverNoteMs (30 minutes); if that grows, raise this too.
        if (v > kIntFieldCeiling) v = kIntFieldCeiling;
        ++pos;
    }
    return static_cast<int>(negative ? -v : v);
}

/// True only for a bare `true` value on `key`. A quoted "true" does not count,
/// same reasoning as int_field rejecting a quoted "3": a daemon sending the
/// wrong type is not one we guess on behalf of. The match also has to end
/// where the token ends, or "truest" would read as true.
bool bool_field(std::string_view json, std::string_view key) {
    std::string needle = "\"";
    needle += key;
    needle += "\":";
    auto pos = json.find(needle);
    if (pos == std::string_view::npos) return false;
    pos += needle.size();
    while (pos < json.size() && (json[pos] == ' ' || json[pos] == '\t')) ++pos;
    if (json.substr(pos, 4) != "true") return false;
    pos += 4;
    return pos >= json.size() || json[pos] == ',' || json[pos] == '}' || json[pos] == ' ' ||
           json[pos] == '\t';
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

/// What a daemon that has never heard of effects meant by a rung.
///
/// It is still on the wire and it still ships: `decision` is the only field an
/// older daemon sets, and dropping this would turn every `ask` such a daemon
/// can express into the `deny` it did not ask for.
Effect legacy_effect(int rung, const std::string& decision) {
    if (rung <= 0) return Effect::Silent;
    if (rung < 3) return Effect::Context;  // what "additionalContext for 1..2" was
    return decision == "ask" ? Effect::Ask : Effect::Deny;
}

/// Whatever we can call the holder without lying.
std::string holder_name(const Decision& d) {
    if (!d.human.empty()) return d.human;
    if (!d.holder.empty()) return d.holder;
    return "another agent";
}

/// The holder's tier, when it is one worth telling the agent about.
///
/// An allowlist of exactly the two names above `normal`, for two reasons.
/// Rendering `normal` or `background` would spend an agent's attention saying
/// the holder is ordinary, which is the default and therefore not news. And the
/// string arrives over a socket anything on this box can write to and ends up in
/// prose a model reads, so the set of things that can appear there is fixed here
/// rather than escaped and passed through.
///
/// Deliberately a fact about the holder and not a comparison. The daemon knows
/// what tier the lease was taken at; it does not know the reader's, so
/// "they outrank you" is a sentence this code is not in a position to write.
std::string tier_note(const Decision& d) {
    if (d.holder_priority == "elevated") return " (elevated priority)";
    if (d.holder_priority == "critical") return " (critical priority)";
    return {};
}

/// The same allowlist for any other tier we render. See tier_note.
std::string tier_of(const std::string& priority) {
    if (priority == "elevated") return " (elevated priority)";
    if (priority == "critical") return " (critical priority)";
    return {};
}

/// A duration a model can act on. Seconds under two minutes, then whole
/// minutes: "in 47 seconds" is a thing to wait out, "in 14 minutes" is a thing
/// to work around, and "in 863 seconds" is neither.
std::string humanise_ms(long long ms) {
    if (ms < 0) return {};
    const long long seconds = (ms + 999) / 1000;  // round up; never "0 seconds"
    if (seconds < 120) {
        return std::to_string(seconds < 1 ? 1 : seconds) +
               (seconds == 1 ? " second" : " seconds");
    }
    const long long minutes = (seconds + 59) / 60;
    return std::to_string(minutes) + (minutes == 1 ? " minute" : " minutes");
}

void append_field(std::string& out, const char* key, const std::string& value) {
    out += '"';
    out += key;
    out += "\":\"";
    append_json_string(out, value);
    out += '"';
}

/// True for a variable that actually has a value. `std::getenv` returns
/// non-null for `FOO=""`, and that used to read as "set" here while every
/// other reader in the repo — presenced's envOr, the statusline segment's
/// `${VAR:-fallback}` — falls through on an empty value. This is that same
/// rule, applied at the one holdout.
bool env_set(const char* v) { return v != nullptr && v[0] != '\0'; }

std::string join_path(std::string dir, const char* leaf) {
    if (!dir.empty() && dir.back() == '/') dir.pop_back();
    dir += '/';
    dir += leaf;
    return dir;
}

}  // namespace

std::string resolve_sock_path(EnvLookup lookup) {
    const char* sock = lookup("AGENT_PRESENCE_SOCK");
    if (env_set(sock)) return sock;
    const char* rt = lookup("XDG_RUNTIME_DIR");
    if (env_set(rt)) return join_path(rt, "agent-presence.sock");
    const char* tmp = lookup("TMPDIR");
    if (env_set(tmp)) return join_path(tmp, "agent-presence.sock");
    return "/tmp/agent-presence.sock";
}

// path_of is the edited file, whichever key the tool spells it under.
//
// NotebookEdit is registered in install.sh's PreToolUse matcher and
// verb_for classifies it as an edit, so it is meant to take part in
// arbitration like any other edit — but it carries its path as
// notebook_path, not file_path. Reading only file_path meant every
// notebook edit went out with path "": decide's empty-path early return
// means two agents editing the same notebook were silently allowed
// through, the presence table folded every agent's notebook activity into
// one shared empty region, and any message about it said "this file"
// naming nothing.
//
// Grep and Glob spell theirs "path", and verb_for calls them "search".
// install.sh registers both in the PostToolUse matcher, so they do reach
// here, and reading only file_path meant every search went out with path
// "". That costs twice: presence.Touch overwrites the agent's tracked
// location with the empty string the moment it runs a search, so peers
// lose its "editing X" while it is still mid-edit elsewhere; and
// EventFrame drops any event with an empty path, so no search reaches the
// relay or the room at all.
//
// Tool-agnostic rather than a per-tool table: field() is a flat scan with
// no notion of nesting, so each fallback costs one extra pass only when
// the earlier key is absent, and there is no list to keep in sync as
// tools come and go.
std::string path_of(const std::string& hook_json) {
    std::string p = field(hook_json, "file_path");
    if (p.empty()) p = field(hook_json, "notebook_path");
    if (p.empty()) p = field(hook_json, "path");
    return p;
}

std::string build_event(const std::string& hook_json) {
    const std::string tool = field(hook_json, "tool_name");
    const std::string path = path_of(hook_json);
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

Decision request_decision(const std::string& sock_path, const std::string& line, int timeout_ms,
                          bool* connected) {
    // Every early return is the same answer: no decision, therefore allow.
    const SigPipeGuard no_sigpipe;
    const auto start = std::chrono::steady_clock::now();
    if (connected != nullptr) *connected = false;

    const int fd = open_conn(sock_path, start, timeout_ms);
    if (fd < 0) return {};
    if (connected != nullptr) *connected = true;

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
    d.effect = field(line, "effect");
    d.decision = field(line, "decision");
    d.holder = field(line, "holder");
    d.human = field(line, "human");
    d.intent = field(line, "intent");
    d.holder_priority = field(line, "holder_priority");
    d.expires_in_ms = int_field(line, "expires_in_ms", -1);
    d.handover_in_ms = int_field(line, "handover_in_ms", -1);
    d.handover_to = field(line, "handover_to");
    d.handover_to_human = field(line, "handover_to_human");
    d.handover_to_priority = field(line, "handover_to_priority");
    d.handover_to_me = bool_field(line, "handover_to_me");
    d.waiting = int_field(line, "waiting", 0);
    d.lost_to = field(line, "lost_to");
    d.lost_to_priority = field(line, "lost_to_priority");
    d.lost_ms_ago = int_field(line, "lost_ms_ago", -1);
    return d;
}

namespace {

/// What a blocked agent is told, and it is read by a model, so every sentence
/// is either a fact or an instruction and there is nothing else in it.
///
/// Four things, in this order, because that is the order the reader needs them:
/// who is in the way and what they are doing; when the region frees up; whether
/// it is coming to this agent or to somebody else; what to do in the meantime.
///
/// The "when" used to be the fixed string "their claim expires on its own
/// within 90 seconds". It was false for every holder that was still working —
/// a claim frame reset the lease to a fresh 90 seconds and presenced sends one
/// every 30 — so the one number in the message was wrong precisely when the
/// message mattered. It is now the real remaining time off the lease table.
std::string blocked_message(const Decision& d, const std::string& where) {
    std::string m = holder_name(d) + tier_note(d);
    m += " is editing ";
    m += where;
    m += " right now, in the same region you are about to change";
    if (!d.intent.empty()) {
        m += ": \"";
        m += d.intent;
        m += "\"";
    }
    m += ". This edit is blocked by agent presence so the two of you do not overwrite each "
         "other.";

    if (!d.lost_to.empty()) {
        // The block and the loss are one event. Told only the first, the agent
        // is reading "somebody else is editing this" about a region that was
        // its own a minute ago, which is the moment the whole thing stops
        // making sense from the inside.
        m += " This was your region: it passed to them";
        if (d.lost_ms_ago > 0) {
            m += " ";
            m += humanise_ms(d.lost_ms_ago);
            m += " ago";
        }
        m += " when your lease reached the deadline you were given. Nothing you had already "
             "written was reverted.";
    }

    // The daemon's word first. Its `handover_to` is a relay agent id and
    // `d.agent` is a Claude Code session id, so the comparison below is only
    // ever true when somebody has set AGENT_PRESENCE_AGENT to the session id by
    // hand. Kept anyway: a daemon from before the flag existed sends no flag.
    const bool queued_for_me =
        d.handover_to_me || (!d.handover_to.empty() && d.handover_to == d.agent);
    if (d.handover_in_ms >= 0 && queued_for_me) {
        m += " Their lease stops being renewable in ";
        m += humanise_ms(d.handover_in_ms);
        m += ", and the region is then held for you";
        if (d.waiting > 1) {
            m += " ahead of the ";
            m += std::to_string(d.waiting - 1);
            m += " other agent";
            m += d.waiting - 1 == 1 ? "" : "s";
            m += " waiting";
        }
        m += ". Retry this edit once, then; do not poll. Or, before that: take a disjoint part "
             "of the file, hand your requirement to them, or say plainly why your change is "
             "independent and proceed anyway.";
        return m;  // the wait is already answered; do not repeat it below
    }
    if (d.handover_in_ms >= 0 && !d.handover_to.empty()) {
        m += " The region is queued for ";
        m += d.handover_to_human.empty() ? d.handover_to : d.handover_to_human;
        m += tier_of(d.handover_to_priority);
        m += " in ";
        m += humanise_ms(d.handover_in_ms);
        m += ", not for you.";
    } else if (d.expires_in_ms >= 0) {
        m += " Their lease runs out in ";
        m += humanise_ms(d.expires_in_ms);
        m += " unless they renew it.";
    }

    m += " Do one of these instead: wait and retry, take a disjoint part of the file, hand "
         "your requirement to them, or say plainly why your change is independent and proceed "
         "anyway.";
    return m;
}

/// A holder being told its own lease has a deadline, while it still holds the
/// region. This is the only warning it gets and there is no push channel, so it
/// arrives on its next edit — which is exactly when it is working in the region
/// and can still do something about it.
std::string handover_warning(const Decision& d, const std::string& where) {
    std::string m = "You are about to hand ";
    m += where;
    m += " to ";
    m += d.handover_to_human.empty() ? d.handover_to : d.handover_to_human;
    m += tier_of(d.handover_to_priority);
    m += " in ";
    m += humanise_ms(d.handover_in_ms);
    m += ": they asked for this region and your lease stops being renewable then. Nothing is "
         "blocked yet. Finish what you are in the middle of and commit it, or stop at a clean "
         "point — after that they hold the region and your edits to it will be refused.";
    return m;
}

/// And the same agent, after it lost the region. Without this the loss is
/// unreadable from the inside: the lease is gone, the next edit is refused by a
/// stranger, and nothing connects the two events or says what to do with work
/// already sitting in the file.
std::string lost_message(const Decision& d, const std::string& where) {
    std::string m = d.lost_to + tier_of(d.lost_to_priority);
    m += " took over ";
    m += where;
    if (d.lost_ms_ago > 0) {
        m += " ";
        m += humanise_ms(d.lost_ms_ago);
        m += " ago";
    }
    m += ", because they asked for it and your lease reached the deadline you were given. "
         "Nothing you had already written was reverted. Keep any unfinished work on that "
         "region out of the file — a branch, a scratch note, or hand the requirement to them "
         "— and do not re-claim it until they release it.";
    return m;
}

std::string near_message(const Decision& d, const std::string& where) {
    std::string m = holder_name(d) + tier_note(d);
    m += " is editing ";
    m += where;
    m += " right now";
    if (!d.intent.empty()) {
        m += ": \"";
        m += d.intent;
        m += "\"";
    }
    m += ". Nothing is blocked. Keep your change to a part of the file they are not in, and "
         "avoid reformatting or moving code around them.";
    return m;
}

/// Nobody is in the region and the room still wants this edit stopped. That is
/// a configuration, so say it is one: inventing a holder to blame would send a
/// model looking for an agent that is not there.
std::string policy_message(const std::string& where, Effect e) {
    std::string m = "Agent presence ";
    m += e == Effect::Deny ? "blocks" : "asks before allowing";
    m += " edits to ";
    m += where;
    m += " at this rung. Nobody else holds this region — this is the room's effect table, "
         "not a collision. `ap policy explain` names the layer that set it.";
    return m;
}

std::string context_output(const std::string& message) {
    std::string out = "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",";
    append_field(out, "additionalContext", message);
    out += "}}";
    return out;
}

std::string permission_output(const char* decision, const std::string& message) {
    std::string out = "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",";
    append_field(out, "permissionDecision", decision);
    out += ',';
    append_field(out, "permissionDecisionReason", message);
    out += "}}";
    return out;
}

}  // namespace

Effect effect_of(const Decision& d) {
    const Effect said = parse_effect(d.effect).value_or(legacy_effect(d.rung, d.decision));
    const int rung = d.rung < 0 ? 0 : (d.rung >= 5 ? 4 : d.rung);
    return louder(said, kHookFloor[rung]);
}

std::string hook_output(const Decision& d, const std::string& path) {
    // No answer at all is allow, and says nothing.
    if (d.rung < 0) return {};

    const std::string where = path.empty() ? "this file" : path;
    const Effect e = effect_of(d);

    // Two questions, and they used to be one. *What* to say is decided by what
    // happened: who is in the region, whether this agent is about to lose one,
    // whether it already has. *Whether and how loudly* to say it is the effect's
    // and only the effect's. Keying the output off the rung instead is what made
    // every `[effects]` table on the machine decorative.
    std::string message;
    // The two things that are about this agent's own lease rather than about
    // the room. They are the daemon telling one agent what happened to a region
    // it holds, there is no other channel for them, and no effect table is
    // asking to suppress them.
    bool own_region = false;

    if (d.rung == 0 && d.handover_in_ms >= 0 && !d.handover_to.empty()) {
        message = handover_warning(d, where);
        own_region = true;
    } else if (d.rung == 0 && !d.lost_to.empty()) {
        message = lost_message(d, where);
        own_region = true;
    } else if (d.rung > 0 || !d.holder.empty()) {
        // Any rung above 0 is somebody else in the region, named or not.
        // Whether that is worth stopping for is the effect's call; who they are
        // and what they are doing is the same either way.
        message = e >= Effect::Ask ? blocked_message(d, where) : near_message(d, where);
    } else {
        message = policy_message(where, e);
    }

    switch (e) {
        case Effect::Silent:
        case Effect::Notify:
            // Nothing on the hook for either — `notify` reaches a human through
            // the statusline and the peer list, which is the surface it is
            // named for. See docs/policy-design.md §1.
            return own_region ? context_output(message) : std::string{};
        case Effect::Context:
            return context_output(message);
        case Effect::Ask:
            return permission_output("ask", message);
        case Effect::Deny:
            return permission_output("deny", message);
    }
    return {};
}

std::string run_hook(const std::string& hook_json, const std::string& sock_path, int budget_ms) {
    if (!wants_decision(hook_json)) {
        // One way, and onto the event socket, which is the one that is allowed
        // to be busy. Nothing is waiting on this.
        write_line(sock_path, build_event(hook_json), budget_ms);
        return {};
    }

    const std::string request = build_request(hook_json);
    const auto start = std::chrono::steady_clock::now();

    // Decisions go to the decision socket. It exists so that a request cannot
    // end up behind a burst of events in one accept queue, wait out its budget
    // and allow an edit with nothing said — see hook/protocol.hpp.
    bool connected = false;
    Decision d = request_decision(decision_sock_path(sock_path), request, budget_ms, &connected);

    if (!connected) {
        // Nothing on that path: an older daemon, or a socket file left behind
        // by one that died. Both answer on the event socket, so ask there with
        // what is left of the budget. A refused connect to a unix socket comes
        // back at once, so in practice that is nearly all of it.
        const int left = remaining_ms(start, budget_ms);
        if (left > 0) d = request_decision(sock_path, request, left);
    }
    // Filled in from our own payload, never from the socket. The daemon has no
    // business telling us who we are, and the hook needs it to tell "the region
    // is queued for you" from "somebody is ahead of you".
    d.agent = field(hook_json, "session_id");
    return hook_output(d, path_of(hook_json));
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
