// A region changing hands, from the daemon down to the sentence a model reads.
//
// Three readers and three messages. The agent that is blocked needs a real
// number and a next step. The agent that holds the region needs to hear it has
// a deadline while it still has the region. The agent that lost the region
// needs to be told that is what happened and what to do with the work it has
// half-finished there.
//
// The one that was outright wrong before this cycle is the first. The hook
// printed the fixed string "their claim expires on its own within 90 seconds",
// which was true of a holder that had stopped working and false of every holder
// that had not — and the second kind is the entire reason anybody reads the
// sentence.

#include <catch2/catch_test_macros.hpp>

#include <string>

#include "daemon/contend_queue.hpp"
#include "daemon/decide.hpp"
#include "daemon/relay_client.hpp"
#include "daemon/lease_cache.hpp"
#include "hook/hook.hpp"

using ap::CachedLease;
using ap::Decision;
using ap::HandoverNote;
using ap::LeaseCache;

namespace {

constexpr const char* kPath = "/repo/src/pay.py";
constexpr const char* kKey = "/repo/src/pay.py|charge";

std::string ask(const char* agent) {
    return std::string(R"({"verb":"edit","agent":")") + agent + R"(","path":")" + kPath +
           R"(","want":"decision"})";
}

bool has(const std::string& haystack, const std::string& needle) {
    return haystack.find(needle) != std::string::npos;
}

CachedLease held_by(const char* agent, long long expires_at_ms) {
    CachedLease lease;
    lease.agent = agent;
    lease.human = "sara";
    lease.intent = "rewriting charge";
    lease.expires_at_ms = expires_at_ms;
    lease.priority = "normal";
    return lease;
}

}  // namespace

// -- the cache ---------------------------------------------------------------

