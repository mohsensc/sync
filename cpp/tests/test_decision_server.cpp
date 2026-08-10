// Decisions must survive an event flood on the daemon's socket.
//
// The gap this closes: events and PreToolUse decisions shared one listening
// socket, so they shared one accept queue. A session opening that socket in a
// tight loop — and anything on the machine can — put every decision request
// behind however many events got there first. It waited out the hook's 2ms
// budget, read EOF, and the edit was allowed. The hook exits 0 either way, so
// nothing anywhere said protection had been lost. The load harness measured
// most decisions going that way at 16 event lanes.
//
// So the test is not "is the answer right", which test_decision_path.cpp
// covers. It is "does the answer still arrive while the event socket is being
// hammered".

#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#include <catch2/catch_test_macros.hpp>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <filesystem>
#include <string>
#include <thread>
#include <vector>

#include "daemon/decide.hpp"
#include "daemon/decision_server.hpp"
#include "daemon/lease_cache.hpp"
#include "daemon/socket_server.hpp"
#include "hook/hook.hpp"
#include "hook/protocol.hpp"

namespace {

const std::string kEditPayload =
    R"({"session_id":"sess_b","hook_event_name":"PreToolUse","tool_name":"Edit",)"
    R"("tool_input":{"file_path":"/repo/src/auth.py"}})";

/// The budget hook/main.cpp compiles in. The whole point is what fits in it.
constexpr int kHookBudgetMs = 2;

/// A budget with room in it for the scheduler.
///
/// Sixteen threads opening sockets as fast as they can leaves a laptop with
/// nothing spare, and 2ms of wall clock is then partly queueing for a core.
/// Measured at this budget the machine stops being a variable and what is left
/// is the daemon's design: with one shared socket, 1 to 21 of 400 decisions
/// came back even here.
constexpr int kSlackBudgetMs = 20;

long long now_ms() {
    using namespace std::chrono;
    return duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
}

std::string sock_path(const char* leaf) {
    return (std::filesystem::temp_directory_path() / leaf).string();
}

/// presenced's two sockets, wired the way daemon/main.cpp wires them.
///
/// `answer_on_event_socket` is the compatibility half: a hook from an older
/// install asks on the event socket and still has to get an answer there.
class Daemon {
public:
    explicit Daemon(std::string path, bool run_decision_server = true,
                    bool answer_on_event_socket = true)
        : path_(std::move(path)),
          events_(path_),
          decisions_(ap::decision_sock_path(path_),
                     [this](const std::string& line) {
                         return ap::decide_response(line, leases_, now_ms());
                     }),
          want_decisions_(run_decision_server),
          answer_on_events_(answer_on_event_socket) {}

    ~Daemon() {
        stop_.store(true, std::memory_order_relaxed);
        if (loop_.joinable()) loop_.join();
        decisions_.stop();
    }

