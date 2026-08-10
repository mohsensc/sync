"""What the room is told when a region changes hands.

Three readers, three different needs, and before this cycle all three got the
same thing: nothing useful.

The holder needs to know its lease has a deadline *while it still has the
region*, so it can finish, commit, or hand off deliberately. It used to find out
by having the lease vanish.

The waiter needs a number. "wait" with no number is not an instruction — an
agent has no way to tell "try again in a moment" from "this is never coming",
so it either spins or gives up, and both were correct answers.

Everyone else needs to know the region moved rather than merely lapsed, and to
whom, so a stale cache does not go on blocking edits on a lease nobody holds.
"""

from __future__ import annotations

import pytest

from agent_presence.clock import VirtualClock
from agent_presence.leases import (
    FAIR_SHARE_GRACE_S,
    HANDOVER_GRACE_S,
    HEARTBEAT_S,
    RESERVATION_S,
)
from agent_presence.principals import Principal, Roster, hash_token
from agent_presence.priority import PRIORITY_NAMES
from agent_presence.relay import Relay

ROOM = "r1"
TOKEN = "s3cret"
REGION = {"path": "src/pay.py", "symbol": "charge", "lines": None}
CRITICAL = PRIORITY_NAMES["critical"]


class FakeConn:
    def __init__(self, agent, human, principal=None, token=None):
        self.agent, self.human, self.room = agent, human, None
        self.principal, self.token, self.unattended = principal, token, False
        self.sent: list[dict] = []

    def send(self, payload: dict) -> None:
        self.sent.append(payload)

    def leases(self, state: str | None = None) -> list[dict]:
        return [
            f for f in self.sent
            if f.get("type") == "lease" and (state is None or f["state"] == state)
        ]


def roster() -> Roster:
    return Roster(
        (Principal(id="sara", display="Sara", attended=CRITICAL,
                   unattended=CRITICAL, token_sha256=hash_token(TOKEN)),),
        present=True, source="<test>",
    )


@pytest.fixture
def room():
    clock = VirtualClock(1000.0)
    relay = Relay(clock, roster=roster())
    holder = FakeConn("junior", "dev")
    senior = FakeConn("senior", "sara", principal="sara", token=TOKEN)
    relay.join(ROOM, holder)
    relay.join(ROOM, senior)
    return clock, relay, holder, senior


def claim(relay, conn, intent="work", region=REGION):
    return relay.handle(
        conn, {"type": "claim", "region": region, "intent": intent}
    )


def run_out(clock, relay, agent, until):
    while clock.now() < until:
        clock.advance(min(HEARTBEAT_S, until - clock.now()))
        relay.registry.heartbeat(ROOM, agent, _region())


def _region():
    from agent_presence.types import Region
    return Region(path=REGION["path"], symbol=REGION["symbol"], lines=None)


# -- the holder is warned, in time -------------------------------------------


def test_the_holder_hears_about_the_deadline_on_the_ask(room):
    clock, relay, holder, senior = room
    claim(relay, holder)
    holder.sent.clear()

    claim(relay, senior, "hotfix")

    notice = holder.leases("held")[-1]
    assert notice["agent"] == "junior", "the warning goes to the holder"
    assert notice["handover_in_ms"] == pytest.approx(
        HANDOVER_GRACE_S * 1000, rel=0.01
    )
    assert notice["handover_to"] == "senior"
    assert notice["handover_to_human"] == "sara"
    assert notice["handover_to_priority"] == "critical"
    assert notice["waiting"] == 1


def test_the_warning_arrives_immediately_not_at_the_next_heartbeat(room):
    # The first contention on a fresh lease usually leaves `expires_at` exactly
    # where it was — the deadline is a TTL away and so is the expiry — so a diff
    # keyed on expiry alone stayed quiet and the holder learned at its next
    # heartbeat, thirty seconds into ninety.
    clock, relay, holder, senior = room
    claim(relay, holder)
    before = relay.registry.holder_of(ROOM, _region()).expires_at
    holder.sent.clear()

    claim(relay, senior, "hotfix")

    assert relay.registry.holder_of(ROOM, _region()).expires_at == before
    assert holder.leases("held"), "the holder was told nothing"


def test_the_warning_goes_to_the_holder_and_not_to_the_room(room):
    # It is about work only the holder has, and no other daemon's cache changes
    # by a byte. Broadcasting it cost 50% more fan-out on the 200-agent run for
    # one notice per contention that 199 daemons then discarded.
    clock, relay, holder, senior = room
    bystander = FakeConn("bystander", "kim")
    relay.join(ROOM, bystander)

    claim(relay, holder)
    holder.sent.clear()
    bystander.sent.clear()

    claim(relay, senior, "hotfix")

    assert holder.leases("held"), "the holder was not warned"
    assert bystander.leases() == [], "the room was told the holder's business"


