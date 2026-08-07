#include <signal.h>
#include <spawn.h>
#include <sys/wait.h>
#include <unistd.h>

#if defined(__APPLE__)
#include <mach-o/dyld.h>
#endif

#include <catch2/catch_test_macros.hpp>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <functional>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>
#include "daemon/snapshot.hpp"
#include "hook/hook.hpp"

extern char** environ;

static std::string read_all(const std::string& p) {
    std::ifstream f(p);
    std::ostringstream ss;
    ss << f.rdbuf();
    return ss.str();
}

namespace {

/// presenced sits next to the test binary in the build dir.
std::filesystem::path exe_dir() {
#if defined(__APPLE__)
    char buf[4096];
    std::uint32_t n = sizeof(buf);
    if (_NSGetExecutablePath(buf, &n) != 0) return {};
    std::error_code ec;
    auto p = std::filesystem::weakly_canonical(std::filesystem::path(buf), ec);
    return ec ? std::filesystem::path(buf).parent_path() : p.parent_path();
#else
    std::error_code ec;
    auto p = std::filesystem::read_symlink("/proc/self/exe", ec);
    if (ec) return {};
    return p.parent_path();
#endif
}

bool wait_until(const std::function<bool()>& pred, int budget_ms) {
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(budget_ms);
    while (std::chrono::steady_clock::now() < deadline) {
        if (pred()) return true;
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    return pred();
}

}  // namespace

TEST_CASE("snapshot is valid json containing each peer") {
    auto p = (std::filesystem::temp_directory_path() / "ap_snap.json").string();
    ap::write_snapshot(p, {{"sara", "edit", "src/auth.py"}, {"dev", "read", "src/db.py"}});

    auto s = read_all(p);
    REQUIRE(s.find("\"sara\"") != std::string::npos);
    REQUIRE(s.find("\"dev\"") != std::string::npos);
    REQUIRE(s.front() == '{');
}

TEST_CASE("an empty peer list still writes a readable snapshot") {
    auto p = (std::filesystem::temp_directory_path() / "ap_empty.json").string();
    ap::write_snapshot(p, {});
    REQUIRE(read_all(p).find("\"peers\":[]") != std::string::npos);
}

TEST_CASE("writes leave no partial file behind") {
    const auto p = (std::filesystem::temp_directory_path() / "ap_atomic.json").string();
    std::filesystem::remove(p);

    // Big enough that a non-atomic write takes several buffer flushes to land.
    // A one-peer snapshot fits in a single flush, so the torn window would be
    // narrow enough to miss and the test would prove nothing.
    auto peers_of = [](const std::string& human, int n) {
        std::vector<ap::Peer> v;
        v.reserve(static_cast<size_t>(n));
        for (int i = 0; i < n; ++i) {
            v.push_back(ap::Peer{human, "edit",
                                 "src/deeply/nested/module/tree/segment_" + std::to_string(i) +
                                     "/handler.py"});
        }
        return v;
    };
    const auto a = peers_of("sara", 400);
    const auto b = peers_of("devon", 400);

    // The statusline reads this path once a second. These two documents are the
    // only bytes it is ever allowed to see; anything else is a torn write.
    ap::write_snapshot(p, a);
    const std::string doc_a = read_all(p);
    ap::write_snapshot(p, b);
    const std::string doc_b = read_all(p);
    REQUIRE(doc_a.size() > 16384);
    REQUIRE(doc_a != doc_b);

    std::atomic<bool> stop{false};
    std::atomic<long long> reads{0};
    std::atomic<long long> torn{0};
    std::mutex sample_mu;
    std::string sample;

    // Catch2's macros are not thread safe, so the reader only records what it
    // saw. The assertions all happen back on the main thread after the join.
    std::thread reader([&] {
        while (!stop.load(std::memory_order_relaxed)) {
            const std::string s = read_all(p);
            reads.fetch_add(1, std::memory_order_relaxed);
            if (s == doc_a || s == doc_b) continue;
            if (torn.fetch_add(1, std::memory_order_relaxed) == 0) {
                std::lock_guard<std::mutex> g(sample_mu);
                sample = "len=" + std::to_string(s.size()) + " head=[" + s.substr(0, 60) +
                         "] tail=[" + (s.size() > 60 ? s.substr(s.size() - 60) : s) + "]";
            }
        }
    });

    for (int i = 0; i < 400; ++i) ap::write_snapshot(p, (i % 2) ? a : b);
    stop.store(true, std::memory_order_relaxed);
    reader.join();

    // Without this the test could "pass" because the reader never got a turn.
    REQUIRE(reads.load() > 100);

    std::lock_guard<std::mutex> g(sample_mu);
    INFO("reads=" << reads.load() << " torn=" << torn.load() << " first torn read: " << sample);
    REQUIRE(torn.load() == 0);
}

TEST_CASE("presence table reflects each agent's latest activity") {
    ap::PresenceTable t(30000);
    REQUIRE(t.touch("a1", "sara", "edit", "src/auth.py", 0));
    REQUIRE(t.touch("a2", "dev", "read", "src/db.py", 10));
    REQUIRE(t.size() == 2);

    auto p = t.peers();
    REQUIRE(p.size() == 2);
    REQUIRE(p[0].human == "sara");  // first seen, first shown
    REQUIRE(p[1].human == "dev");

    // Moving on to another file is a visible change; repeating is not.
    REQUIRE(t.touch("a1", "sara", "edit", "src/api.py", 20));
    REQUIRE_FALSE(t.touch("a1", "sara", "edit", "src/api.py", 30));
    REQUIRE(t.peers()[0].path == "src/api.py");
}

TEST_CASE("an agent that goes quiet drops off the statusline") {
    ap::PresenceTable t(1000);
    t.touch("a1", "sara", "edit", "a.py", 0);
    t.touch("a2", "dev", "read", "b.py", 900);

    REQUIRE_FALSE(t.expire(500));
    REQUIRE(t.size() == 2);

    REQUIRE(t.expire(1500));
    REQUIRE(t.size() == 1);
    REQUIRE(t.peers()[0].human == "dev");

    REQUIRE(t.expire(3000));
    REQUIRE(t.peers().empty());
}

TEST_CASE("a snapshot written from the presence table names the peers") {
    auto p = (std::filesystem::temp_directory_path() / "ap_presence.json").string();
    ap::PresenceTable t(30000);
    t.touch("a1", "sara", "edit", "src/auth.py", 0);
    ap::write_snapshot(p, t.peers());

    const auto s = read_all(p);
    REQUIRE(s.find("\"human\":\"sara\"") != std::string::npos);
    REQUIRE(s.find("src/auth.py") != std::string::npos);
}

TEST_CASE("a live daemon keeps the snapshot current as events arrive") {
    const auto bin = exe_dir() / "presenced";
    REQUIRE(std::filesystem::exists(bin));

    const auto dir = std::filesystem::temp_directory_path();
    const auto sock = (dir / "ap_live.sock").string();
    const auto snap = (dir / "ap_live.json").string();
    std::filesystem::remove(sock);
    std::filesystem::remove(snap);

    std::string e_sock = "AGENT_PRESENCE_SOCK=" + sock;
    std::string e_snap = "AGENT_PRESENCE_SNAPSHOT=" + snap;
    std::vector<char*> env;
    for (char** e = environ; *e; ++e) env.push_back(*e);
    env.push_back(e_sock.data());
    env.push_back(e_snap.data());
    env.push_back(nullptr);

    std::string prog = bin.string();
    char* argv[] = {prog.data(), nullptr};
    pid_t pid = -1;
    REQUIRE(::posix_spawn(&pid, prog.c_str(), nullptr, nullptr, argv, env.data()) == 0);

    const bool up = wait_until([&] { return std::filesystem::exists(sock); }, 3000);
    if (!up) {
        ::kill(pid, SIGKILL);
        ::waitpid(pid, nullptr, 0);
    }
    REQUIRE(up);

    REQUIRE(ap::write_line(sock, R"({"verb":"edit","agent":"a1","path":"src/auth.py"})", 50));

    const bool shown = wait_until(
        [&] {
            const auto s = read_all(snap);
            return s.find("\"a1\"") != std::string::npos &&
                   s.find("src/auth.py") != std::string::npos;
        },
        3000);

    const std::string final_snap = read_all(snap);
    ::kill(pid, SIGKILL);
    ::waitpid(pid, nullptr, 0);
    std::filesystem::remove(sock);
    std::filesystem::remove(snap);

    INFO("snapshot was: " << final_snap);
    REQUIRE(shown);
}