TEST_CASE("a holder's own lease is found only when somebody is waiting on it") {
    LeaseCache c;
    c.replace({{kKey, held_by("a1", 90'000)}});
    REQUIRE_FALSE(c.own_handover(kPath, "a1", 0).has_value());

    CachedLease contended = held_by("a1", 90'000);
    contended.handover_at_ms = 60'000;
    contended.handover_to = "a2";
    c.replace({{kKey, contended}});

    const auto mine = c.own_handover(kPath, "a1", 0);
    REQUIRE(mine.has_value());
    REQUIRE(mine->handover_at_ms == 60'000);
    // And it is nobody else's business.
    REQUIRE_FALSE(c.own_handover(kPath, "a2", 0).has_value());
}

TEST_CASE("the soonest deadline in the file is the one reported") {
    LeaseCache c;
    CachedLease far = held_by("a1", 90'000);
    far.handover_at_ms = 80'000;
    CachedLease near = held_by("a1", 90'000);
    near.handover_at_ms = 20'000;
    c.replace({{"/repo/src/pay.py|refund", far}, {"/repo/src/pay.py|charge", near}});

    const auto mine = c.own_handover(kPath, "a1", 0);
    REQUIRE(mine.has_value());
    REQUIRE(mine->handover_at_ms == 20'000);
}

TEST_CASE("a handover note is remembered and then goes stale") {
    LeaseCache c;
    c.note_handover(kPath, HandoverNote{"a2", "sara", "critical", 1'000});

    REQUIRE(c.handover_note(kPath, 2'000, ap::kHandoverNoteMs).has_value());
    REQUIRE(c.handover_note(kPath, 1'000 + ap::kHandoverNoteMs + 1,
                            ap::kHandoverNoteMs)
                .has_value() == false);
    REQUIRE_FALSE(c.handover_note("/repo/other.py", 2'000, ap::kHandoverNoteMs).has_value());
}

// -- the daemon's answer -----------------------------------------------------

TEST_CASE("a blocked agent is told how long the lease actually has left") {
    LeaseCache c;
    c.replace({{kKey, held_by("a1", 47'000)}});

    const std::string out = ap::decide_response(ask("a2"), c, 0);
    REQUIRE(has(out, R"("rung":3)"));
    REQUIRE(has(out, R"("expires_in_ms":47000)"));
    // No deadline on an uncontended lease, so none on the wire.
    REQUIRE_FALSE(has(out, "handover_in_ms"));
}

TEST_CASE("a blocked agent is told when the region comes to it") {
    LeaseCache c;
    CachedLease lease = held_by("a1", 90'000);
    lease.handover_at_ms = 60'000;
    lease.handover_to = "a2";
    lease.handover_to_human = "kim";
    lease.waiting = 2;
    c.replace({{kKey, lease}});

    const std::string out = ap::decide_response(ask("a2"), c, 0);
    REQUIRE(has(out, R"("handover_in_ms":60000)"));
    REQUIRE(has(out, R"("handover_to":"a2")"));
    REQUIRE(has(out, R"("waiting":2)"));
}

TEST_CASE("a holder is warned on its own next edit") {
    LeaseCache c;
    CachedLease lease = held_by("a1", 90'000);
    lease.handover_at_ms = 60'000;
    lease.handover_to = "a2";
    lease.handover_to_human = "kim";
    lease.handover_to_priority = "critical";
    lease.waiting = 1;
    c.replace({{kKey, lease}});

    const std::string out = ap::decide_response(ask("a1"), c, 0);
    // Still rung 0 — nothing is blocked, it is the holder.
    REQUIRE(has(out, R"("rung":0)"));
    REQUIRE(has(out, R"("handover_in_ms":60000)"));
    REQUIRE(has(out, R"("handover_to_human":"kim")"));
    REQUIRE(has(out, R"("handover_to_priority":"critical")"));
}

TEST_CASE("an agent that lost a region is told so on its next edit there") {
    LeaseCache c;
    c.note_handover(kPath, HandoverNote{"a2", "kim", "critical", 1'000});

    const std::string out = ap::decide_response(ask("a1"), c, 41'000);
    REQUIRE(has(out, R"("rung":0)"));
    REQUIRE(has(out, R"("lost_to":"kim")"));
    REQUIRE(has(out, R"("lost_to_priority":"critical")"));
    REQUIRE(has(out, R"("lost_ms_ago":40000)"));
}

TEST_CASE("an ordinary rung 0 with nothing to report is unchanged") {
    LeaseCache c;
    const std::string out = ap::decide_response(ask("a1"), c, 0);
    REQUIRE(out == R"({"rung":0,"effect":"silent"})");
}

// -- the sentence ------------------------------------------------------------

TEST_CASE("the blocked message carries the real deadline, not a fixed 90 seconds") {
    Decision d;
    d.rung = 3;
    d.agent = "a2";
    d.holder = "a1";
    d.human = "sara";
    d.intent = "rewriting charge";
    d.expires_in_ms = 47'000;
    const std::string out = ap::hook_output(d, kPath);

    REQUIRE(has(out, "47 seconds"));
    REQUIRE_FALSE(has(out, "within 90 seconds"));
    // Who, what they are doing, and the four ways out. All still there.
    REQUIRE(has(out, "sara"));
    REQUIRE(has(out, "rewriting charge"));
    REQUIRE(has(out, "disjoint"));
    REQUIRE(has(out, R"("permissionDecision":"deny")"));
}

TEST_CASE("a blocked agent at the front of the queue is told to retry once") {
    Decision d;
    d.rung = 3;
    d.agent = "a2";
    d.holder = "a1";
    d.human = "sara";
    d.handover_in_ms = 60'000;
    d.handover_to = "a2";
    d.waiting = 1;
    const std::string out = ap::hook_output(d, kPath);

    REQUIRE(has(out, "60 seconds"));
    REQUIRE(has(out, "held for you"));
    REQUIRE(has(out, "do not poll"));
}

TEST_CASE("a blocked agent behind somebody else is told it is not next") {
    Decision d;
    d.rung = 3;
    d.agent = "a3";
    d.holder = "a1";
    d.human = "sara";
    d.handover_in_ms = 60'000;
    d.handover_to = "a2";
    d.handover_to_human = "kim";
    d.handover_to_priority = "critical";
    const std::string out = ap::hook_output(d, kPath);

    REQUIRE(has(out, "queued for kim (critical priority)"));
    REQUIRE(has(out, "not for you"));
    REQUIRE_FALSE(has(out, "held for you"));
}

TEST_CASE("a holder is warned in time and is not blocked") {
    Decision d;
    d.rung = 0;
    d.agent = "a1";
    d.handover_in_ms = 62'000;
    d.handover_to = "a2";
    d.handover_to_human = "kim";
    d.handover_to_priority = "critical";
    const std::string out = ap::hook_output(d, kPath);

    REQUIRE_FALSE(out.empty());
    REQUIRE(has(out, "additionalContext"));
    REQUIRE_FALSE(has(out, "permissionDecision"));
    REQUIRE(has(out, "kim (critical priority)"));
    REQUIRE(has(out, "62 seconds"));
    // The instruction, which is the whole point of warning early.
    REQUIRE(has(out, "commit"));
}

TEST_CASE("a preempted agent is told who took over and what to do with its work") {
    Decision d;
    d.rung = 0;
    d.agent = "a1";
    d.lost_to = "kim";
    d.lost_to_priority = "critical";
    d.lost_ms_ago = 40'000;
    const std::string out = ap::hook_output(d, kPath);

    REQUIRE_FALSE(out.empty());
    REQUIRE(has(out, "additionalContext"));
    REQUIRE(has(out, "kim (critical priority)"));
    REQUIRE(has(out, "took over"));
    REQUIRE(has(out, "40 seconds ago"));
    // The humane half: nothing was reverted, and here is what to do next.
    REQUIRE(has(out, "reverted"));
    REQUIRE(has(out, "branch"));
}

TEST_CASE("a rung 0 with nothing attached still prints nothing") {
    Decision d;
    d.rung = 0;
    d.agent = "a1";
    REQUIRE(ap::hook_output(d, kPath).empty());
}

TEST_CASE("durations read as a person would say them") {
    // Seconds while waiting is a thing you do, minutes once it is a thing you
    // work around. Never "0 seconds", never "863 seconds".
    Decision d;
    d.rung = 3;
    d.agent = "a2";
    d.holder = "a1";
    d.human = "sara";

    d.expires_in_ms = 400;
    REQUIRE(has(ap::hook_output(d, kPath), "1 second"));
    d.expires_in_ms = 1'000;
    REQUIRE(has(ap::hook_output(d, kPath), "1 second"));
    d.expires_in_ms = 90'000;
    REQUIRE(has(ap::hook_output(d, kPath), "90 seconds"));
    d.expires_in_ms = 863'000;
    REQUIRE(has(ap::hook_output(d, kPath), "15 minutes"));
}

TEST_CASE("a blocked agent that lost the region is told both halves") {
    // Told only that somebody else is editing it, an agent reads that about a
    // region that was its own a minute ago and cannot connect the two events.
    LeaseCache c;
    c.replace({{kKey, held_by("a2", 90'000)}});
    c.note_handover(kPath, HandoverNote{"a2", "kim", "critical", 1'000});

    const std::string out = ap::decide_response(ask("a1"), c, 41'000);
    REQUIRE(has(out, R"("rung":3)"));
    REQUIRE(has(out, R"("lost_to":"kim")"));
    REQUIRE(has(out, R"("lost_ms_ago":40000)"));

    Decision d = ap::parse_decision(out);
    d.agent = "a1";
    const std::string text = ap::hook_output(d, kPath);
    REQUIRE(has(text, "This was your region"));
    REQUIRE(has(text, "40 seconds ago"));
    REQUIRE(has(text, "reverted"));
    REQUIRE(has(text, R"("permissionDecision":"deny")"));
}

TEST_CASE("the agent at the front of the queue is not told to wait twice") {
    Decision d;
    d.rung = 3;
    d.agent = "a2";
    d.holder = "a1";
    d.human = "sara";
    d.handover_in_ms = 60'000;
    d.handover_to = "a2";
    const std::string out = ap::hook_output(d, kPath);

    REQUIRE(has(out, "do not poll"));
    // The generic list still offers the other three ways out, but not the one
    // the sentence above just gave a deadline for.
    REQUIRE_FALSE(has(out, "wait and retry"));
    REQUIRE(has(out, "disjoint"));
    REQUIRE(has(out, "proceed anyway"));
}

// -- the ask the hook path never made ----------------------------------------

TEST_CASE("a rung 3 answer is recognisable as a block, and nothing else is") {
    LeaseCache c;
    c.replace({{kKey, held_by("a1", 47'000)}});
    REQUIRE(ap::blocked_by_lease(ap::decide_response(ask("a2"), c, 0)));

    // The holder's own edit, an ambient rung 0, a non-edit and an empty answer
    // are all not asks.
    REQUIRE_FALSE(ap::blocked_by_lease(ap::decide_response(ask("a1"), c, 0)));
    REQUIRE_FALSE(ap::blocked_by_lease(R"({"rung":0,"effect":"silent"})"));
    REQUIRE_FALSE(ap::blocked_by_lease(""));
    // And it is the rung, not the effect: a room that softened rung 3 to
    // `notify` still has two agents on one region and the ask still counts.
    REQUIRE(ap::blocked_by_lease(R"({"rung":3,"effect":"notify","holder":"a1"})"));
}

TEST_CASE("the contend queue collapses repeats and is bounded") {
    ap::ContendQueue q;
    REQUIRE(q.drain().empty());

    q.note("/repo/a.py");
    q.note("/repo/a.py");
    q.note("/repo/b.py");
    q.note("");                       // nothing to say
    auto out = q.drain();
    REQUIRE(out.size() == 2);
    REQUIRE(out[0] == "/repo/a.py");
    REQUIRE(out[1] == "/repo/b.py");
    REQUIRE(q.drain().empty());       // draining takes

    for (std::size_t i = 0; i < ap::ContendQueue::kMax + 50; ++i) {
        q.note("/repo/f" + std::to_string(i) + ".py");
    }
    REQUIRE(q.drain().size() == ap::ContendQueue::kMax);
}

TEST_CASE("the contend frame names the whole file and takes no lease") {
    const std::string frame = ap::relay_contend_frame("/repo/src/pay.py");
    REQUIRE(has(frame, R"("type":"contend")"));
    REQUIRE(has(frame, R"("path":"/repo/src/pay.py")"));
    REQUIRE(has(frame, R"("symbol":null)"));
    // Not a claim. The daemon never takes a lease on an agent's behalf.
    REQUIRE_FALSE(has(frame, "claim"));
    REQUIRE(ap::relay_contend_frame("").empty());
}

TEST_CASE("a path with a quote in it still leaves as valid JSON") {
    const std::string frame = ap::relay_contend_frame(R"(/repo/a"b\c.py)");
    REQUIRE(has(frame, R"(/repo/a\"b\\c.py)"));
}