def test_a_real_lease_change_still_goes_to_everybody(room):
    # The routing above must not turn into "the room stops hearing about
    # leases". Anything the rest of the room caches — a new lease, a renewal, a
    # changed intent — is still a broadcast.
    clock, relay, holder, senior = room
    bystander = FakeConn("bystander", "kim")
    relay.join(ROOM, bystander)
    bystander.sent.clear()

    claim(relay, holder)
    assert [f["state"] for f in bystander.leases()] == ["held"]

    clock.advance(30.0)
    bystander.sent.clear()
    claim(relay, holder)                        # a renewal
    assert [f["state"] for f in bystander.leases()] == ["held"]


def test_an_uncontended_lease_carries_no_handover_fields(room):
    _clock, relay, holder, _senior = room
    claim(relay, holder)
    for frame in holder.leases() + [f for f in holder.sent
                                    if f.get("type") == "claim_result"]:
        assert "handover_at" not in frame
        assert "handover_to" not in frame


def test_the_holder_is_told_who_takes_over_and_that_it_was_kept(room):
    clock, relay, holder, senior = room
    claim(relay, holder)
    claim(relay, senior, "hotfix")
    holder.sent.clear()

    run_out(clock, relay, "junior", until=1000.0 + HANDOVER_GRACE_S + 0.5)
    # Anything at all makes the relay notice the lease ran down.
    relay.handle(senior, {"type": "heartbeat", "region": REGION})

    handover = holder.leases("handover")
    assert handover, "the region vanished with no explanation"
    frame = handover[-1]
    assert frame["from"] == "junior"
    assert frame["to"] == "senior"
    assert frame["to_human"] == "sara"
    assert frame["to_priority"] == "critical"
    # How long the ex-holder has before the region is up for grabs again, and
    # how long the winner waited — the two facts that make this a handover
    # rather than an unexplained loss.
    assert frame["reserved_for_ms"] == pytest.approx(
        RESERVATION_S * 1000, rel=0.01
    )
    assert frame["waited_s"] == pytest.approx(HANDOVER_GRACE_S, rel=0.01)


def test_a_lease_that_merely_lapsed_is_not_called_a_handover(room):
    clock, relay, holder, senior = room
    claim(relay, holder)
    holder.sent.clear()
    clock.advance(1000.0)
    relay.handle(senior, {"type": "heartbeat", "region": REGION})

    assert holder.leases("handover") == []
    assert holder.leases("expired")


# -- the waiter gets a number ------------------------------------------------


def test_a_wait_verdict_says_when(room):
    _clock, relay, holder, senior = room
    claim(relay, holder)

    refused = claim(relay, senior, "hotfix")
    assert refused["granted"] is False
    assert refused["decision"] == "wait"
    assert refused["held_by"] == "junior"
    assert refused["intent"] == "work"
    assert refused["handover_in_ms"] == pytest.approx(
        HANDOVER_GRACE_S * 1000, rel=0.01
    )
    # Come back once, at this time, and the region will be kept for you.
    assert refused["retry_in_ms"] == refused["handover_in_ms"]
    assert refused["reserved_for_ms"] == int(RESERVATION_S * 1000)
    # Named even when it is you, so a reader tells the two cases apart by
    # comparing a field rather than by noticing an absent one.
    assert refused["handover_to"] == "senior"


def test_an_abort_verdict_also_says_when(room):
    # The junior loses wait-die against a critical holder, but its ask still
    # caps the holder on the fair-share grace. Telling it "abort" and nothing
    # else is what made that bound invisible.
    _clock, relay, holder, senior = room
    claim(relay, senior, "long haul")
    refused = claim(relay, holder, "work")

    assert refused["decision"] == "abort"
    assert refused["handover_in_ms"] == pytest.approx(
        FAIR_SHARE_GRACE_S * 1000, rel=0.01
    )
    assert refused["retry_in_ms"] == refused["handover_in_ms"]


def test_a_waiter_behind_somebody_else_is_told_who_is_ahead(room):
    _clock, relay, holder, senior = room
    third = FakeConn("third", "kim")
    relay.join(ROOM, third)

    claim(relay, holder)
    claim(relay, senior, "hotfix")
    refused = relay.handle(
        third, {"type": "claim", "region": REGION, "intent": "also"}
    )

    assert refused["handover_to"] == "senior"
    assert refused["handover_to_priority"] == "critical"
    assert refused["waiting"] == 2
    # No retry deadline: the region is not coming to this agent.
    assert "retry_in_ms" not in refused