    void hold(const std::string& region, const std::string& agent, const std::string& human,
              const std::string& intent) {
        leases_.replace({{region, ap::CachedLease{agent, human, intent, now_ms() + 60'000}}});
    }

    bool start() {
        events_.on_line([this](std::string) { events_seen_.fetch_add(1); });
        if (answer_on_events_) {
            events_.on_request([this](const std::string& line) {
                return ap::decide_response(line, leases_, now_ms());
            });
        }
        if (!events_.start()) return false;
        if (want_decisions_ && !decisions_.start()) return false;

        // The daemon's loop: one thread, serving events and doing whatever else
        // it does between polls.
        loop_ = std::thread([this] {
            while (!stop_.load(std::memory_order_relaxed)) events_.poll_once(5);
        });
        return true;
    }

    long long events_seen() const { return events_seen_.load(); }

private:
    std::string path_;
    ap::SocketServer events_;
    ap::LeaseCache leases_;
    ap::DecisionServer decisions_;
    bool want_decisions_;
    bool answer_on_events_;
    std::atomic<long long> events_seen_{0};
    std::atomic<bool> stop_{false};
    std::thread loop_;
};

/// Fire-and-forget events at the event socket, as fast as the machine allows,
/// until told to stop. This is the traffic the decisions have to survive.
class EventStorm {
public:
    EventStorm(std::string path, int lanes) : path_(std::move(path)) {
        for (int i = 0; i < lanes; ++i) lanes_.emplace_back([this, i] { run(i); });
    }

    ~EventStorm() {
        stop_.store(true, std::memory_order_relaxed);
        for (auto& t : lanes_) {
            if (t.joinable()) t.join();
        }
    }

    long long sent() const { return sent_.load(); }

private:
    void run(int lane) {
        long long n = 0;
        while (!stop_.load(std::memory_order_relaxed)) {
            const std::string line = R"({"verb":"search","agent":"storm)" + std::to_string(lane) +
                                     R"(","path":"src/storm/)" + std::to_string(n++) + ".py\"}";
            if (ap::write_line(path_, line, 5)) sent_.fetch_add(1);
        }
    }

    std::string path_;
    std::atomic<long long> sent_{0};
    std::atomic<bool> stop_{false};
    std::vector<std::thread> lanes_;
};

void settle() { std::this_thread::sleep_for(std::chrono::milliseconds(30)); }

/// How many of `n` hook calls came back with a block.
int blocked_out_of(int n, const std::string& sock, int budget_ms = kHookBudgetMs) {
    int blocked = 0;
    for (int i = 0; i < n; ++i) {
        if (ap::run_hook(kEditPayload, sock, budget_ms)
                .find(R"("permissionDecision":"deny")") != std::string::npos) {
            ++blocked;
        }
    }
    return blocked;
}

}  // namespace

TEST_CASE("the hook asks on the decision socket, not the event socket") {
    // The event socket answers nothing at all here. If the hook were still
    // asking there, every one of these would allow.
    //
    // This is a routing question, not a latency one — test_latency.cpp owns
    // the budget itself — so it asks with room for the scheduler rather than
    // the shipped 2ms. A slow reply here is still the right reply.
    Daemon daemon(sock_path("ap_ds_route.sock"), true, false);
    daemon.hold("/repo/src/auth.py|", "sess_a", "sara", "rewriting the token refresh");
    REQUIRE(daemon.start());
    settle();

    REQUIRE(blocked_out_of(50, sock_path("ap_ds_route.sock"), kSlackBudgetMs) == 50);
}

TEST_CASE("a daemon with no decision socket still answers on the event socket") {
    // The compatibility direction: a hook that has learned about the decision
    // socket, against a daemon that has not. The connect is refused and the
    // hook asks where it always used to. Routing, not latency, so the slack
    // budget: see the case above.
    Daemon daemon(sock_path("ap_ds_compat.sock"), false, true);
    daemon.hold("/repo/src/auth.py|", "sess_a", "sara", "rewriting the token refresh");
    REQUIRE(daemon.start());
    settle();

    REQUIRE(blocked_out_of(50, sock_path("ap_ds_compat.sock"), kSlackBudgetMs) == 50);
}

TEST_CASE("a leftover decision socket does not swallow the decision") {
    // presenced is killed, not stopped, so its socket files outlive it. The
    // next daemon up unlinks and rebinds them — but between the two, and for a
    // daemon too old to bind the decision path at all, a file sits there that
    // refuses connections. The hook has to notice and ask on the event socket.
    // Routing, not latency, so the slack budget: see the case above.
    const std::string sock = sock_path("ap_ds_stale.sock");
    const std::string stale = ap::decision_sock_path(sock);
    std::filesystem::remove(stale);
    { std::FILE* f = std::fopen(stale.c_str(), "w"); REQUIRE(f != nullptr); std::fclose(f); }

    Daemon daemon(sock, false, true);
    daemon.hold("/repo/src/auth.py|", "sess_a", "sara", "rewriting the token refresh");
    REQUIRE(daemon.start());
    settle();

    const int blocked = blocked_out_of(50, sock, kSlackBudgetMs);
    std::filesystem::remove(stale);
    REQUIRE(blocked == 50);
}

TEST_CASE("decisions survive an event flood on the daemon's other socket") {
    Daemon daemon(sock_path("ap_ds_storm.sock"), true, true);
    daemon.hold("/repo/src/auth.py|", "sess_a", "sara", "rewriting the token refresh");
    REQUIRE(daemon.start());
    settle();

    constexpr int kCalls = 400;
    // Sixteen lanes is the load harness's worst case, and it is not an absurd
    // one: it is sixteen agents mid-tool-call on one machine.
    EventStorm storm(sock_path("ap_ds_storm.sock"), 16);
    settle();

    // Every one of them, given a budget the scheduler cannot eat. This is the
    // assertion about the design rather than about the laptop: a decision no
    // longer queues behind events, so the flood costs it nothing. On one
    // shared socket this came back 1 to 21 of 400 — a longer budget does not
    // help you when you are behind a thousand connections in the same queue.
    const int patient = blocked_out_of(kCalls, sock_path("ap_ds_storm.sock"), kSlackBudgetMs);
    INFO("blocked " << patient << " of " << kCalls << " at " << kSlackBudgetMs << "ms, with "
                    << storm.sent() << " events pushed at the event socket");
    REQUIRE(patient == kCalls);

    // And at the budget the hook actually ships with. Not all of them: the hook
    // gives up after 2ms of wall clock by design, and on a machine with sixteen
    // lanes spinning some of that goes on waiting for a core. Measured here at
    // 98-100%, against 0% before the sockets were split, so the floor is room
    // for a slower machine rather than a number tuned to pass.
    const int blocked = blocked_out_of(kCalls, sock_path("ap_ds_storm.sock"));
    INFO("blocked " << blocked << " of " << kCalls << " at the shipped " << kHookBudgetMs << "ms");
    REQUIRE(blocked >= kCalls * 95 / 100);

    // If the storm never got going the test proved nothing.
    REQUIRE(daemon.events_seen() > 100);
}
