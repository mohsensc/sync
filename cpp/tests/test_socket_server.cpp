#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#include <catch2/catch_test_macros.hpp>
#include <chrono>
#include <cstdio>
#include <filesystem>
#include <future>
#include <string>
#include <thread>
#include <vector>
#include "daemon/socket_server.hpp"
#include "hook/hook.hpp"
#include "tests/test_paths.hpp"

namespace {

/// Connect and hand back the raw fd. The caller decides when (or whether) to
/// close it, which is the whole point of the wedge test.
int raw_connect(const std::string& path) {
    int fd = ::socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return -1;
    sockaddr_un addr{};
    addr.sun_family = AF_UNIX;
    std::snprintf(addr.sun_path, sizeof(addr.sun_path), "%s", path.c_str());
    if (::connect(fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0) {
        ::close(fd);
        return -1;
    }
    return fd;
}

/// Leave behind exactly what a SIGKILLed daemon leaves: a socket file on disk
/// with nothing listening on it. bind() creates the inode and close() does not
/// remove it, so this is the real stale state, not a simulation of one.
bool leak_stale_socket(const std::string& path) {
    std::error_code ec;
    std::filesystem::remove(path, ec);

    int fd = ::socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return false;
    sockaddr_un addr{};
    addr.sun_family = AF_UNIX;
    std::snprintf(addr.sun_path, sizeof(addr.sun_path), "%s", path.c_str());
    if (::bind(fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0) {
        ::close(fd);
        return false;
    }
    if (::listen(fd, 8) != 0) {
        ::close(fd);
        return false;
    }
    ::close(fd);  // process gone, file still there
    return true;
}

/// poll_once on a helper thread with a hard deadline. A daemon that parks in
/// read() never comes back, so without this the suite would hang instead of
/// reporting a failure. On timeout the thread and its promise are leaked on
/// purpose: the wedged thread still owns them.
bool poll_bounded(ap::SocketServer* s, int timeout_ms, int budget_ms) {
    auto* signal = new std::promise<void>();
    auto done = signal->get_future();
    std::thread([s, signal, timeout_ms] {
        s->poll_once(timeout_ms);
        signal->set_value();
    }).detach();
    if (done.wait_for(std::chrono::milliseconds(budget_ms)) != std::future_status::ready) {
        return false;
    }
    delete signal;
    return true;
}

}  // namespace

TEST_CASE("daemon receives a line written by the hook") {
    auto path = apt::unique_temp_path("ap_test.sock");
    std::filesystem::remove(path);

    ap::SocketServer server(path);
    std::vector<std::string> got;
    server.on_line([&](std::string l) { got.push_back(std::move(l)); });
    REQUIRE(server.start());

    REQUIRE(ap::write_line(path, R"({"verb":"edit"})", 5));
    server.poll_once(200);

    REQUIRE(got.size() == 1);
    REQUIRE(got[0] == R"({"verb":"edit"})");
    server.stop();
}

// The server and its buffer are heap-allocated and leaked when poll_once does
// not come back: a wedged thread never lets go, and tearing the objects out
// from under it would turn a clean FAIL into a crash.
TEST_CASE("a client that stalls mid-line cannot wedge the daemon") {
    auto path = apt::unique_temp_path("ap_wedge.sock");
    std::filesystem::remove(path);

    auto* server = new ap::SocketServer(path);
    auto* got = new std::vector<std::string>();
    server->on_line([got](std::string l) { got->push_back(std::move(l)); });
    REQUIRE(server->start());

    // Writes bytes with no newline and never closes. This is an ap-hook that
    // got SIGSTOPped between connect() and close().
    const int stuck = raw_connect(path);
    REQUIRE(stuck >= 0);
    REQUIRE(::write(stuck, "{\"verb\":\"edi", 12) == 12);

    // A well-behaved client queued behind it must still be served.
    REQUIRE(ap::write_line(path, R"({"verb":"read"})", 5));

    REQUIRE(poll_bounded(server, 200, 2000));
    REQUIRE(got->size() == 1);
    REQUIRE((*got)[0] == R"({"verb":"read"})");

    ::close(stuck);
    server->stop();
    delete server;
    delete got;
}

TEST_CASE("a half-written line is dropped, not replayed into the next connection") {
    auto path = apt::unique_temp_path("ap_partial.sock");
    std::filesystem::remove(path);

    auto* server = new ap::SocketServer(path);
    auto* got = new std::vector<std::string>();
    server->on_line([got](std::string l) { got->push_back(std::move(l)); });
    REQUIRE(server->start());

    const int stuck = raw_connect(path);
    REQUIRE(stuck >= 0);
    REQUIRE(::write(stuck, "{\"verb\":\"edi", 12) == 12);
    REQUIRE(poll_bounded(server, 50, 2000));

    REQUIRE(ap::write_line(path, R"({"verb":"read"})", 5));
    REQUIRE(poll_bounded(server, 200, 2000));

    REQUIRE(got->size() == 1);
    REQUIRE((*got)[0] == R"({"verb":"read"})");

    ::close(stuck);
    server->stop();
    delete server;
    delete got;
}

TEST_CASE("several pending connections are all drained in one poll_once") {
    auto path = apt::unique_temp_path("ap_drain.sock");
    std::filesystem::remove(path);

    ap::SocketServer server(path);
    std::vector<std::string> got;
    server.on_line([&](std::string l) { got.push_back(std::move(l)); });
    REQUIRE(server.start());

    for (int i = 0; i < 8; ++i) {
        REQUIRE(ap::write_line(path, "{\"n\":\"" + std::to_string(i) + "\"}", 5));
    }
    server.poll_once(200);

    REQUIRE(got.size() == 8);
    server.stop();
}

TEST_CASE("starting twice on the same path succeeds by reclaiming a stale socket") {
    const auto path = apt::unique_temp_path("ap_stale.sock");

    // A clean shutdown unlinks the path, so a second SocketServer would find
    // nothing in its way and prove nothing. The daemon that matters here is the
    // one that died mid-flight and left its socket file behind.
    REQUIRE(leak_stale_socket(path));
    REQUIRE(std::filesystem::exists(path));
    REQUIRE(raw_connect(path) < 0);  // the file is there; nobody is home

    ap::SocketServer b(path);
    std::vector<std::string> got;
    b.on_line([&](std::string l) { got.push_back(std::move(l)); });
    REQUIRE(b.start());

    // start() returning true is not enough. The point of reclaiming is that
    // hooks reach the new daemon, so make one and check it lands.
    REQUIRE(ap::write_line(path, R"({"verb":"edit"})", 50));
    b.poll_once(200);
    REQUIRE(got.size() == 1);
    REQUIRE(got[0] == R"({"verb":"edit"})");

    b.stop();
    REQUIRE_FALSE(std::filesystem::exists(path));
}
