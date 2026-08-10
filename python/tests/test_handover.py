"""A wait has an end, and the agents on both sides of it are told when.

Before this, `wait` meant "wait indefinitely". Every claim frame from the holder
reset its expiry to now + 90 s, and presenced sends one every 30 s, so a holder
that was still working renewed forever. docs/policy-design.md said "the senior
waits out at most one 90 s TTL and then wins, and keeps winning" and that was
false for every holder that had not already walked away — which is to say, for
the entire contention case. Measured on the branch this replaces: a critical,
roster-authenticated requester asking every five seconds for eight virtual hours
got 5760 refusals and zero grants.

The bound is not preemption. Nothing is taken from a holder mid-edit. Asking for
a region *caps the holder's renewals* — one TTL if the asker outranks it, fifteen
minutes if it does not — and when the cap is reached the lease ends the ordinary
way and the region is kept for the agent that waited.
"""

from __future__ import annotations

import pytest

from agent_presence.clock import VirtualClock
from agent_presence.leases import (
    FAIR_SHARE_GRACE_S,
    HANDOVER_GRACE_S,
    HEARTBEAT_S,
    LEASE_TTL_S,
    RESERVATION_S,
    LeaseRegistry,
)
from agent_presence.priority import PRIORITY_NAMES
from agent_presence.types import Region

ROOM = "r1"
R = Region(path="src/pay.py", symbol="charge", lines=None)
OTHER = Region(path="src/db.py", symbol="query", lines=None)

CRITICAL = PRIORITY_NAMES["critical"]
NORMAL = PRIORITY_NAMES["normal"]


@pytest.fixture
def reg():
    clock = VirtualClock(0.0)
    return clock, LeaseRegistry(clock)


def _renew_until(clock, registry, agent, region, until, step=HEARTBEAT_S):
    """Heartbeat like presenced does — every 30 s, forever — up to `until`."""
    while clock.now() < until:
        clock.advance(min(step, until - clock.now()))
        registry.heartbeat(ROOM, agent, region)


# -- the bound itself --------------------------------------------------------


def test_an_uncontended_holder_still_renews_forever(reg):
    # The thing that must not regress. An agent working alone is never
    # interrupted; that is the entire point of the system.
    clock, registry = reg
    registry.acquire(ROOM, "sara", "a1", R, "work")
    _renew_until(clock, registry, "a1", R, until=8 * 3600)
    holder = registry.holder_of(ROOM, R)
    assert holder is not None and holder.agent == "a1"
    assert holder.handover_at is None


def test_a_senior_requester_waits_one_grace_and_then_gets_the_region(reg):
    clock, registry = reg
    registry.acquire(ROOM, "dev", "junior", R, "work", priority=NORMAL)

    refused = registry.acquire(ROOM, "sara", "senior", R, "hotfix",
                               priority=CRITICAL)
    assert not refused.ok
    assert refused.decision == "wait"
    # The verdict comes with a number, which is the difference between "wait"
    # and "wait indefinitely".
    assert refused.handover_at == pytest.approx(HANDOVER_GRACE_S)

    # The junior keeps working the whole time, exactly as it did in the repro.
    _renew_until(clock, registry, "junior", R, until=HANDOVER_GRACE_S + 1)

    granted = registry.acquire(ROOM, "sara", "senior", R, "hotfix",
                               priority=CRITICAL)
    assert granted.ok
    assert granted.inherited is not None
    assert granted.inherited.from_agent == "junior"


def test_eight_hours_of_renewals_no_longer_beat_a_critical_requester(reg):
    # The review's repro, run against the fix. It used to print
    # `critical grants=0 waits=5760`.
    clock, registry = reg
    registry.acquire(ROOM, "dev", "junior", R, "work", priority=NORMAL)

    grants = 0
    first_grant_at = None
    for step in range(int(8 * 3600 / 5)):
        clock.advance(5.0)
        if step % 6 == 0:
            registry.acquire(ROOM, "dev", "junior", R, "work", priority=NORMAL)
        result = registry.acquire(ROOM, "sara", "senior", R, "urgent",
                                  priority=CRITICAL)
        if result.ok:
            grants += 1
            if first_grant_at is None:
                first_grant_at = clock.now()

    assert grants > 0
    # One grace plus the poll interval that noticed. Not eight hours.
    assert first_grant_at <= HANDOVER_GRACE_S + 10


def test_a_junior_behind_a_critical_holder_is_not_starved_forever(reg):
    # The anti-starvation guard. Wait-die tells the junior to abort, so it never
    # gets to "wait" — but its ask still caps the holder, on the longer
    # fair-share grace, and the region is then kept for it.
    clock, registry = reg
    registry.acquire(ROOM, "sara", "senior", R, "long haul", priority=CRITICAL)

    refused = registry.acquire(ROOM, "dev", "junior", R, "work",
                               priority=NORMAL)
    assert refused.decision == "abort"
    assert refused.handover_at == pytest.approx(FAIR_SHARE_GRACE_S)

    _renew_until(clock, registry, "senior", R, until=FAIR_SHARE_GRACE_S + 1)

    granted = registry.acquire(ROOM, "dev", "junior", R, "work",
                               priority=NORMAL)
    assert granted.ok, "a normal-tier agent never got a turn"


