#include <catch2/catch_test_macros.hpp>
#include <cctype>
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

namespace {

/// Strict enough to catch what we care about: every quote opens or closes a
/// string, every backslash introduces a legal escape, no raw control bytes
/// inside a string. Malformed JSON is what makes the relay drop an event.
bool well_formed_json_object(const std::string& s) {
    if (s.size() < 2 || s.front() != '{' || s.back() != '}') return false;
    bool in_string = false;
    for (size_t i = 1; i + 1 < s.size(); ++i) {
        const unsigned char c = static_cast<unsigned char>(s[i]);
        if (!in_string) {
            if (c == '"') in_string = true;
            else if (c != ':' && c != ',') return false;  // our events are flat
            continue;
        }
        if (c == '"') { in_string = false; continue; }
        if (c < 0x20) return false;  // raw control byte inside a string
        if (c != '\\') continue;
        if (i + 1 >= s.size()) return false;
        const char e = s[++i];
        if (std::string("\"\\/bfnrt").find(e) != std::string::npos) continue;
        if (e != 'u') return false;
        if (i + 4 >= s.size()) return false;
        for (int k = 1; k <= 4; ++k) {
            if (!std::isxdigit(static_cast<unsigned char>(s[i + k]))) return false;
        }
        i += 4;
    }
    return !in_string;
}

}  // namespace

TEST_CASE("a path containing a double quote stays valid json") {
    const std::string out = ap::build_event(
        R"({"tool_name":"Read","tool_input":{"file_path":"/repo/a\"b.py"},"session_id":"s1"})");
    REQUIRE(well_formed_json_object(out));
    REQUIRE(out == R"({"verb":"read","agent":"s1","path":"/repo/a\"b.py"})");
}

TEST_CASE("a path containing a backslash stays valid json") {
    const std::string out = ap::build_event(
        R"({"tool_name":"Edit","tool_input":{"file_path":"C:\\work\\a.py"},"session_id":"s1"})");
    REQUIRE(well_formed_json_object(out));
    REQUIRE(out == R"({"verb":"edit","agent":"s1","path":"C:\\work\\a.py"})");
}

TEST_CASE("a path containing a newline stays valid json") {
    const std::string out = ap::build_event(
        R"({"tool_name":"Edit","tool_input":{"file_path":"/repo/we\nird.py"},"session_id":"s1"})");
    REQUIRE(well_formed_json_object(out));
    REQUIRE(out == R"({"verb":"edit","agent":"s1","path":"/repo/we\nird.py"})");
}

TEST_CASE("control characters and \\u escapes survive as escapes") {
    // \u0007 has no short form, so it has to come back out as \u0007.
    const std::string out = ap::build_event(
        R"({"tool_name":"Grep","tool_input":{"file_path":"/repo/a\u0007b.py"},"session_id":"s\t1"})");
    REQUIRE(well_formed_json_object(out));
    REQUIRE(out == R"({"verb":"search","agent":"s\t1","path":"/repo/a\u0007b.py"})");
}

TEST_CASE("\\u escapes are decoded to utf-8, not passed through") {
    // \u00fc is 0xc3 0xbc in utf-8, and a surrogate pair is one 4-byte sequence.
    // Passing the escape through would also be valid json, but then the path in
    // the event is not the path the daemon compares bytes against.
    const std::string out = ap::build_event(
        R"({"tool_name":"Write","tool_input":{"file_path":"/repo/\u00fcber\ud83d\ude80.py"},)"
        R"("session_id":"s1"})");
    REQUIRE(well_formed_json_object(out));
    REQUIRE(out == "{\"verb\":\"edit\",\"agent\":\"s1\",\"path\":\"/repo/"
                   "\xc3\xbc" "ber\xf0\x9f\x9a\x80.py\"}");
}
