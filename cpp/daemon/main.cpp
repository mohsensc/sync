#include <chrono>
#include <cstdlib>
#include <string>
#include <string_view>
#include <utility>

#include "daemon/coalesce.hpp"
#include "daemon/outbound.hpp"
#include "daemon/snapshot.hpp"
#include "daemon/socket_server.hpp"

namespace {

long long now_ms() {
    using namespace std::chrono;
    return duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
}

std::string env_or(const char* key, const std::string& fallback) {
    const char* v = std::getenv(key);
    return v ? std::string(v) : fallback;
}

/// Same shape as the hook's extractor: the hook emits flat string fields only,
/// so a scalar lookup is enough and a JSON dependency is not.
std::string field(std::string_view json, std::string_view key) {
    std::string needle = "\"";
    needle += key;
    needle += "\":\"";
    const auto pos = json.find(needle);
    if (pos == std::string_view::npos) return {};
    const auto start = pos + needle.size();
    const auto end = json.find('"', start);
    if (end == std::string_view::npos) return {};
    return std::string(json.substr(start, end - start));
}

}  // namespace

int main() {
    const std::string runtime = env_or("XDG_RUNTIME_DIR", env_or("TMPDIR", "/tmp"));
    const std::string sock = env_or("AGENT_PRESENCE_SOCK", runtime + "/agent-presence.sock");
    const std::string snap = env_or("AGENT_PRESENCE_SNAPSHOT", runtime + "/agent-presence.json");

    ap::SocketServer server(sock);
    ap::Coalescer coalescer(1000, 200);
    ap::Outbound outbound(1000);

    server.on_line([&](std::string line) {
        // The daemon makes no protocol decisions. It coalesces and forwards.
        ap::Ev e{field(line, "verb"), field(line, "path"), field(line, "agent")};
        if (!coalescer.admit(e, now_ms())) return;
        outbound.push(std::move(line));
    });

    if (!server.start()) return 0;  // fail open: no daemon, hooks no-op

    // Write once up front so the statusline reads a valid file from the first
    // tick instead of treating a missing file as an error.
    ap::write_snapshot(snap, {});
    for (;;) {
        server.poll_once(200);
        // Relay transport is attached here; on disconnect, outbound buffers
        // and the lease cache is left stale-but-harmless (expired entries
        // never block, see LeaseCache::conflict_for).
    }
}