def test_the_senior_grace_is_shorter_than_the_fair_share_one():
    # Priority decides who waits *less*, not who eats. If these two were equal
    # the tier would buy nothing; if fair-share were unbounded we would be back
    # where we started.
    assert HANDOVER_GRACE_S < FAIR_SHARE_GRACE_S
    assert FAIR_SHARE_GRACE_S < float("inf")


def test_the_deadline_is_anchored_to_the_first_ask_not_the_last(reg):
    # Otherwise a holder outlasts one contender and gets a fresh grace from the
    # next frame that same contender sends.
    clock, registry = reg
    registry.acquire(ROOM, "dev", "junior", R, "work", priority=NORMAL)
    registry.acquire(ROOM, "sara", "senior", R, "hotfix", priority=CRITICAL)
    deadline = registry.holder_of(ROOM, R).handover_at

    for _ in range(10):
        clock.advance(5.0)
        registry.acquire(ROOM, "sara", "senior", R, "hotfix", priority=CRITICAL)
    assert registry.holder_of(ROOM, R).handover_at == deadline


def test_a_junior_ask_cannot_push_out_a_deadline_a_senior_set(reg):
    clock, registry = reg
    registry.acquire(ROOM, "dev", "holder", R, "work", priority=NORMAL)
    registry.acquire(ROOM, "sara", "senior", R, "hotfix", priority=CRITICAL)
    deadline = registry.holder_of(ROOM, R).handover_at

    clock.advance(1.0)
    registry.acquire(ROOM, "kim", "third", R, "later", priority=NORMAL)
    assert registry.holder_of(ROOM, R).handover_at == deadline


def test_a_heartbeat_cannot_renew_past_the_deadline(reg):
    # The daemon heartbeats every 30 s whether or not anybody is waiting. An
    # uncapped heartbeat reopens the hole from the other side.
    clock, registry = reg
    registry.acquire(ROOM, "dev", "junior", R, "work", priority=NORMAL)
    registry.acquire(ROOM, "sara", "senior", R, "hotfix", priority=CRITICAL)

    _renew_until(clock, registry, "junior", R, until=HANDOVER_GRACE_S - 0.5)
    assert registry.holder_of(ROOM, R) is not None

    clock.advance(1.0)
    assert registry.holder_of(ROOM, R) is None


def test_a_lease_nobody_asked_for_is_never_capped(reg):
    clock, registry = reg
    registry.acquire(ROOM, "sara", "a1", R, "work")
    # Somebody claims a *different* region. Not an ask for this one.
    registry.acquire(ROOM, "dev", "a2", OTHER, "elsewhere")
    _renew_until(clock, registry, "a1", R, until=4 * 3600)
    assert registry.holder_of(ROOM, R) is not None


# -- the reservation ---------------------------------------------------------


def test_a_handed_over_region_is_kept_for_the_agent_that_waited(reg):
    clock, registry = reg
    registry.acquire(ROOM, "dev", "junior", R, "work", priority=NORMAL)
    registry.acquire(ROOM, "sara", "senior", R, "hotfix", priority=CRITICAL)
    _renew_until(clock, registry, "junior", R, until=HANDOVER_GRACE_S + 0.5)

    # The junior is still working and asks straight back. It does not get it.
    back = registry.acquire(ROOM, "dev", "junior", R, "work", priority=NORMAL)
    assert not back.ok
    assert back.held_by is None, "nobody holds it; it is being kept"
    assert back.reserved_by is not None
    assert back.reserved_by.agent == "senior"
    assert back.decision == "wait", "a reservation clears on its own; never abort"


def test_a_reservation_lets_go_on_its_own(reg):
    clock, registry = reg
    registry.acquire(ROOM, "dev", "junior", R, "work", priority=NORMAL)
    registry.acquire(ROOM, "sara", "senior", R, "hotfix", priority=CRITICAL)
    _renew_until(clock, registry, "junior", R, until=HANDOVER_GRACE_S + 0.5)

    assert not registry.acquire(ROOM, "dev", "junior", R, "w",
                                priority=NORMAL).ok
    clock.advance(RESERVATION_S + 1)
    assert registry.acquire(ROOM, "dev", "junior", R, "w", priority=NORMAL).ok


def test_a_reservation_does_not_block_a_neighbouring_region(reg):
    clock, registry = reg
    registry.acquire(ROOM, "dev", "junior", R, "work", priority=NORMAL)
    registry.acquire(ROOM, "sara", "senior", R, "hotfix", priority=CRITICAL)
    _renew_until(clock, registry, "junior", R, until=HANDOVER_GRACE_S + 0.5)

    assert registry.acquire(ROOM, "dev", "junior", OTHER, "other work",
                            priority=NORMAL).ok


