// The hook and the daemon over a real unix socket, wired exactly the way
// daemon/main.cpp wires them.
//
// The gap this closes: the daemon only ever drained lines. A PreToolUse edit
// half-closed, waited out its budget, read a clean EOF and allowed — every
// time, whatever the relay had pushed into the lease cache. Both halves passed
// their own tests the whole while, because neither had ever been run against
// the other.

#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#include <catch2/catch_test_macros.hpp>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <filesystem>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "daemon/decide.hpp"
#include "daemon/lease_cache.hpp"
#include "daemon/socket_server.hpp"
#include "hook/hook.hpp"

namespace {

const std::string kEditPayload =
    R"({"session_id":"sess_b","hook_event_name":"PreToolUse","tool_name":"Edit",)"
    R"("tool_input":{"file_path":"/repo/src/auth.py","old_string":"SECRET"}})";

const std::string kReadPayload =
    R"({"session_id":"sess_b","hook_event_name":"PreToolUse","tool_name":"Read",)"
    R"("tool_input":{"file_path":"/repo/src/auth.py"}})";

/// What the hook budgets for connect, write and read together. Same number
/// hook/main.cpp compiles in; the round trip has to fit inside it.
constexpr int kHookBudgetMs = 2;

/// presenced's socket half on a thread, so a test can act as the hook.
///
/// The wiring is the daemon's: on_line records the event, on_request answers
/// it from the lease cache. Anything more (coalescing, the relay, the snapshot)
/// is somebody else's test.
class Daemon {
public:
    explicit Daemon(std::string path) : path_(std::move(path)), server_(path_) {}

    ~Daemon() {
        stop_.store(true, std::memory_order_relaxed);
        if (loop_.joinable()) loop_.join();
    }

