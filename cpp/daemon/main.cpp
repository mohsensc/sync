#include <poll.h>
#include <unistd.h>

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <optional>
#include <string>
#include <string_view>
#include <utility>

#include "daemon/coalesce.hpp"
#include "daemon/decide.hpp"
#include "daemon/decision_server.hpp"
#include "daemon/journal.hpp"
#include "daemon/json.hpp"
#include "daemon/lease_cache.hpp"
#include "daemon/outbound.hpp"
#include "daemon/policy_cache.hpp"
#include "daemon/relay_client.hpp"
#include "daemon/repo.hpp"
#include "daemon/snapshot.hpp"
#include "daemon/socket_server.hpp"

namespace {

// How long an agent stays on the statusline after its last event, and how often
// the snapshot is rewritten even when nothing changed. The periodic rewrite is
// what turns a fresh mtime into proof the daemon is alive.
constexpr long long kPresenceTtlMs = 30000;
constexpr long long kSnapshotTickMs = 1000;

// The tick. One wait, on every fd that matters, then a non-blocking pass over
// both halves.
//
// Splitting the wait — poll the hook socket for a while, then poll the relay
// for a while — is what the loop used to do, and it cannot answer a hook. The
// hook spends 2ms total on connect, write and read; a daemon parked inside a
// relay poll misses that window entirely and the edit allows. So the blocking
// happens here, over the listen fd and the relay fd together, and whichever
// speaks first wakes the loop.
constexpr int kTickMs = 100;
constexpr int kConnBudgetMs = 5;  // per hook connection; the hook's own cap

long long now_ms() {
    using namespace std::chrono;
    return duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
}

/// Wall clock, for the journal alone. Everything else in this daemon is on the
/// monotonic clock and must stay there — a lease TTL that moves when somebody
/// sets the system time is a lease that expires early or never. But `ap why`
/// prints a time of day, and a steady_clock reading is not one.
long long wall_ms() {
    using namespace std::chrono;
    return duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
}

std::string env_or(const char* key, const std::string& fallback) {
    const char* v = std::getenv(key);
    return v ? std::string(v) : fallback;
}

/// Longest thing that can be a bearer token. `secrets.token_urlsafe(32)` is 43
/// characters; this is orders of magnitude above that and still small enough
/// that being pointed at the wrong file costs a read and not a process.
constexpr std::size_t kMaxTokenBytes = 4096;

/// The truthy spellings, and nothing else is a guess.
///
/// Anything unrecognised reads as false, which is `attended` — the quieter end
/// of every band. A typo should cost a tier, never gain one.
bool env_is_true(const std::string& v) {
    return v == "1" || v == "true" || v == "TRUE" || v == "True" || v == "yes" ||
           v == "on";
}

std::string trim_ascii(std::string s) {
    const char* ws = " \t\r\n\v\f";
    const auto first = s.find_first_not_of(ws);
    if (first == std::string::npos) return {};
    const auto last = s.find_last_not_of(ws);
    return s.substr(first, last - first + 1);
}

/// The bearer token this daemon presents, or empty.
///
/// `$AGENT_PRESENCE_TOKEN` first, then the file `ap principals add` tells people
/// to write:  `$XDG_CONFIG_HOME/agent-presence/token`, else
/// `$HOME/.config/agent-presence/token`. Same rule the python side uses for the
/// user policy layer, so a machine has one config directory and not two.
///
/// Pure over its inputs so it can be tested without an environment. Every
/// failure is empty: no token means the relay grants the default tier, which is
/// the same thing that happens with no roster at all.
std::string discover_token(const std::string& env_token, const std::string& config_home,
                           const std::string& home) {
    if (!env_token.empty()) return trim_ascii(env_token);

    std::string base = config_home;
    if (base.empty()) {
        if (home.empty()) return {};
        base = home + "/.config";
    }
    const std::string path = base + "/agent-presence/token";

    std::error_code ec;
    const auto size = std::filesystem::file_size(path, ec);
    if (ec || size > kMaxTokenBytes) return {};

    std::ifstream f(path, std::ios::binary);
    if (!f) return {};
    std::string line;
    // The first non-blank line, so a hand-edited file with a note under the
    // secret still works.
    while (std::getline(f, line)) {
        const std::string trimmed = trim_ascii(line);
        if (!trimmed.empty()) return trimmed;
    }
    return {};
}

std::string hostname() {
    char buf[256] = {0};
    if (::gethostname(buf, sizeof(buf) - 1) != 0) return "unknown-host";
    return buf[0] ? std::string(buf) : std::string("unknown-host");
}

std::string shell_quote(const std::string& s) {
    std::string out = "'";
    for (char c : s) {
        if (c == '\'') out += "'\\''";
        else out += c;
    }
    out += "'";
    return out;
}

/// The origin remote of a checkout, or empty. Runs git once, at startup, and
/// never again: forking in the event loop would be the one thing the 5ms
/// budget cannot absorb.
std::string git_origin_url(const std::string& root) {
    const std::string cmd = "git -C " + shell_quote(root) + " remote get-url origin 2>/dev/null";
    FILE* p = ::popen(cmd.c_str(), "r");
    if (p == nullptr) return {};

    std::string out;
    char buf[512];
    while (std::fgets(buf, sizeof(buf), p) != nullptr) out += buf;
    ::pclose(p);

    while (!out.empty() && (out.back() == '\n' || out.back() == '\r')) out.pop_back();
    return out;
}

/// Which room this daemon's events belong to.
///
/// Rooms are a hash of the git remote, so the daemon needs a checkout, and the
/// one it has is the directory it was started in. AGENT_PRESENCE_ROOM overrides
/// that for anyone running it somewhere else.
///
/// Empty means no relay. That is deliberate: one connection carries one room,
/// and joining a made-up room would put every unkeyed machine on the planet in
/// the same one. A daemon with no room still writes the snapshot, which is the
/// whole local half of the product.
std::string discover_room() {
    const std::string forced = env_or("AGENT_PRESENCE_ROOM", "");
    if (!forced.empty()) return forced;

    std::error_code ec;
    const auto cwd = std::filesystem::current_path(ec);
    if (ec) return {};

    const auto root = ap::find_repo_root(cwd.string());
    if (!root) return {};

    const std::string remote = git_origin_url(*root);
    if (remote.empty()) return {};
    return ap::room_id_from_remote(remote);
}

}  // namespace

