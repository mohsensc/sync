// The daemon's field extractor is a file-local helper of the daemon binary, so
// the test compiles that translation unit with its main() switched off rather
// than growing a header for one function.
#define AP_DAEMON_NO_MAIN 1
#include "daemon/main.cpp"

#include <catch2/catch_test_macros.hpp>
#include <filesystem>
#include <fstream>
#include <string>

#include "hook/hook.hpp"

// The seam that broke: the hook escapes a path correctly, the daemon read it
// back by scanning for the next bare '"'. Every event for a path holding a
// quote was truncated on arrival and nothing anywhere said so.
TEST_CASE("a path round-trips from the hook through the daemon extractor") {
    // Quote, backslash, newline, non-ascii. Every one of them is a byte the
    // hook has to escape and the daemon has to put back.
    const std::string path = "/repo/a\"b\\c\nd\xc3\xbc" "ber.py";

    const std::string event = ap::build_event(
        R"({"tool_name":"Edit","tool_input":{"file_path":)"
        R"("/repo/a\"b\\c\nd\u00fcber.py"},"session_id":"s1"})");

    REQUIRE(ap::json_field(event, "path") == path);
    REQUIRE(ap::json_field(event, "agent") == "s1");
    REQUIRE(ap::json_field(event, "verb") == "edit");
}

// path sits last in the event, so a mis-parse there only truncates. A quote in
// the session id would swallow the rest of the object and lose path entirely.
TEST_CASE("a quote in an earlier field does not eat the fields after it") {
    const std::string event = ap::build_event(
        R"({"tool_name":"Read","tool_input":{"file_path":"/repo/x.py"},)"
        R"("session_id":"s\"1"})");

    REQUIRE(ap::json_field(event, "agent") == "s\"1");
    REQUIRE(ap::json_field(event, "path") == "/repo/x.py");
}

TEST_CASE("daemon extractor decodes the escapes json allows") {
    REQUIRE(ap::json_field(R"({"path":"a\/b"})", "path") == "a/b");
    REQUIRE(ap::json_field(R"({"path":"a\u0007b"})", "path") == "a\ab");
    REQUIRE(ap::json_field(R"({"path":"a\tb\rc\bd\fe"})", "path") == "a\tb\rc\bd\fe");
    // Surrogate pair, one 4-byte utf-8 sequence out.
    REQUIRE(ap::json_field(R"({"path":"\ud83d\ude80"})", "path") == "\xf0\x9f\x9a\x80");
}