    void hold(const std::string& region, const std::string& agent, const std::string& human,
              const std::string& intent) {
        leases_.replace({{region, ap::CachedLease{agent, human, intent, now_ms() + 60'000}}});
    }

    bool start() {
        server_.on_line([this](std::string line) {
            std::lock_guard<std::mutex> lock(mu_);
            seen_.push_back(std::move(line));
        });
        server_.on_request([this](const std::string& line) {
            return ap::decide_response(line, leases_, now_ms());
        });
        if (!server_.start()) return false;
        loop_ = std::thread([this] {
            while (!stop_.load(std::memory_order_relaxed)) server_.poll_once(10);
        });
        return true;
    }

    std::vector<std::string> seen() {
        std::lock_guard<std::mutex> lock(mu_);
        return seen_;
    }

    static long long now_ms() {
        using namespace std::chrono;
        return duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
    }

private:
    std::string path_;
    ap::SocketServer server_;
    ap::LeaseCache leases_;
    std::mutex mu_;
    std::vector<std::string> seen_;
    std::atomic<bool> stop_{false};
    std::thread loop_;
};

std::string sock_path(const char* leaf) {
    return (std::filesystem::temp_directory_path() / leaf).string();
}

/// The hook connects, so give the daemon thread a moment to reach its poll.
/// Nothing here depends on the timing; it only keeps the first request from
/// racing thread startup.
void settle() { std::this_thread::sleep_for(std::chrono::milliseconds(20)); }

}  // namespace

TEST_CASE("an edit into a held file is blocked, hook to daemon and back") {
    Daemon daemon(sock_path("ap_dec_block.sock"));
    daemon.hold("/repo/src/auth.py|", "sess_a", "sara", "rewriting the token refresh");
    REQUIRE(daemon.start());
    settle();

    const std::string out = ap::run_hook(kEditPayload, sock_path("ap_dec_block.sock"), 50);

    REQUIRE(out.find(R"("permissionDecision":"deny")") != std::string::npos);
    REQUIRE(out.find("sara") != std::string::npos);
    REQUIRE(out.find("rewriting the token refresh") != std::string::npos);
    REQUIRE(out.find("/repo/src/auth.py") != std::string::npos);

    // And the request that produced it was the protocol's, not a guess at it.
    const auto seen = daemon.seen();
    REQUIRE(seen.size() == 1);
    REQUIRE(seen[0].find(R"("want":"decision")") != std::string::npos);
    REQUIRE(seen[0].find("SECRET") == std::string::npos);  // privacy rule holds
}

TEST_CASE("the round trip fits in the budget the hook actually compiles in") {
    Daemon daemon(sock_path("ap_dec_fast.sock"));
    daemon.hold("/repo/src/auth.py|", "sess_a", "sara", "rewriting the token refresh");
    REQUIRE(daemon.start());
    settle();

    // Not a timing assertion — the latency suite owns that. This is the
    // assertion that the answer arrives at all under the real cap, because a
    // decision that only lands with a generous budget is a decision that never
    // lands in production.
    int blocked = 0;
    for (int i = 0; i < 50; ++i) {
        if (ap::run_hook(kEditPayload, sock_path("ap_dec_fast.sock"), kHookBudgetMs).find("deny") !=
            std::string::npos) {
            ++blocked;
        }
    }
    INFO("blocked " << blocked << " of 50 inside " << kHookBudgetMs << "ms");
    REQUIRE(blocked == 50);
}

TEST_CASE("an unheld file allows, silently") {
    Daemon daemon(sock_path("ap_dec_free.sock"));
    daemon.hold("/repo/src/other.py|", "sess_a", "sara", "unrelated work");
    REQUIRE(daemon.start());
    settle();

    REQUIRE(ap::run_hook(kEditPayload, sock_path("ap_dec_free.sock"), 50).empty());
}

TEST_CASE("a read is still one way: reported, never answered, never blocked") {
    Daemon daemon(sock_path("ap_dec_read.sock"));
    daemon.hold("/repo/src/auth.py|", "sess_a", "sara", "rewriting the token refresh");
    REQUIRE(daemon.start());
    settle();

    REQUIRE(ap::run_hook(kReadPayload, sock_path("ap_dec_read.sock"), 50).empty());

    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
    while (daemon.seen().empty() && std::chrono::steady_clock::now() < deadline) {
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
    const auto seen = daemon.seen();
    REQUIRE(seen.size() == 1);
    REQUIRE(seen[0].find(R"("verb":"read")") != std::string::npos);
    REQUIRE(seen[0].find("want") == std::string::npos);
}

// A hook that spends its budget and closes leaves the daemon writing into a
// socket with no reader. The default action for SIGPIPE is death, and this
// process is every session's presence at once.
TEST_CASE("a hook that gives up before the answer cannot kill the daemon") {
    Daemon daemon(sock_path("ap_dec_gone.sock"));
    daemon.hold("/repo/src/auth.py|", "sess_a", "sara", "rewriting the token refresh");
    REQUIRE(daemon.start());
    settle();

    const std::string request = ap::build_request(kEditPayload) + "\n";
    for (int i = 0; i < 500; ++i) {
        const int fd = ::socket(AF_UNIX, SOCK_STREAM, 0);
        REQUIRE(fd >= 0);
        sockaddr_un addr{};
        addr.sun_family = AF_UNIX;
        std::snprintf(addr.sun_path, sizeof(addr.sun_path), "%s",
                      sock_path("ap_dec_gone.sock").c_str());
        if (::connect(fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0) {
            ::close(fd);
            continue;
        }
#ifdef SO_NOSIGPIPE
        const int on = 1;
        ::setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, sizeof(on));
#endif
        const ssize_t sent = ::send(fd, request.data(), request.size(), 0);
        (void)sent;
        ::close(fd);  // gone before the daemon can answer
    }

    // Still serving. If the writes above had killed the thread, or the process,
    // this would not come back.
    REQUIRE(ap::run_hook(kEditPayload, sock_path("ap_dec_gone.sock"), 50)
                .find(R"("permissionDecision":"deny")") != std::string::npos);
}
