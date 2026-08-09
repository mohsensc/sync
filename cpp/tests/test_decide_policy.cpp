// What policy does and does not change about the daemon's answer.
//
// The line under test is §0 of the design: policy governs how loudly a rung is
// told, and never what the rung is. A room configured to say nothing about a
// collision still reports the collision on the wire — the lease table stays a
// truthful record and `ap why` can show what was seen as well as what was done.

#include <catch2/catch_test_macros.hpp>

#include <filesystem>
#include <fstream>
#include <string>

#include "daemon/decide.hpp"
#include "daemon/json.hpp"
#include "daemon/lease_cache.hpp"
#include "daemon/policy_cache.hpp"
#include "hook/hook.hpp"

namespace {

const std::string kEditPayload =
    R"({"session_id":"sess_b","hook_event_name":"PreToolUse","tool_name":"Edit",)"
    R"("tool_input":{"file_path":"/repo/src/auth.py"}})";

struct Held {
    ap::LeaseCache cache;
    Held() = default;
    explicit Held(const std::string& region) {
        cache.replace({{region, ap::CachedLease{"sess_a", "sara", "token refresh", 60'000}}});
    }
    operator const ap::LeaseCache&() const { return cache; }  // NOLINT
};

/// A PolicyCache holding the given five effects, loaded the way the real one
/// is: through a compiled cache file, not a back door.
class Loaded {
public:
    explicit Loaded(const std::string& table) {
        path_ = (std::filesystem::temp_directory_path() /
                 ("ap_decide_policy_" + std::to_string(++seq_) + ".json"))
                    .string();
        std::ofstream f(path_, std::ios::trunc);
        f << R"({"schema":1,"digest":"d","table":)" << table
          << R"(,"floor":["silent","silent","silent","notify","silent"]})";
        f.close();
        cache_.refresh(path_, 1000);
    }
    ~Loaded() {
        std::error_code ec;
        std::filesystem::remove(path_, ec);
    }
    operator const ap::PolicyCache&() const { return cache_; }  // NOLINT
    ap::PolicyCache& cache() { return cache_; }

private:
    static inline int seq_ = 0;
    std::string path_;
    ap::PolicyCache cache_;
};

std::string answer(const ap::LeaseCache& leases, const ap::PolicyCache& policy) {
    return ap::decide_response(ap::build_request(kEditPayload), leases, policy, 0);
}

}  // namespace

TEST_CASE("every answer carries an effect") {
    const Held empty;
    const Held collision("/repo/src/auth.py|");
    ap::PolicyCache defaults;

    REQUIRE(ap::json_field(answer(empty, defaults), "effect") == "silent");
    REQUIRE(ap::json_field(answer(collision, defaults), "effect") == "deny");

    // Including the answers to lines that asked nothing sensible.
    const std::string junk = ap::decide_response(R"({"want":"decision","agent":"x"})",
                                                 collision.cache, defaults, 0);
    REQUIRE(ap::json_field(junk, "effect") == "silent");
}

TEST_CASE("the rung is a fact and policy never moves it") {
    const Held collision("/repo/src/auth.py|");
    for (const char* table : {R"(["silent","silent","silent","silent","silent"])",
                              R"(["deny","deny","deny","deny","deny"])",
                              R"(["silent","notify","context","notify","silent"])"}) {
        const Loaded policy(table);
        const std::string reply = answer(collision, policy);
        INFO("table " << table << " gave " << reply);
        REQUIRE(ap::parse_decision(reply).rung == 3);
        // And the holder is still named, so the brief is renderable whatever
        // the effect turns out to be.
        REQUIRE(ap::json_field(reply, "holder") == "sess_a");
        REQUIRE(ap::json_field(reply, "intent") == "token refresh");
    }
}

TEST_CASE("a quiet rung 3 is still floored at notify on the wire") {
    const Held collision("/repo/src/auth.py|");
    const Loaded silent(R"(["silent","silent","silent","silent","silent"])");
    const std::string reply = answer(collision, silent);
    REQUIRE(ap::json_field(reply, "effect") == "notify");
    REQUIRE(ap::parse_decision(reply).rung == 3);
}

TEST_CASE("policy may raise a quiet rung, which the shipped defaults never do") {
    // Requirement 5 has two halves. Nothing shipped turns rungs 0-2 into an
    // interruption, and a policy that asks for one gets it.
    const Held empty;
    ap::PolicyCache defaults;
    REQUIRE(ap::json_field(answer(empty, defaults), "effect") == "silent");

    const Loaded loud(R"(["deny","deny","deny","deny","deny"])");
    REQUIRE(ap::json_field(answer(empty, loud), "effect") == "deny");
    REQUIRE(ap::parse_decision(answer(empty, loud)).rung == 0);
}

TEST_CASE("the legacy decision field appears exactly when the effect is ask") {
    const Held collision("/repo/src/auth.py|");

    const Loaded ask(R"(["silent","notify","context","ask","silent"])");
    const std::string asked = answer(collision, ask);
    REQUIRE(ap::json_field(asked, "effect") == "ask");
    // A hook built before effects existed reads this and nothing else.
    REQUIRE(ap::parse_decision(asked).decision == "ask");

    ap::PolicyCache defaults;
    const std::string denied = answer(collision, defaults);
    REQUIRE(ap::json_field(denied, "effect") == "deny");
    REQUIRE(ap::parse_decision(denied).decision.empty());
}

TEST_CASE("an org floor pushed by the relay tightens a local table") {
    const Held collision("/repo/src/auth.py|");
    Loaded local(R"(["silent","notify","context","notify","silent"])");
    REQUIRE(ap::json_field(answer(collision, local), "effect") == "notify");

    // Same cache, now with the floor the relay would push on an org change.
    ap::PolicyTable floor = ap::kBuiltinFloor;
    floor.rung[3] = ap::Effect::Deny;
    local.cache().set_floor(floor, "org:/etc/agent-presence/policy.toml");

    REQUIRE(ap::json_field(answer(collision, local), "effect") == "deny");
}

TEST_CASE("a one-way event still gets no reply at all") {
    ap::PolicyCache defaults;
    REQUIRE(ap::decide_response(ap::build_event(kEditPayload), ap::LeaseCache{}, defaults, 0)
                .empty());
}

TEST_CASE("the response is still one line under every effect") {
    ap::LeaseCache cache;
    cache.replace({{"/repo/src/auth.py|",
                    ap::CachedLease{"sess_a", "sara", "line one\nline \"two\"", 60'000}}});
    for (const char* table : {R"(["silent","silent","silent","ask","silent"])",
                              R"(["deny","deny","deny","deny","deny"])"}) {
        const Loaded policy(table);
        const std::string reply = ap::decide_response(ap::build_request(kEditPayload), cache,
                                                      policy, 0);
        INFO(reply);
        REQUIRE(reply.find('\n') == std::string::npos);
        REQUIRE(ap::parse_decision(reply).intent == "line one\nline \"two\"");
    }
}

TEST_CASE("the default overload answers exactly as the builtin table does") {
    // Step 4 of the plan has to be a no-op for anyone who configures nothing,
    // and this is the pair of calls that says so.
    const Held collision("/repo/src/auth.py|");
    ap::PolicyCache defaults;
    const std::string req = ap::build_request(kEditPayload);
    REQUIRE(ap::decide_response(req, collision.cache, 0) ==
            ap::decide_response(req, collision.cache, defaults, 0));
    REQUIRE(ap::decide_response(req, ap::LeaseCache{}, 0) ==
            ap::decide_response(req, ap::LeaseCache{}, defaults, 0));
}
