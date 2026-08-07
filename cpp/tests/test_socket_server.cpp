#include <catch2/catch_test_macros.hpp>
#include <filesystem>
#include <string>
#include <vector>
#include "daemon/socket_server.hpp"
#include "hook/hook.hpp"

TEST_CASE("daemon receives a line written by the hook") {
    auto path = (std::filesystem::temp_directory_path() / "ap_test.sock").string();
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

TEST_CASE("starting twice on the same path succeeds by reclaiming a stale socket") {
    auto path = (std::filesystem::temp_directory_path() / "ap_stale.sock").string();
    { ap::SocketServer a(path); REQUIRE(a.start()); }
    ap::SocketServer b(path);
    REQUIRE(b.start());
    b.stop();
}
