// The daemon's field extractor is a file-local helper of the daemon binary, so
// the test compiles that translation unit with its main() switched off rather
// than growing a header for one function.
#define AP_DAEMON_NO_MAIN 1
#include "daemon/main.cpp"

#include <catch2/catch_test_macros.hpp>
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
