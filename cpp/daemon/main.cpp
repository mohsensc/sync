#include <chrono>
#include <cstdlib>
#include <string>
#include <string_view>
#include <utility>

#include "daemon/coalesce.hpp"
#include "daemon/outbound.hpp"
#include "daemon/snapshot.hpp"
#include "daemon/socket_server.hpp"

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

}  // namespace

/// Same shape as the hook's extractor, escapes included. Scanning for the next
/// bare '"' is what this used to do, and it quietly truncated every path with a
/// quote in it: the hook wrote valid JSON, the daemon read half of it, and the
/// event went nowhere with nothing logged. Decoding here is what makes the path
/// on this side byte-identical to the path the hook was handed.
std::string json_field(std::string_view json, std::string_view key) {
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
    return {};  // unterminated string: no value worth trusting
}

}  // namespace ap

namespace {

// How long an agent stays on the statusline after its last event, and how often
// the snapshot is rewritten even when nothing changed. The periodic rewrite is
// what turns a fresh mtime into proof the daemon is alive.
constexpr long long kPresenceTtlMs = 30000;
constexpr long long kSnapshotTickMs = 1000;

long long now_ms() {
    using namespace std::chrono;
    return duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
}

std::string env_or(const char* key, const std::string& fallback) {
    const char* v = std::getenv(key);
    return v ? std::string(v) : fallback;
}

}  // namespace

#ifndef AP_DAEMON_NO_MAIN
int main() {
    const std::string runtime = env_or("XDG_RUNTIME_DIR", env_or("TMPDIR", "/tmp"));
    const std::string sock = env_or("AGENT_PRESENCE_SOCK", runtime + "/agent-presence.sock");
    const std::string snap = env_or("AGENT_PRESENCE_SNAPSHOT", runtime + "/agent-presence.json");

    ap::SocketServer server(sock);
    ap::Coalescer coalescer(1000, 200);
    ap::Outbound outbound(1000);
    ap::PresenceTable presence(kPresenceTtlMs);

    bool dirty = false;

    server.on_line([&](std::string line) {
        const std::string verb = ap::json_field(line, "verb");
        const std::string path = ap::json_field(line, "path");
        const std::string agent = ap::json_field(line, "agent");
        if (agent.empty()) return;

        // The hook has no name for the person driving; fall back to the session
        // id so the statusline still counts a body in the room.
        std::string human = ap::json_field(line, "human");
        if (human.empty()) human = agent;

        // Presence is local and cheap, so it tracks every event. Only the relay
        // traffic is worth coalescing.
        if (presence.touch(agent, human, verb, path, now_ms())) dirty = true;

        // The daemon makes no protocol decisions. It coalesces and forwards.
        ap::Ev e{verb, path, agent};
        if (!coalescer.admit(e, now_ms())) return;
        // Rebuilt, not forwarded. Anything on the machine can write to this
        // socket, and whatever it wrote used to reach the relay untouched.
        outbound.push(ap::redact_line(line));
    });

    if (!server.start()) return 0;  // fail open: no daemon, hooks no-op

    // Write once up front so the statusline reads a valid file from the first
    // tick instead of treating a missing file as an error.
    ap::write_snapshot(snap, presence.peers());
    long long last_write = now_ms();

    for (;;) {
        server.poll_once(200);
        // Relay transport is attached here; on disconnect, outbound buffers
        // and the lease cache is left stale-but-harmless (expired entries
        // never block, see LeaseCache::conflict_for).

        const long long t = now_ms();
        if (presence.expire(t)) dirty = true;
        if (dirty || t - last_write >= kSnapshotTickMs) {
            ap::write_snapshot(snap, presence.peers());
            last_write = t;
            dirty = false;
        }
    }
}
#endif