#ifndef AP_DAEMON_NO_MAIN
int main() {
    const std::string runtime = env_or("XDG_RUNTIME_DIR", env_or("TMPDIR", "/tmp"));
    const std::string sock = env_or("AGENT_PRESENCE_SOCK", runtime + "/agent-presence.sock");
    const std::string snap = env_or("AGENT_PRESENCE_SNAPSHOT", runtime + "/agent-presence.json");
    // Written by `ap policy compile`, the SessionStart hook and the MCP server.
    // The daemon only ever stats and reads it — no TOML on this side, ever.
    const std::string policy_cache =
        env_or("AGENT_PRESENCE_POLICY_CACHE", runtime + "/agent-presence.policy.json");

    ap::SocketServer server(sock);
    ap::Coalescer coalescer(1000, 200);
    ap::Outbound outbound(1000);
    ap::PresenceTable presence(kPresenceTtlMs);
    ap::LeaseCache leases;
    ap::PolicyCache policy;
    // Read by `ap why`. Same directory rule as the snapshot and the sockets,
    // derived on both sides from the same two env vars rather than passed
    // between them, so the two halves cannot end up looking at different files.
    ap::DecisionJournal journal(runtime + "/agent-presence.decisions.jsonl");
    // Once before the socket is up, so the first decision of the session
    // already has the current table rather than the builtin one.
    policy.refresh(policy_cache, now_ms());

    bool dirty = false;

    ap::RelayConfig relay_cfg;
    relay_cfg.url = env_or("AGENT_PRESENCE_RELAY", "ws://127.0.0.1:8799");
    relay_cfg.room = discover_room();
    // One daemon, one connection, one identity. The relay reads identity off
    // the connection and ignores what a frame claims, so everything this
    // machine forwards is attributed to this name. The per-event agent id
    // still rides along inside the payload for anything downstream that wants
    // to split it back out.
    relay_cfg.agent = env_or("AGENT_PRESENCE_AGENT", "presenced@" + hostname());
    relay_cfg.human = env_or("AGENT_PRESENCE_HUMAN", env_or("USER", hostname()));
    // Who this machine runs as, if anyone said. `ap principals add` mints the
    // token and prints it once; this is the end that reads it back. Nothing is
    // presented when nothing is configured, so an unrostered install joins
    // exactly as it always did.
    relay_cfg.principal = trim_ascii(env_or("AGENT_PRESENCE_PRINCIPAL", ""));
    relay_cfg.token = discover_token(env_or("AGENT_PRESENCE_TOKEN", ""),
                                     env_or("XDG_CONFIG_HOME", ""),
                                     env_or("HOME", ""));
    relay_cfg.unattended = env_is_true(env_or("AGENT_PRESENCE_UNATTENDED", ""));

    std::optional<ap::RelayClient> relay;
    if (!relay_cfg.room.empty()) {
        relay.emplace(relay_cfg, outbound, leases);
        // Peers on other machines land in the same table local agents do, so
        // the statusline stops being a mirror of this laptop.
        relay->on_peer([&](const ap::RelayPeer& p) {
            if (p.agent.empty()) return;
            const std::string& who = p.human.empty() ? p.agent : p.human;
            if (presence.touch(p.agent, who, p.verb, p.path, now_ms())) dirty = true;
        });
        // The org floor, live. The relay sends this on join and again whenever
        // its own file changes, so tightening an org policy reaches every
        // daemon in the room without anyone restarting anything.
        relay->on_policy([&](const ap::RelayPolicy& p) {
            policy.set_floor(p.floor, p.source);
            dirty = true;
        });
    }

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
        // socket, and whatever it wrote used to reach the relay untouched. The
        // rewrap on top reads only the four fields redact_line kept.
        std::string frame = ap::relay_event_frame(ap::redact_line(line));
        if (!frame.empty()) outbound.push(std::move(frame));
    });

    // The other half of the socket protocol. on_line above records and forwards;
    // this answers, on the same connection, inside the hook's budget. Without it
    // every PreToolUse edit read a clean EOF and allowed, and the leases the
    // relay pushes into the cache reached nobody.
    //
    // Still here now that decisions have their own socket, because a hook from
    // an older install asks on this one and has to keep getting an answer.
    // Nothing else uses it: current hooks ask on the decision socket.
    auto decide = [&](const std::string& line) {
        std::string answer = ap::decide_response(line, leases, policy, now_ms());
        // Recorded here rather than inside decide_response, which is a pure
        // function over the request and the two tables and is worth keeping
        // that way. Both callers — this one and DecisionServer's threads — go
        // through this lambda, so both are journalled and neither can forget.
        journal.record(wall_ms(), line, answer, policy);
        return answer;
    };
    server.on_request(decide);

    if (!server.start()) return 0;  // fail open: no daemon, hooks no-op

    // Decisions, off the loop entirely.
    //
    // Everything below this line — draining events, stepping the relay,
    // writing the snapshot — happens between polls, and a hook that connects
    // during any of it used to wait. Under an event storm the wait was longer
    // than the hook's whole budget, so the edit went through unchecked and
    // nothing said so. The decision socket has its own queue and its own
    // threads; the only thing it shares with the loop is a read lock on the
    // lease cache.
    //
    // If it cannot start, the loop keeps answering on the event socket and the
    // hook falls back to asking there. Slower under load, never wrong.
    ap::DecisionServer decisions(ap::decision_sock_path(sock), decide);
    decisions.start();

    // Write once up front so the statusline reads a valid file from the first
    // tick instead of treating a missing file as an error.
    ap::write_snapshot(snap, presence.peers(), policy.problem());
    long long last_write = now_ms();
    std::string last_problem = policy.problem();

    for (;;) {
        pollfd fds[2];
        nfds_t nfds = 0;
        fds[nfds++] = pollfd{server.listen_fd(), POLLIN, 0};
        if (relay && relay->fd() >= 0) {
            // POLLOUT only while the TCP connect is still in flight, which is
            // how completion is reported. A connected socket is writable
            // almost always, so asking for it in any other state would turn
            // this wait into a spin.
            const short want = static_cast<short>(
                POLLIN | (relay->state() == ap::RelayClient::State::Connecting ? POLLOUT : 0));
            fds[nfds++] = pollfd{relay->fd(), want, 0};
        }
        // Return value ignored on purpose: both calls below are non-blocking
        // and cope with having nothing to do. The timeout is what keeps the
        // backoff timer and the snapshot tick running when both fds are quiet.
        ::poll(fds, nfds, kTickMs);

        server.poll_once(kConnBudgetMs);
        // Zero budget, deliberately: one non-blocking step of the state
        // machine. A relay that is down sits in backoff, and a backoff that
        // sleeps inside this loop is time the daemon is not on the hook
        // socket — which the hook's 2ms budget cannot survive. All the waiting
        // happens in the poll above, over both fds at once.
        //
        // On disconnect this buffers into Outbound and keeps retrying, and the
        // lease cache is left stale-but-harmless: expired entries never block,
        // see LeaseCache::conflict_for.
        if (relay) relay->poll(0);

        const long long t = now_ms();
        // One stat, on a tick that already runs. The parse only happens when
        // the mtime or the size moved, so a policy that is not changing costs
        // ten stats a second and nothing else — and a policy that *is* changing
        // is in force by the next edit, with no restart of anything.
        policy.refresh(policy_cache, t);
        std::string problem = policy.problem();
        if (problem != last_problem) {
            last_problem = std::move(problem);
            dirty = true;  // a degradation has to reach the statusline promptly
        }

        // Off the decision path on purpose: a hook must never wait on a file
        // rewrite. Free when there is nothing to cut back.
        journal.maybe_trim();

        if (presence.expire(t)) dirty = true;
        if (dirty || t - last_write >= kSnapshotTickMs) {
            ap::write_snapshot(snap, presence.peers(), last_problem);
            last_write = t;
            dirty = false;
        }
    }
}
#endif
