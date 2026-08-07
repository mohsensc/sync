#include <catch2/catch_test_macros.hpp>
#include <filesystem>
#include <fstream>
#include <sstream>
#include "daemon/snapshot.hpp"

static std::string read_all(const std::string& p) {
    std::ifstream f(p);
    std::ostringstream ss;
    ss << f.rdbuf();
    return ss.str();
}

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
    auto p = (std::filesystem::temp_directory_path() / "ap_atomic.json").string();
    for (int i = 0; i < 200; ++i) {
        ap::write_snapshot(p, {{"sara", "edit", "a.py"}});
        REQUIRE(read_all(p).back() == '}');
    }
}