def test_the_reservation_is_short_enough_to_be_worth_having():
    # It holds a region open for an agent that may never come back, so it is
    # paid for by everybody. Anything near the lease TTL is a second lease.
    assert 0 < RESERVATION_S <= LEASE_TTL_S / 4


def test_an_ordinary_release_reserves_nothing(reg):
    # Only a fired deadline reserves. Queueing every released region behind a
    # timer deadlocked the forty-agent contention run outright.
    clock, registry = reg
    registry.acquire(ROOM, "dev", "junior", R, "work", priority=NORMAL)
    registry.acquire(ROOM, "sara", "senior", R, "hotfix", priority=CRITICAL)
    clock.advance(1.0)
    registry.release(ROOM, "junior", R)

    assert registry.reservation_for(ROOM, R) is None
    assert registry.acquire(ROOM, "kim", "bystander", R, "quick fix").ok


# -- dodging the deadline ----------------------------------------------------


def test_letting_go_and_re_taking_does_not_buy_a_fresh_grace(reg):
    clock, registry = reg
    registry.acquire(ROOM, "sara", "senior", R, "long haul", priority=CRITICAL)
    registry.acquire(ROOM, "dev", "junior", R, "work", priority=NORMAL)
    deadline = registry.holder_of(ROOM, R).handover_at

    # One second before the deadline, the holder drops the lease and takes it
    # straight back. Nothing legitimate does this; the bound has to survive it
    # anyway.
    clock.advance(FAIR_SHARE_GRACE_S - 1)
    registry.release(ROOM, "senior", R)
    again = registry.acquire(ROOM, "sara", "senior", R, "long haul",
                             priority=CRITICAL)
    assert again.ok
    assert again.claim.handover_at == deadline

    clock.advance(2.0)
    assert registry.acquire(ROOM, "dev", "junior", R, "work",
                            priority=NORMAL).ok


def test_a_different_agent_taking_the_region_starts_clean(reg):
    # The carry is about one agent dodging its own deadline. A handover working
    # as designed must not saddle the winner with the loser's clock.
    clock, registry = reg
    registry.acquire(ROOM, "dev", "junior", R, "work", priority=NORMAL)
    registry.acquire(ROOM, "sara", "senior", R, "hotfix", priority=CRITICAL)
    clock.advance(1.0)
    registry.release(ROOM, "junior", R)

    taken = registry.acquire(ROOM, "sara", "senior", R, "hotfix",
                             priority=CRITICAL)
    assert taken.ok
    assert taken.claim.handover_at is None
    assert taken.claim.contenders == {}


# -- who the region goes to --------------------------------------------------


def test_the_region_goes_to_the_most_entitled_waiter(reg):
    clock, registry = reg
    registry.acquire(ROOM, "dev", "holder", R, "work", priority=NORMAL)
    registry.acquire(ROOM, "kim", "other_normal", R, "want", priority=NORMAL)
    clock.advance(1.0)
    registry.acquire(ROOM, "sara", "senior", R, "hotfix", priority=CRITICAL)

    winner = registry.holder_of(ROOM, R).handover_winner()
    assert winner.agent == "senior", "tier beats having asked first"


def test_two_equal_waiters_go_in_the_order_they_asked(reg):
    clock, registry = reg
    registry.acquire(ROOM, "dev", "holder", R, "work", priority=NORMAL)
    registry.acquire(ROOM, "kim", "early", R, "want", priority=NORMAL)
    clock.advance(5.0)
    registry.acquire(ROOM, "lee", "late", R, "want", priority=NORMAL)

    assert registry.holder_of(ROOM, R).handover_winner().agent == "early"


def test_contending_via_the_hook_path_starts_the_clock_too(reg):
    # `contend` is what the rung 3 negotiation path calls. An agent blocked a
    # hundred times over an hour never sends a claim frame, and used to be an
    # agent that had never asked for anything.
    clock, registry = reg
    registry.acquire(ROOM, "dev", "junior", R, "work", priority=NORMAL)

    held = registry.contend(ROOM, R, "senior", "sara", CRITICAL)
    assert held is not None and held.agent == "junior"
    assert held.handover_at == pytest.approx(HANDOVER_GRACE_S)

    _renew_until(clock, registry, "junior", R, until=HANDOVER_GRACE_S + 0.5)
    assert registry.acquire(ROOM, "sara", "senior", R, "hotfix",
                            priority=CRITICAL).ok


def test_contending_a_region_you_already_hold_is_not_an_ask(reg):
    _clock, registry = reg
    registry.acquire(ROOM, "sara", "a1", R, "work")
    assert registry.contend(ROOM, R, "a1", "sara", NORMAL) is None
    assert registry.holder_of(ROOM, R).handover_at is None
