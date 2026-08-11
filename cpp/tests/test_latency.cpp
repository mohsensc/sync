#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <filesystem>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include "hook/hook.hpp"
#include "tests/test_paths.hpp"
#include "tests/fake_daemon.hpp"

namespace {

const std::string kPayload =
    R"({"tool_name":"Edit","tool_input":{"file_path":"/repo/src/a.py"},"session_id":"s1"})";

double p99(std::vector<double> samples) {
    std::sort(samples.begin(), samples.end());
    return samples[static_cast<size_t>(samples.size() * 0.99)];
}

/// Busy-wait, because sleep_for's granularity here is coarser than the gap we
/// want and we are pacing, not idling.
void spin_us(long us) {
    const auto until = std::chrono::steady_clock::now() + std::chrono::microseconds(us);
    while (std::chrono::steady_clock::now() < until) {
    }
}

}  // namespace

TEST_CASE("hook p99 stays under the 5ms budget with no daemon listening") {
    std::vector<double> samples;
    samples.reserve(1000);
    for (int i = 0; i < 1000; ++i) {
        auto t0 = std::chrono::steady_clock::now();
        ap::write_line("/nonexistent/p.sock", ap::build_event(kPayload), 5);
        auto t1 = std::chrono::steady_clock::now();
        samples.push_back(std::chrono::duration<double, std::milli>(t1 - t0).count());
    }

    REQUIRE(p99(std::move(samples)) < 5.0);
}

