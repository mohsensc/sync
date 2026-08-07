#include <catch2/catch_test_macros.hpp>
#include <chrono>
#include <filesystem>
#include <string>
#include "hook/hook.hpp"

TEST_CASE("write_line returns false when no socket exists, and never throws") {
    REQUIRE_FALSE(ap::write_line("/nonexistent/path.sock", "{}", 5));
}

TEST_CASE("write_line to a dead path stays inside the latency budget") {
    auto start = std::chrono::steady_clock::now();
    for (int i = 0; i < 100; ++i) ap::write_line("/nonexistent/p.sock", "{}", 5);
    auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - start).count();
    // 100 failed attempts must stay well under 100 * 5ms; failure is immediate.
    REQUIRE(elapsed < 200);
}

TEST_CASE("build_event extracts only permitted fields") {
    std::string out = ap::build_event(
        R"({"tool_name":"Edit","tool_input":{"file_path":"/repo/src/a.py"},
            "session_id":"s1","content":"SECRET"})");
    REQUIRE(out.find("src/a.py") != std::string::npos);
    REQUIRE(out.find("SECRET") == std::string::npos);
    REQUIRE(out.find("\"verb\":\"edit\"") != std::string::npos);
}

TEST_CASE("unknown tools map to a think verb rather than being dropped") {
    std::string out = ap::build_event(R"({"tool_name":"Wibble","session_id":"s1"})");
    REQUIRE(out.find("\"verb\":\"think\"") != std::string::npos);
}