TEST_CASE("a truncated or unterminated value yields nothing, not garbage") {
    REQUIRE(ap::json_field(R"({"path":"unterminated)", "path").empty());
    REQUIRE(ap::json_field(R"({"path":"trailing\)", "path").empty());
    REQUIRE(ap::json_field(R"({"path":"bad\u00)", "path").empty());
    REQUIRE(ap::json_field(R"({"verb":"read"})", "path").empty());
}

// ---------------------------------------------------------------------------
// Where the bearer token comes from
// ---------------------------------------------------------------------------
//
// `ap principals add` prints a token once and says: put it in
// ~/.config/agent-presence/token, or $AGENT_PRESENCE_TOKEN, on the machine that
// runs as this principal. That sentence was a promise nothing kept — the daemon
// read neither. These pin down the half the daemon owns.

namespace {

std::string write_token_file(const std::string& dir, const std::string& body) {
    std::filesystem::create_directories(dir + "/agent-presence");
    const std::string path = dir + "/agent-presence/token";
    std::ofstream f(path, std::ios::binary | std::ios::trunc);
    f << body;
    f.close();
    return path;
}

std::string scratch_dir(const std::string& leaf) {
    const std::string dir =
        (std::filesystem::temp_directory_path() / ("ap-tok-" + leaf)).string();
    std::error_code ec;
    std::filesystem::remove_all(dir, ec);
    std::filesystem::create_directories(dir);
    return dir;
}

}  // namespace

TEST_CASE("the environment token wins, and no file is read for it") {
    const std::string dir = scratch_dir("env");
    write_token_file(dir, "from-the-file\n");
    REQUIRE(discover_token("from-the-env", dir, "/nonexistent") == "from-the-env");
}

TEST_CASE("the token file is read when the environment is silent") {
    const std::string dir = scratch_dir("file");
    write_token_file(dir, "from-the-file\n");
    REQUIRE(discover_token("", dir, "/nonexistent") == "from-the-file");
}

TEST_CASE("XDG_CONFIG_HOME beats HOME, and HOME is the fallback") {
    const std::string xdg = scratch_dir("xdg");
    const std::string home = scratch_dir("home");
    write_token_file(xdg, "xdg-token\n");
    write_token_file(home + "/.config", "home-token\n");

    REQUIRE(discover_token("", xdg, home) == "xdg-token");
    REQUIRE(discover_token("", "", home) == "home-token");
}

TEST_CASE("a missing, empty or blank token file is simply no token") {
    const std::string dir = scratch_dir("blank");
    REQUIRE(discover_token("", dir, "").empty());       // nothing written yet
    write_token_file(dir, "");
    REQUIRE(discover_token("", dir, "").empty());
    write_token_file(dir, "   \n\t\n");
    REQUIRE(discover_token("", dir, "").empty());
}

TEST_CASE("only the first line of the token file is the token") {
    // The file is written by hand at least some of the time, and an editor that
    // leaves a trailing note below the secret should not make the secret wrong
    // in a way whose only symptom is a lost rung.
    const std::string dir = scratch_dir("firstline");
    write_token_file(dir, "the-token\n# minted 2026-08-08 by ap principals add\n");
    REQUIRE(discover_token("", dir, "") == "the-token");
}

TEST_CASE("surrounding whitespace comes off the token") {
    const std::string dir = scratch_dir("ws");
    write_token_file(dir, "  padded-token  \r\n");
    REQUIRE(discover_token("", dir, "") == "padded-token");
}

TEST_CASE("a token file too large to be a token is refused rather than read in") {
    // Anything can be at that path. A daemon that reads an arbitrarily large
    // file into memory because it was pointed at one is a daemon with a
    // denial-of-service in its startup path.
    const std::string dir = scratch_dir("huge");
    write_token_file(dir, std::string(64 * 1024, 'x'));
    REQUIRE(discover_token("", dir, "").empty());
}

TEST_CASE("truthy spellings of the unattended flag") {
    REQUIRE(env_is_true("1"));
    REQUIRE(env_is_true("true"));
    REQUIRE(env_is_true("TRUE"));
    REQUIRE(env_is_true("yes"));
    REQUIRE(env_is_true("on"));
    REQUIRE_FALSE(env_is_true(""));
    REQUIRE_FALSE(env_is_true("0"));
    REQUIRE_FALSE(env_is_true("false"));
    REQUIRE_FALSE(env_is_true("no"));
    // Not a guess either way: an unreadable value is the safer of the two,
    // which is attended, because attended is the quieter end of every band.
    REQUIRE_FALSE(env_is_true("maybe"));
}

// ---------------------------------------------------------------------------
// Where the decision journal goes
// ---------------------------------------------------------------------------
//
// The socket and the snapshot have had an override each since they existed.
// This one was a bare concatenation of the runtime dir and a fixed name, so two
// presenced on one box — one per repo, which is how anyone with two checkouts
// runs it — wrote every decision into the same file and `ap why` in one repo
// answered with the other repo's blocks.

TEST_CASE("the journal path falls back to the runtime directory") {
    REQUIRE(discover_journal("", "/run/user/501") ==
            "/run/user/501/agent-presence.decisions.jsonl");
}

TEST_CASE("AGENT_PRESENCE_JOURNAL moves the journal, like the sock and snapshot vars") {
    REQUIRE(discover_journal("/run/user/501/repo-a.jsonl", "/run/user/501") ==
            "/run/user/501/repo-a.jsonl");
}

TEST_CASE("two daemons sharing a runtime dir get two journals") {
    // The whole point. Distinct AGENT_PRESENCE_SOCK already gives them separate
    // sockets; without this they still shared the file behind `ap why`.
    const std::string runtime = "/run/user/501";
    REQUIRE(discover_journal("/run/user/501/a.jsonl", runtime) !=
            discover_journal("/run/user/501/b.jsonl", runtime));
}
