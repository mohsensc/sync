// The daemon's side of the wire format in hook/hook.hpp, as a pure function.
// tests/test_decision_path.cpp then runs the same thing over a real socket.

#include <catch2/catch_test_macros.hpp>
#include <string>

#include "daemon/decide.hpp"
#include "daemon/json.hpp"
#include "daemon/lease_cache.hpp"
#include "hook/hook.hpp"

namespace {

const std::string kEditPayload =
    R"({"session_id":"sess_b","hook_event_name":"PreToolUse","tool_name":"Edit",)"
    R"("tool_input":{"file_path":"/repo/src/auth.py","old_string":"SECRET"}})";

/// A cache with one lease in it, returned by value.
///
/// The wrapper exists because LeaseCache owns a mutex and so cannot be copied
/// or moved; a prvalue of this is constructed in place at the call site and
/// converts to the reference decide_response asks for.
struct Held {
    ap::LeaseCache cache;

    Held(const std::string& region, const ap::CachedLease& lease) {
        cache.replace({{region, lease}});
    }

    operator const ap::LeaseCache&() const { return cache; }  // NOLINT(google-explicit-constructor)
};

Held held_by(const std::string& region, const std::string& agent, long long expires,
             const std::string& intent = "rewriting the token refresh") {
    return Held(region, ap::CachedLease{agent, "sara", intent, expires});
}

}  // namespace

TEST_CASE("only a line carrying the want marker is a question") {
    REQUIRE(ap::wants_decision_line(ap::build_request(kEditPayload)));
    REQUIRE_FALSE(ap::wants_decision_line(ap::build_event(kEditPayload)));
    REQUIRE_FALSE(ap::wants_decision_line(""));
    REQUIRE_FALSE(ap::wants_decision_line("garbage"));
    // A one-way event gets no reply at all, not an empty one.
    REQUIRE(ap::decide_response(ap::build_event(kEditPayload), ap::LeaseCache{}, 0).empty());
}

TEST_CASE("a held region answers rung 3 with the holder and their intent") {
    const auto leases = held_by("/repo/src/auth.py|", "sess_a", 60'000);
    const std::string reply = ap::decide_response(ap::build_request(kEditPayload), leases, 0);

    // Parsed with the hook's own parser: agreeing with a hand-written string is
    // not the same as agreeing with the other half of the protocol.
    const ap::Decision d = ap::parse_decision(reply);
    REQUIRE(d.rung == 3);
    REQUIRE(d.holder == "sess_a");
    REQUIRE(d.human == "sara");
    REQUIRE(d.intent == "rewriting the token refresh");
    REQUIRE(ap::hook_output(d, "/repo/src/auth.py").find(R"("permissionDecision":"deny")") !=
            std::string::npos);
}

// The reconciliation bug this pair exists for. A hook request names a path and
// no symbol, and types.py's same_region says a whole-file region contends with
// every symbol inside that path. An exact lookup on "path|" misses a claim on
// "path|sign_in" and allows an edit the relay calls a collision.
TEST_CASE("a symbol-level claim still blocks a whole-file edit") {
    const auto leases = held_by("/repo/src/auth.py|sign_in", "sess_a", 60'000);
    REQUIRE(ap::parse_decision(ap::decide_response(ap::build_request(kEditPayload), leases, 0))
                .rung == 3);
}

TEST_CASE("a claim on another file is not a conflict") {
    const auto leases = held_by("/repo/src/other.py|", "sess_a", 60'000);
    REQUIRE(ap::parse_decision(ap::decide_response(ap::build_request(kEditPayload), leases, 0))
                .rung == 0);
}

TEST_CASE("an expired claim never blocks, which is the fail-open default") {
    const auto leases = held_by("/repo/src/auth.py|", "sess_a", 60'000);
    const ap::Decision d =
        ap::parse_decision(ap::decide_response(ap::build_request(kEditPayload), leases, 90'000));
    REQUIRE(d.rung == 0);
    REQUIRE(ap::hook_output(d, "/repo/src/auth.py").empty());
}

TEST_CASE("an agent is never blocked by its own claim") {
    const auto leases = held_by("/repo/src/auth.py|", "sess_b", 60'000);
    REQUIRE(ap::parse_decision(ap::decide_response(ap::build_request(kEditPayload), leases, 0))
                .rung == 0);
}

TEST_CASE("an empty cache answers rung 0, and rung 0 prints nothing") {
    const std::string reply = ap::decide_response(ap::build_request(kEditPayload), ap::LeaseCache{}, 0);
    REQUIRE_FALSE(reply.empty());  // an answer, so a working daemon is visible on the wire
    const ap::Decision d = ap::parse_decision(reply);
    REQUIRE(d.rung == 0);
    REQUIRE(ap::hook_output(d, "/repo/src/auth.py").empty());
}

TEST_CASE("a hostile intent cannot break the response line") {
    const auto leases =
        held_by("/repo/src/auth.py|", "sess_a", 60'000, "line one\nline \"two\"\\ here");
    const std::string reply = ap::decide_response(ap::build_request(kEditPayload), leases, 0);

    // One line, or the hook reads half of it and the rest as a second response.
    REQUIRE(reply.find('\n') == std::string::npos);
    REQUIRE(ap::parse_decision(reply).intent == "line one\nline \"two\"\\ here");
}

TEST_CASE("a path with a quote in it matches the claim on that same path") {
    const std::string payload =
        R"({"session_id":"sess_b","hook_event_name":"PreToolUse","tool_name":"Write",)"
        R"("tool_input":{"file_path":"/repo/a\"b.py"}})";
    const auto leases = held_by("/repo/a\"b.py|", "sess_a", 60'000);
    REQUIRE(ap::parse_decision(ap::decide_response(ap::build_request(payload), leases, 0)).rung ==
            3);
}

// Anything on the machine can write to that socket. A line that claims to want
// a decision but names no file, or names a verb that cannot contend, gets an
// answer that blocks nothing rather than a lookup on an empty key.
TEST_CASE("a junk request is answered, and answered harmlessly") {
    const auto leases = held_by("|", "sess_a", 60'000);
    REQUIRE(ap::parse_decision(
                ap::decide_response(R"({"want":"decision","agent":"x"})", leases, 0)).rung == 0);
    REQUIRE(ap::parse_decision(
                ap::decide_response(R"({"verb":"read","path":"/repo/src/auth.py",)"
                                    R"("agent":"x","want":"decision"})",
                                    held_by("/repo/src/auth.py|", "sess_a", 60'000), 0))
                .rung == 0);
}

TEST_CASE("conflict_for_file only matches whole path segments") {
    ap::LeaseCache c;
    c.replace({{"/repo/src/auth.pyc|", ap::CachedLease{"sess_a", "sara", "x", 60'000}}});
    // "/repo/src/auth.py" is a prefix of "/repo/src/auth.pyc" as a string, but
    // the separator is what makes it a path match and there isn't one here.
    REQUIRE_FALSE(c.conflict_for_file("/repo/src/auth.py", "sess_b", 0).has_value());
    REQUIRE(c.conflict_for_file("/repo/src/auth.pyc", "sess_b", 0).has_value());
}