// The case above only covers the fast-fail path. The path that runs on every
// tool call of a normal session is this one: a daemon is up, the connect
// succeeds, and the hook has to get in and out inside the same 5ms.
TEST_CASE("hook p99 stays under the 5ms budget with a live daemon listening") {
    const auto sock = apt::unique_temp_path("ap_latency.sock");

    // A daemon that reads and drains without answering — today's presenced on
    // the event socket. What matters for this measurement is a live accept
    // loop on the other end, not which language wrote it.
    apt::FakeDaemon daemon(sock, apt::Mode::kSilent);
    REQUIRE(daemon.start());

    const std::string event = ap::build_event(kPayload);

    // First connect pays for the daemon thread's first trip through poll().
    // That is startup, not per-call cost.
    for (int i = 0; i < 20; ++i) {
        ap::write_line(sock, event, 5);
        spin_us(200);
    }

    // A gap between calls, kept outside the timed window. Firing 1000 connects
    // back to back overruns the 64-deep listen backlog and starts measuring
    // ECONNREFUSED instead of the live path; an agent doing real work is nowhere
    // near that rate.
    constexpr long kGapUs = 200;
    constexpr int kCalls = 1000;

    std::vector<double> samples;
    samples.reserve(kCalls);
    long long delivered = 0;
    for (int i = 0; i < kCalls; ++i) {
        auto t0 = std::chrono::steady_clock::now();
        const bool ok = ap::write_line(sock, event, 5);
        auto t1 = std::chrono::steady_clock::now();
        samples.push_back(std::chrono::duration<double, std::milli>(t1 - t0).count());
        if (ok) ++delivered;
        spin_us(kGapUs);
    }

    // A run where every connect bounced would be fast and meaningless, so the
    // timing only counts if the writes actually went somewhere.
    INFO("delivered " << delivered << "/" << kCalls);
    REQUIRE(delivered == kCalls);

    INFO("p99 was " << p99(samples) << "ms over " << samples.size() << " calls");
    REQUIRE(p99(std::move(samples)) < 5.0);

    // And the daemon really was reading them, not just accepting and dropping.
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(3);
    while (daemon.served() < delivered && std::chrono::steady_clock::now() < deadline) {
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    INFO("daemon saw " << daemon.served() << " lines, hook sent " << delivered);
    REQUIRE(daemon.served() >= delivered);
}

// ---------------------------------------------------------------------------
// The request/response path. The cases above measure a one-way write; this is
// the one that now runs before every Edit and Write, and it has a daemon on the
// other end that has to be asked and answered inside the same 5ms.
// ---------------------------------------------------------------------------

namespace {

const std::string kEditHook =
    R"({"session_id":"s1","hook_event_name":"PreToolUse","tool_name":"Edit",)"
    R"("tool_input":{"file_path":"/repo/src/a.py"}})";

// What ap-hook itself passes, and well under the cap on purpose. The budget is
// what poll() is asked to wait; poll() overshoots by a millisecond or so, and
// the measurement is that wait plus the call around it. Spending the whole 5ms
// on the wait would put the timeout path over the line it has to stay under.
constexpr int kBudgetMs = 2;

}  // namespace

TEST_CASE("decision p99 stays under the 5ms budget against a daemon that answers") {
    const auto sock = apt::unique_temp_path("ap_lat_rt.sock");
    apt::FakeDaemon daemon(
        sock, apt::Mode::kReply,
        R"({"rung":3,"holder":"sess_a","human":"sara","intent":"rewriting token refresh"})");
    REQUIRE(daemon.start());

    const std::string req = ap::build_request(kEditHook);
    for (int i = 0; i < 20; ++i) {  // warm the accept loop; startup is not per-call cost
        ap::request_decision(sock, req, kBudgetMs);
        spin_us(200);
    }

    constexpr int kCalls = 500;
    std::vector<double> samples;
    samples.reserve(kCalls);
    int answered = 0;
    for (int i = 0; i < kCalls; ++i) {
        const auto t0 = std::chrono::steady_clock::now();
        const ap::Decision d = ap::request_decision(sock, req, kBudgetMs);
        const auto t1 = std::chrono::steady_clock::now();
        samples.push_back(std::chrono::duration<double, std::milli>(t1 - t0).count());
        if (d.rung == 3) ++answered;
        spin_us(200);
    }

    // A run where every round trip failed would be fast and meaningless.
    INFO("answered " << answered << "/" << kCalls);
    REQUIRE(answered == kCalls);

    INFO("p99 was " << p99(samples) << "ms over " << samples.size() << " calls");
    REQUIRE(p99(std::move(samples)) < 5.0);
}

TEST_CASE("decision p99 stays under the 5ms budget against a daemon that never answers") {
    // The expensive case: the daemon is up, the connect succeeds, and then
    // nothing comes back. This is the timeout path, and it is the one that
    // would hand every Edit in the session a multi-second stall if the budget
    // were not enforced end to end.
    const auto sock = apt::unique_temp_path("ap_lat_hold.sock");
    apt::FakeDaemon daemon(sock, apt::Mode::kHold);
    REQUIRE(daemon.start());

    const std::string req = ap::build_request(kEditHook);
    constexpr int kCalls = 200;
    std::vector<double> samples;
    samples.reserve(kCalls);
    double worst = 0.0;
    for (int i = 0; i < kCalls; ++i) {
        const auto t0 = std::chrono::steady_clock::now();
        const ap::Decision d = ap::request_decision(sock, req, kBudgetMs);
        const auto t1 = std::chrono::steady_clock::now();
        const double ms = std::chrono::duration<double, std::milli>(t1 - t0).count();
        samples.push_back(ms);
        worst = std::max(worst, ms);
        REQUIRE(d.rung < 0);  // no answer means allow
    }

    // Not just the p99: on this path every single call pays the full budget, so
    // the worst case is the number that matters and it is bounded too.
    INFO("p99 " << p99(samples) << "ms, worst " << worst << "ms over " << samples.size());
    REQUIRE(worst < 5.0);
    REQUIRE(p99(std::move(samples)) < 5.0);
}

TEST_CASE("run_hook p99 stays under the 5ms budget against a daemon that never answers") {
    // A daemon that reads the request and does not respond — the shape of an
    // event, which never carries "want":"decision" and never gets a reply.
    const auto sock = apt::unique_temp_path("ap_lat_run.sock");

    apt::FakeDaemon daemon(sock, apt::Mode::kSilent);
    REQUIRE(daemon.start());

    for (int i = 0; i < 20; ++i) {
        ap::run_hook(kEditHook, sock, kBudgetMs);
        spin_us(200);
    }

    constexpr int kCalls = 500;
    std::vector<double> samples;
    samples.reserve(kCalls);
    for (int i = 0; i < kCalls; ++i) {
        const auto t0 = std::chrono::steady_clock::now();
        const std::string out = ap::run_hook(kEditHook, sock, kBudgetMs);
        const auto t1 = std::chrono::steady_clock::now();
        samples.push_back(std::chrono::duration<double, std::milli>(t1 - t0).count());
        REQUIRE(out.empty());  // a daemon with no answer never blocks a tool call
        spin_us(200);
    }

    // Well under the budget, not merely under the cap. The hook half-closes its
    // write side, so a daemon with no responder hangs up and the hook learns in
    // microseconds that no answer is coming. Drop the half-close and every Edit
    // in the session quietly starts paying the whole timeout instead.
    INFO("p99 was " << p99(samples) << "ms over " << samples.size() << " calls");
    REQUIRE(p99(samples) < static_cast<double>(kBudgetMs));
    REQUIRE(p99(std::move(samples)) < 5.0);

    // The request still reached the daemon: this is one socket conversation,
    // not a wasted connect.
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(3);
    while (daemon.served() < kCalls && std::chrono::steady_clock::now() < deadline) {
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    INFO("daemon saw " << daemon.served() << " request lines");
    REQUIRE(daemon.served() >= kCalls);
}

