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

// ===========================================================================
// ...and what the hook does with it
// ===========================================================================
//
// Everything above this line is the daemon half, and it was already right:
// decide.cpp resolves the effect and puts it on the wire. The hook threw it
// away. `Decision` had no `effect` member, `parse_decision` never looked for
// one, and `hook_output` keyed the whole rendering off `rung >= 3`.
//
// So every `[effects]` table on the machine was decorative. Quieting rung 3 to
// `notify` denied the edit anyway while `ap why` reported the quiet effect;
// raising rung 0 or 1 to `deny` produced nothing at all. `ask` worked, and only
// by accident, through the legacy `decision` field.

namespace {

/// What ended up on stdout, named rather than matched on. Three channels and
/// nothing, which is the whole of what a PreToolUse hook can do.
std::string channel(const std::string& out) {
    if (out.empty()) return "nothing";
    if (out.find(R"("permissionDecision":"deny")") != std::string::npos) return "deny";
    if (out.find(R"("permissionDecision":"ask")") != std::string::npos) return "ask";
    if (out.find(R"("additionalContext")") != std::string::npos) return "context";
    return "unrecognised: " + out;
}

/// The whole chain, wired the way run_hook wires it: the daemon's answer, the
/// hook's parser, the hook's renderer.
std::string rendered(const ap::LeaseCache& leases, const ap::PolicyCache& policy) {
    return ap::hook_output(ap::parse_decision(answer(leases, policy)), "/repo/src/auth.py");
}

std::string rendered_line(const std::string& line) {
    return channel(ap::hook_output(ap::parse_decision(line), "/repo/src/auth.py"));
}

}  // namespace

TEST_CASE("every effect picks its channel, at every rung") {
    struct Case {
        const char* effect;
        const char* expected;
    };
    // silent and notify both print nothing on the hook — notify is a statusline
    // and peer-list effect, see docs/policy-design.md §1.
    const Case cases[] = {{"silent", "nothing"}, {"notify", "nothing"},
                          {"context", "context"}, {"ask", "ask"},
                          {"deny", "deny"}};

    for (int rung = 0; rung <= 4; ++rung) {
        for (const Case& c : cases) {
            ap::Decision d;
            d.rung = rung;
            d.effect = c.effect;
            d.holder = "sess_a";
            d.human = "sara";
            d.intent = "token refresh";
            INFO("rung " << rung << " effect " << c.effect);
            REQUIRE(channel(ap::hook_output(d, "/repo/src/auth.py")) == c.expected);
        }
    }
}

TEST_CASE("a room that quiets rung 3 gets a quiet hook, end to end") {
    const Held collision("/repo/src/auth.py|");

    for (const char* quiet : {R"(["silent","notify","context","silent","context"])",
                              R"(["silent","notify","context","notify","context"])"}) {
        const Loaded policy(quiet);
        INFO(quiet << " -> " << rendered(collision, policy));
        // Note the daemon still answers rung 3 with a holder on it. The
        // collision happened; the room chose not to spend the agent on it.
        REQUIRE(ap::parse_decision(answer(collision, policy)).rung == 3);
        REQUIRE(channel(rendered(collision, policy)) == "nothing");
    }

    const Loaded ctx(R"(["silent","notify","context","context","context"])");
    REQUIRE(channel(rendered(collision, ctx)) == "context");
    // Told, not stopped: the message has to say so.
    REQUIRE(rendered(collision, ctx).find("Nothing is blocked") != std::string::npos);
    REQUIRE(rendered(collision, ctx).find("sara") != std::string::npos);

    const Loaded ask(R"(["silent","notify","context","ask","context"])");
    REQUIRE(channel(rendered(collision, ask)) == "ask");

    ap::PolicyCache defaults;
    REQUIRE(channel(rendered(collision, defaults)) == "deny");
    REQUIRE(rendered(collision, defaults).find("token refresh") != std::string::npos);
}

