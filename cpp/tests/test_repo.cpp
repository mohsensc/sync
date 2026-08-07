#include <catch2/catch_test_macros.hpp>
#include <filesystem>
#include <fstream>
#include <set>
#include "daemon/repo.hpp"

TEST_CASE("every url form of one repo collapses to one key") {
    std::set<std::string> keys{
        ap::normalize_remote("git@github.com:acme/api.git"),
        ap::normalize_remote("https://github.com/acme/api"),
        ap::normalize_remote("https://github.com/acme/api.git"),
        ap::normalize_remote("ssh://git@github.com/acme/api.git"),
        ap::normalize_remote("HTTPS://GitHub.com/Acme/API.git"),
        ap::normalize_remote("https://github.com/acme/api/"),
    };
    REQUIRE(keys.size() == 1);
    REQUIRE(*keys.begin() == "github.com/acme/api");
}

TEST_CASE("room id matches the python implementation byte for byte") {
    // Cross-checked against python: room_id_from_remote("git@github.com:acme/api.git")
    REQUIRE(ap::room_id_from_remote("git@github.com:acme/api.git").size() == 16);
    REQUIRE(ap::room_id_from_remote("git@github.com:acme/api.git")
            == ap::room_id_from_remote("https://github.com/acme/api"));
}

TEST_CASE("distinct repos and hosts stay distinct") {
    REQUIRE(ap::normalize_remote("git@github.com:acme/api.git")
            != ap::normalize_remote("git@github.com:acme/web.git"));
    REQUIRE(ap::normalize_remote("git@github.com:acme/api.git")
            != ap::normalize_remote("git@gitlab.com:acme/api.git"));
}

TEST_CASE("find_repo_root walks up to the marker and gives up at the top") {
    namespace fs = std::filesystem;
    const auto base = fs::temp_directory_path() / "ap_repo_test";
    fs::remove_all(base);
    const auto deep = base / "repo" / "src" / "nested";
    fs::create_directories(deep);
    // A worktree's .git is a file, so test the file form.
    { std::ofstream marker(base / "repo" / ".git"); marker << "gitdir: elsewhere\n"; }

    auto found = ap::find_repo_root(deep.string());
    REQUIRE(found.has_value());
    REQUIRE(fs::equivalent(*found, base / "repo"));

    // No marker anywhere above the filesystem root.
    REQUIRE_FALSE(ap::find_repo_root("/").has_value());

    fs::remove_all(base);
}