def test_a_claim_against_a_reserved_region_says_it_is_reserved_not_held(room):
    clock, relay, holder, senior = room
    claim(relay, holder)
    claim(relay, senior, "hotfix")
    run_out(clock, relay, "junior", until=1000.0 + HANDOVER_GRACE_S + 0.5)

    refused = claim(relay, holder, "work")
    assert refused["granted"] is False
    assert refused["reserved"] is True
    assert refused["held_by"] == "senior"
    assert refused["reserved_from"] == "junior"
    assert refused["decision"] == "wait", "never abort over a 10 second queue"
    assert 0 < refused["retry_in_ms"] <= RESERVATION_S * 1000


# -- the negotiation path ----------------------------------------------------


def _edit(relay, conn):
    return relay.handle(conn, {
        "type": "event", "verb": "edit", "source": "hook", "region": REGION,
    })


def test_a_rung_three_negotiate_frame_carries_the_deadline(room):
    _clock, relay, holder, senior = room
    claim(relay, holder, "rewriting charge")
    # Rung 3 is two agents writing the same region, so the holder has to have
    # been seen editing it. Same shape as the golden scenario.
    _edit(relay, holder)

    reply = relay.handle(senior, {
        "type": "event", "verb": "edit", "source": "hook", "region": REGION,
    })
    assert reply["type"] == "negotiate"
    assert reply["rung"] == 3
    assert reply["holder_agent"] == "junior"
    assert reply["handover_in_ms"] == pytest.approx(
        HANDOVER_GRACE_S * 1000, rel=0.01
    )
    assert reply["handover_to"] == "senior"
    assert reply["retry_in_ms"] == reply["handover_in_ms"]


def test_the_hook_path_starts_the_clock_the_same_way_a_claim_does(room):
    # An agent blocked at rung 3 never sends a claim frame. Before this it could
    # be blocked a hundred times an hour and never have asked for anything.
    clock, relay, holder, senior = room
    claim(relay, holder, "rewriting charge")
    _edit(relay, holder)
    _edit(relay, senior)

    run_out(clock, relay, "junior", until=1000.0 + HANDOVER_GRACE_S + 0.5)
    assert claim(relay, senior, "hotfix")["granted"] is True


# -- the hook path's ask -----------------------------------------------------
#
# The gap that made all of the above unreachable where it matters. A PreToolUse
# edit is answered by the local daemon out of its lease cache — no relay round
# trip, which is what keeps it inside 2 ms — and a *blocked* edit produces no
# PostToolUse, so the relay never heard that anybody wanted the region. An agent
# could be refused the same region every minute for an hour and the holder's
# lease would still be renewing with no deadline on it. The daemon now sends a
# `contend` frame when it stops an edit; see cpp/daemon/contend_queue.hpp.


def test_a_contend_frame_starts_the_clock_without_taking_anything(room):
    _clock, relay, holder, senior = room
    claim(relay, holder, "rewriting charge")
    assert relay.registry.holder_of(ROOM, _region()).handover_at is None

    relay.handle(senior, {"type": "contend", "region": REGION})

    held = relay.registry.holder_of(ROOM, _region())
    assert held.agent == "junior", "contending must never take the lease"
    assert held.handover_at == pytest.approx(1000.0 + HANDOVER_GRACE_S)
    assert held.handover_winner().agent == "senior"


def test_a_contend_frame_is_answered_with_the_lease_that_blocked_it(room):
    _clock, relay, holder, senior = room
    claim(relay, holder, "rewriting charge")
    senior.sent.clear()

    relay.handle(senior, {"type": "contend", "region": REGION})

    answer = senior.leases("held")
    assert answer, "the blocked agent was told nothing to cache"
    assert answer[-1]["agent"] == "junior"
    assert answer[-1]["handover_in_ms"] > 0
    assert answer[-1]["handover_to"] == "senior"


def test_contending_a_free_region_answers_nothing_and_takes_nothing(room):
    _clock, relay, _holder, senior = room
    senior.sent.clear()
    assert relay.handle(senior, {"type": "contend", "region": REGION}) is None
    assert senior.leases() == []
    assert relay.registry.active_claims(ROOM) == []


def test_contending_your_own_region_is_not_an_ask(room):
    _clock, relay, holder, _senior = room
    claim(relay, holder)
    relay.handle(holder, {"type": "contend", "region": REGION})
    assert relay.registry.holder_of(ROOM, _region()).handover_at is None


def test_a_contend_frame_cannot_name_somebody_elses_agent(room):
    # Same rule as every other frame: identity comes off the connection.
    _clock, relay, holder, senior = room
    claim(relay, holder)
    relay.handle(senior, {"type": "contend", "region": REGION,
                          "agent": "presenced@somebody-else"})
    assert relay.registry.holder_of(ROOM, _region()).handover_winner().agent == "senior"


def test_a_contend_frame_with_no_usable_region_is_dropped(room):
    _clock, relay, holder, senior = room
    claim(relay, holder)
    assert relay.handle(senior, {"type": "contend"}) is None
    assert relay.registry.holder_of(ROOM, _region()).handover_at is None