TEST_CASE("a room that raises a quiet rung gets a hook that stops, end to end") {
    const Held empty;

    ap::PolicyCache defaults;
    REQUIRE(channel(rendered(empty, defaults)) == "nothing");  // nothing shipped does this

    const Loaded ask(R"(["ask","notify","context","deny","context"])");
    REQUIRE(channel(rendered(empty, ask)) == "ask");

    const Loaded deny(R"(["deny","notify","context","deny","context"])");
    REQUIRE(channel(rendered(empty, deny)) == "deny");
    // Nobody is in the region, so nobody gets blamed for it. A message naming
    // "another agent" would send a model looking for one that is not there.
    const std::string out = rendered(empty, deny);
    REQUIRE(out.find("another agent") == std::string::npos);
    REQUIRE(out.find("effect table") != std::string::npos);

    const Loaded ctx(R"(["context","notify","context","deny","context"])");
    REQUIRE(channel(rendered(empty, ctx)) == "context");
}

TEST_CASE("the hook floors the effect it is handed") {
    // Anything on this box can write to that socket, so what arrives is the
    // room's opinion and not an instruction.
    ap::Decision d;
    d.rung = 3;
    d.effect = "silent";
    REQUIRE(std::string(ap::effect_name(ap::effect_of(d))) == "notify");

    d.rung = 0;
    REQUIRE(std::string(ap::effect_name(ap::effect_of(d))) == "silent");

    // A rung past the end of the table is floored, not indexed out of bounds.
    d.rung = 99;
    d.effect = "context";
    REQUIRE(std::string(ap::effect_name(ap::effect_of(d))) == "context");
}

TEST_CASE("a daemon that sends no effect is read exactly as it always was") {
    // The one thing that must not change: this daemon still ships, and the
    // legacy `decision` field is the only thing it can express an `ask` with.
    REQUIRE(rendered_line(R"({"rung":3,"holder":"sess_a","human":"sara"})") == "deny");
    REQUIRE(rendered_line(R"({"rung":3,"decision":"ask","holder":"sess_a"})") == "ask");
    REQUIRE(rendered_line(R"({"rung":2,"holder":"sess_a"})") == "context");
    REQUIRE(rendered_line(R"({"rung":1,"holder":"sess_a"})") == "context");
    REQUIRE(rendered_line(R"({"rung":0})") == "nothing");
    REQUIRE(rendered_line("") == "nothing");
}

TEST_CASE("an effect name the hook does not know falls back rather than opening up") {
    // A cache written by a newer `ap` with a sixth effect in it, or a line
    // written by something that is not a daemon at all.
    REQUIRE(rendered_line(R"({"rung":3,"effect":"loud","holder":"sess_a"})") == "deny");
    REQUIRE(rendered_line(R"({"rung":3,"effect":"","holder":"sess_a"})") == "deny");
    REQUIRE(rendered_line(R"({"rung":3,"effect":"loud","decision":"ask","holder":"a"})") ==
            "ask");
    REQUIRE(rendered_line(R"({"rung":0,"effect":"loud"})") == "nothing");
}

TEST_CASE("a silent effect does not swallow the notices about an agent's own lease") {
    // These are not a policy effect. They are the daemon telling one agent what
    // happened to a region it holds, on the only channel that reaches it, and
    // the shipped table has rung 0 at `silent`.
    ap::Decision d;
    d.rung = 0;
    d.effect = "silent";
    d.handover_in_ms = 30'000;
    d.handover_to = "sess_c";
    d.handover_to_human = "mira";
    REQUIRE(channel(ap::hook_output(d, "/repo/src/auth.py")) == "context");
    REQUIRE(ap::hook_output(d, "/repo/src/auth.py").find("mira") != std::string::npos);

    ap::Decision lost;
    lost.rung = 0;
    lost.effect = "silent";
    lost.lost_to = "mira";
    lost.lost_ms_ago = 12'000;
    REQUIRE(channel(ap::hook_output(lost, "/repo/src/auth.py")) == "context");

    // And a plain rung 0 with neither is still silent.
    ap::Decision quiet;
    quiet.rung = 0;
    quiet.effect = "silent";
    REQUIRE(channel(ap::hook_output(quiet, "/repo/src/auth.py")) == "nothing");
}
