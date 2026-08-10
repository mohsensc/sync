"""Priority and policy where they meet the wire.

Two things are being pinned down here. First, that the tier a connection gets
comes off the roster the relay read and never off anything a client typed.
Second, that policy changes how loudly a rung is told and never what the lease
table did about it.
"""

from __future__ import annotations

import logging

import pytest

from agent_presence.clock import VirtualClock
from agent_presence.leases import LEASE_TTL_S
from agent_presence.policy import (
    StaticPolicy,
    build_policy,
    builtin_layer,
    parse_layer,
)
from agent_presence.principals import Principal, Roster, hash_token
from agent_presence.priority import PRIORITY_NAMES
from agent_presence.relay import Relay

ROOM = "r1"
SARA_TOKEN = "sara-token"
BOT_TOKEN = "bot-token"


def wire_region(path: str, symbol: str | None = "sym") -> dict:
    return {"path": path, "symbol": symbol, "lines": None}


class FakeConn:
    def __init__(
        self,
        agent: str,
        human: str,
        principal: str | None = None,
        token: str | None = None,
        unattended: bool = False,
    ) -> None:
        self.agent, self.human, self.room = agent, human, None
        self.principal, self.token, self.unattended = principal, token, unattended
        self.sent: list[dict] = []

    def send(self, payload: dict) -> None:
        self.sent.append(payload)


def roster() -> Roster:
    return Roster(
        (
            # normal attended, elevated when nobody is watching
            Principal("sara", "Sara", 1, 2, hash_token(SARA_TOKEN)),
            Principal("release-bot", "Bot", 3, 3, hash_token(BOT_TOKEN)),
        ),
        source="<test>",
        present=True,
    )


def policy_from(*specs) -> StaticPolicy:
    built = [builtin_layer()]
    for name, text in specs:
        built.append(parse_layer(text, name=name, source=f"<{name}>"))
    return StaticPolicy(build_policy(built))


def relay(**kwargs) -> Relay:
    kwargs.setdefault("roster", Roster.inert())
    kwargs.setdefault("policy", StaticPolicy(build_policy([builtin_layer()])))
    return Relay(VirtualClock(0.0), **kwargs)


def claim(rel: Relay, conn: FakeConn, path: str, symbol: str | None = "sym",
          **extra) -> dict:
    frame = {"type": "claim", "region": wire_region(path, symbol),
             "intent": "work"}
    frame.update(extra)
    return rel.handle(conn, frame)


# -- the client cannot set its own priority ----------------------------------


@pytest.mark.parametrize("asserted", ["critical", "elevated", 3, 99, True])
def test_a_claim_frame_asserting_its_own_priority_is_ignored(asserted):
    # The requirement, stated as flatly as it can be. `priority` on a claim
    # frame is treated exactly the way `agent` on a claim frame is treated:
    # it is whatever the client typed, so nothing that touches a lease reads it.
    rel = relay()
    conn = FakeConn("a1", "sara")
    rel.join(ROOM, conn)

    granted = claim(rel, conn, "src/pay.py", priority=asserted)
    assert granted["granted"] is True
    assert granted["priority"] == "normal"
    assert rel.registry.priority_of("a1") == PRIORITY_NAMES["normal"]


def test_an_asserted_priority_does_not_win_a_contest():
    # The consequence that matters. A liar contending with a real holder gets
    # the same verdict it would have got saying nothing.
    rel = relay()
    holder, liar = FakeConn("a1", "sara"), FakeConn("a2", "dev")
    rel.join(ROOM, holder)
    rel.join(ROOM, liar)

    assert claim(rel, holder, "src/pay.py")["granted"] is True
    rel._clock.advance(5)
    refused = claim(rel, liar, "src/pay.py", priority="critical")

    assert refused["granted"] is False
    assert refused["decision"] == "abort"
    assert refused["priority"] == "normal"
    assert refused["holder_priority"] == "normal"


def test_an_asserted_priority_on_a_join_frame_is_ignored_too():
    rel = relay(roster=roster())
    conn = FakeConn("a1", "sara")
    conn.priority = "critical"        # not a field the relay has ever read
    rel.join(ROOM, conn)
    assert rel.priority_of(conn) == PRIORITY_NAMES["normal"]


def test_naming_a_principal_without_its_token_buys_nothing():
    # The threat model: an agent reads the roster out of the repo, sees that
    # release-bot is critical, and says it is release-bot.
    rel = relay(roster=roster())
    liar = FakeConn("a2", "dev", principal="release-bot", token=None)
    rel.join(ROOM, liar)
    assert rel.priority_of(liar) == PRIORITY_NAMES["normal"]


def test_a_wrong_token_still_joins_and_still_claims():
    # Fail open. A bad token loses a rung, never a join.
    rel = relay(roster=roster())
    conn = FakeConn("a2", "dev", principal="release-bot", token="wrong")
    assert rel.join(ROOM, conn) is True
    assert claim(rel, conn, "src/pay.py")["granted"] is True
    assert rel.grant_of(conn).reason == "bad-token"


# -- what a real grant buys --------------------------------------------------


def test_a_verified_principal_gets_its_roster_tier():
    rel = relay(roster=roster())
    bot = FakeConn("a1", "ci", principal="release-bot", token=BOT_TOKEN)
    rel.join(ROOM, bot)
    assert rel.priority_of(bot) == PRIORITY_NAMES["critical"]


def test_the_unattended_flag_selects_inside_the_band_and_no_further():
    rel = relay(roster=roster())
    watched = FakeConn("a1", "sara", principal="sara", token=SARA_TOKEN)
    alone = FakeConn("a2", "sara", principal="sara", token=SARA_TOKEN,
                     unattended=True)
    rel.join(ROOM, watched)
    rel.join("r2", alone)
    assert rel.priority_of(watched) == PRIORITY_NAMES["normal"]
    assert rel.priority_of(alone) == PRIORITY_NAMES["elevated"]
    assert rel.priority_of(alone) < PRIORITY_NAMES["critical"]


def test_a_senior_requester_is_told_to_wait_where_it_would_have_aborted():
    # Requirement 1's payoff, on the production path. Without a roster the
    # junior holder wins forever as long as it keeps renewing.
    rel = relay(roster=roster())
    junior = FakeConn("a1", "dev")
    senior = FakeConn("a2", "sara", principal="sara", token=SARA_TOKEN,
                      unattended=True)
    rel.join(ROOM, junior)
    rel.join(ROOM, senior)

    assert claim(rel, junior, "src/pay.py")["granted"] is True
    rel._clock.advance(5)
    refused = claim(rel, senior, "src/pay.py")

    assert refused["granted"] is False
    assert refused["decision"] == "wait"
    assert refused["priority"] == "elevated"
    assert refused["holder_priority"] == "normal"


def test_the_senior_wins_within_one_ttl_with_nothing_revoked():
    # No preemption, at any tier gap. The senior keeps its place and takes the
    # region when the holder's own lease runs out — it is never handed
    # something another agent is still holding.
    rel = relay(roster=roster())
    junior = FakeConn("a1", "dev")
    senior = FakeConn("a2", "ci", principal="release-bot", token=BOT_TOKEN)
    rel.join(ROOM, junior)
    rel.join(ROOM, senior)

    assert claim(rel, junior, "src/pay.py")["granted"] is True
    start = rel._clock.now()

    while rel._clock.now() - start <= LEASE_TTL_S + 1:
        result = claim(rel, senior, "src/pay.py")
        if result["granted"]:
            break
        assert result["decision"] == "wait"
        # The holder is untouched for as long as it is alive.
        holder = rel.registry.holder_of(ROOM, _region("src/pay.py"))
        if holder is not None:
            assert holder.agent == "a1"
        rel._clock.advance(5)
    else:
        raise AssertionError("the senior never won the region")

    assert rel._clock.now() - start <= LEASE_TTL_S + 1


def _region(path: str):
    from agent_presence.types import Region
    return Region(path=path, symbol="sym", lines=None)


def test_the_loser_is_told_who_outranked_it_and_by_how_much():
    # A preempted agent must never simply find its lease gone with no
    # explanation. Nothing is preempted here — but a refused agent still gets
    # both tiers by name, so "why did I lose" has an answer on the frame.
    rel = relay(roster=roster())
    junior = FakeConn("a1", "dev")
    senior = FakeConn("a2", "ci", principal="release-bot", token=BOT_TOKEN)
    rel.join(ROOM, senior)
    rel.join(ROOM, junior)

    assert claim(rel, senior, "src/pay.py")["granted"] is True
    rel._clock.advance(5)
    refused = claim(rel, junior, "src/pay.py")

    assert refused["decision"] == "abort"
    assert refused["priority"] == "normal"
    assert refused["holder_priority"] == "critical"
    assert refused["held_by"] == "a2"
    assert refused["human"] == "ci"


def test_the_losers_own_tier_is_reported_before_the_abort_sweep():
    # An aborting agent has its leases released, and priority_of reads the tier
    # off exactly those leases. Read it after the sweep and every aborted
    # senior is told it was `normal`.
    rel = relay(roster=roster())
    other = FakeConn("a1", "dev")
    sara = FakeConn("a2", "sara", principal="sara", token=SARA_TOKEN,
                    unattended=True)
    rel.join(ROOM, other)
    rel.join(ROOM, sara)

    assert claim(rel, sara, "src/db.py")["granted"] is True     # t=0
    rel._clock.advance(10)
    assert claim(rel, other, "src/pay.py")["granted"] is True   # t=10
    rel._clock.advance(10)
    # sara is older *and* senior, so `other` is the one that dies.
    refused = claim(rel, other, "src/db.py")
    assert refused["decision"] == "abort"
    assert refused["priority"] == "normal"
    assert refused["holder_priority"] == "elevated"


# -- the grant is latched at join --------------------------------------------


def test_a_second_join_naming_a_different_principal_is_refused():
    rel = relay(roster=roster())
    conn = FakeConn("a1", "sara", principal="sara", token=SARA_TOKEN)
    assert rel.join(ROOM, conn) is True

    conn.principal, conn.token = "release-bot", BOT_TOKEN
    assert rel.join(ROOM, conn) is False
    assert rel.priority_of(conn) == PRIORITY_NAMES["normal"]
    assert conn.principal == "sara", "the latched principal was not restored"


def test_a_second_join_flipping_unattended_is_refused():
    rel = relay(roster=roster())
    conn = FakeConn("a1", "sara", principal="sara", token=SARA_TOKEN)
    assert rel.join(ROOM, conn) is True
    conn.unattended = True
    assert rel.join(ROOM, conn) is False
    assert rel.priority_of(conn) == PRIORITY_NAMES["normal"]
    assert conn.unattended is False


def test_a_second_join_to_another_room_keeps_the_grant():
    rel = relay(roster=roster())
    conn = FakeConn("a1", "ci", principal="release-bot", token=BOT_TOKEN)
    assert rel.join(ROOM, conn) is True
    assert rel.join("r2", conn) is True
    assert rel.priority_of(conn) == PRIORITY_NAMES["critical"]


def test_the_grant_dies_with_the_connection():
    rel = relay(roster=roster())
    conn = FakeConn("a1", "ci", principal="release-bot", token=BOT_TOKEN)
    rel.join(ROOM, conn)
    rel.leave(conn)
    assert rel.priority_of(conn) == PRIORITY_NAMES["normal"]


def test_a_connection_with_no_grant_fields_at_all_is_normal():
    # Every FakeConn in the older tests looks like this, and so does any client
    # that predates the join-frame change.
    class Bare:
        agent, human, room = "a1", "sara", None

        def send(self, payload):
            pass

    rel = relay(roster=roster())
    conn = Bare()
    assert rel.join(ROOM, conn) is True
    assert rel.priority_of(conn) == PRIORITY_NAMES["normal"]


# -- policy governs presentation, never the lease table ----------------------


def test_a_notify_rung_three_still_refuses_the_claim():
    # The line the whole design rests on. The lease table stays a truthful
    # record of who holds what; the effect only decides how loudly it is told.
    rel = relay(policy=policy_from(("org", '[effects]\nrung3 = "notify"\n')))
    a, b = FakeConn("a1", "sara"), FakeConn("a2", "dev")
    rel.join(ROOM, a)
    rel.join(ROOM, b)

    assert claim(rel, a, "src/pay.py")["granted"] is True
    rel._clock.advance(5)
    refused = claim(rel, b, "src/pay.py")

    assert refused["granted"] is False
    assert refused["decision"] == "abort"
    assert refused["effect"] == "notify"
    assert rel.registry.holder_of(ROOM, _region("src/pay.py")).agent == "a1"


def test_a_notify_rung_three_answers_ack_instead_of_negotiate():
    rel = relay(policy=policy_from(("org", '[effects]\nrung3 = "notify"\n')))
    a, b = FakeConn("a1", "sara"), FakeConn("a2", "dev")
    rel.join(ROOM, a)
    rel.join(ROOM, b)

    claim(rel, a, "src/pay.py")
    rel.handle(a, {"type": "event", "verb": "edit",
                   "region": wire_region("src/pay.py")})
    reply = rel.handle(b, {"type": "event", "verb": "edit",
                           "region": wire_region("src/pay.py")})

    assert reply["type"] == "ack"
    assert reply["rung"] == 3, "the rung is a fact and policy does not move it"
    assert reply["effect"] == "notify"


def test_a_default_rung_three_still_negotiates():
    rel = relay()
    a, b = FakeConn("a1", "sara"), FakeConn("a2", "dev")
    rel.join(ROOM, a)
    rel.join(ROOM, b)

    claim(rel, a, "src/pay.py")
    rel.handle(a, {"type": "event", "verb": "edit",
                   "region": wire_region("src/pay.py")})
    reply = rel.handle(b, {"type": "event", "verb": "edit",
                           "region": wire_region("src/pay.py")})

    assert reply["type"] == "negotiate"
    assert reply["effect"] == "deny"
    assert reply["effect_source"] == "builtin"


def test_a_policy_can_raise_a_lower_rung_into_a_negotiation():
    # Requirement 5's other half: quiet by default is a default, not a cap.
    rel = relay(policy=policy_from(("org", '[effects]\nrung2 = "deny"\n')))
    a, b = FakeConn("a1", "sara"), FakeConn("a2", "dev")
    rel.join(ROOM, a)
    rel.join(ROOM, b)

    # a1 holds the whole file, so it contends with any symbol in it, but the
    # two agents are editing different symbols — which is rung 2, not rung 3.
    claim(rel, a, "src/db.py", symbol=None)
    rel.handle(a, {"type": "event", "verb": "edit",
                   "region": wire_region("src/db.py", "insert")})
    reply = rel.handle(b, {"type": "event", "verb": "edit",
                           "region": wire_region("src/db.py", "query")})

    assert reply["rung"] == 2
    assert reply["effect"] == "deny"
    assert reply["type"] == "negotiate"


def test_a_path_rule_only_quietens_the_paths_it_names():
    rel = relay(policy=policy_from(("org", """
[[path]]
match = "src/generated/**"
rung3 = "notify"
""")))
    a, b = FakeConn("a1", "sara"), FakeConn("a2", "dev")
    rel.join(ROOM, a)
    rel.join(ROOM, b)

    for path in ("src/generated/api.py", "src/pay.py"):
        claim(rel, a, path)
        rel.handle(a, {"type": "event", "verb": "edit",
                       "region": wire_region(path)})

    quiet = rel.handle(b, {"type": "event", "verb": "edit",
                           "region": wire_region("src/generated/api.py")})
    loud = rel.handle(b, {"type": "event", "verb": "edit",
                          "region": wire_region("src/pay.py")})

    assert quiet["type"] == "ack" and quiet["effect"] == "notify"
    assert loud["type"] == "negotiate" and loud["effect"] == "deny"


def test_an_unattended_connection_gets_ask_promoted_to_deny():
    rel = relay(
        roster=roster(),
        policy=policy_from(("org", '[effects]\nrung3 = "ask"\n')),
    )
    watched = FakeConn("a1", "sara")
    alone = FakeConn("a2", "sara", principal="sara", token=SARA_TOKEN,
                     unattended=True)
    rel.join(ROOM, watched)
    rel.join(ROOM, alone)

    claim(rel, watched, "src/pay.py")
    rel.handle(watched, {"type": "event", "verb": "edit",
                         "region": wire_region("src/pay.py")})
    reply = rel.handle(alone, {"type": "event", "verb": "edit",
                               "region": wire_region("src/pay.py")})
    assert reply["effect"] == "deny"


def test_an_org_floor_cannot_be_argued_down_by_a_room():
    rel = relay(policy=policy_from(
        ("org", '[floor]\nrung3 = "deny"\n[effects]\nrung3 = "silent"\n'),
    ))
    a, b = FakeConn("a1", "sara"), FakeConn("a2", "dev")
    rel.join(ROOM, a)
    rel.join(ROOM, b)
    claim(rel, a, "src/pay.py")
    rel.handle(a, {"type": "event", "verb": "edit",
                   "region": wire_region("src/pay.py")})
    reply = rel.handle(b, {"type": "event", "verb": "edit",
                           "region": wire_region("src/pay.py")})
    assert reply["effect"] == "deny"


# -- the org floor on the wire -----------------------------------------------


def org_relay(tmp_path, text: str):
    from agent_presence.policy import PolicyFile

    path = tmp_path / "org.toml"
    path.write_text(text)
    clock = VirtualClock(0.0)
    return (
        Relay(clock, roster=Roster.inert(), policy=PolicyFile([("org", path)], clock)),
        path,
        clock,
    )


def test_a_relay_with_no_org_policy_sends_no_policy_frame():
    # A relay with no org file has nothing to say that the daemon's compiled-in
    # floor does not already say. Saying it anyway would put a new frame on the
    # wire of every install that configured nothing.
    rel = relay()
    conn = FakeConn("a1", "sara")
    rel.join(ROOM, conn)
    assert [f["type"] for f in conn.sent] == ["leases"]


def test_the_org_floor_is_pushed_on_join_after_the_lease_snapshot(tmp_path):
    rel, path, _clock = org_relay(tmp_path, '[floor]\nrung2 = "context"\n')
    conn = FakeConn("a1", "sara")
    rel.join(ROOM, conn)

    kinds = [f["type"] for f in conn.sent]
    assert kinds == ["leases", "policy"], (
        "the daemon replaces its whole lease table from the snapshot; the "
        "floor has to arrive after it, not before"
    )
    frame = conn.sent[-1]
    assert frame["floor"] == ["silent", "silent", "context", "notify", "silent"]
    assert frame["source"] == f"org:{path}"
    assert frame["digest"]


def test_editing_the_org_file_republishes_the_floor_to_the_whole_room(tmp_path):
    rel, path, clock = org_relay(tmp_path, '[floor]\nrung2 = "notify"\n')
    a, b = FakeConn("a1", "sara"), FakeConn("a2", "dev")
    rel.join(ROOM, a)
    rel.join(ROOM, b)
    a.sent.clear()
    b.sent.clear()

    path.write_text('[floor]\nrung2 = "deny"\n')
    clock.advance(2.0)
    # Any frame at all is enough. Nothing polls: the relay only does work when
    # something happens, and when nothing is happening there is nobody whose
    # edit the new floor would have changed.
    rel.handle(a, {"type": "heartbeat", "region": wire_region("src/x.py")})

    for conn in (a, b):
        pushed = [f for f in conn.sent if f["type"] == "policy"]
        assert len(pushed) == 1, f"{conn.agent} got {len(pushed)} policy frames"
        assert pushed[0]["floor"][2] == "deny"


def test_an_unchanged_org_file_is_not_republished(tmp_path):
    rel, _path, clock = org_relay(tmp_path, '[floor]\nrung2 = "notify"\n')
    conn = FakeConn("a1", "sara")
    rel.join(ROOM, conn)
    conn.sent.clear()

    for _ in range(5):
        clock.advance(2.0)
        rel.handle(conn, {"type": "heartbeat", "region": wire_region("src/x.py")})
    assert [f for f in conn.sent if f["type"] == "policy"] == []


def test_a_republished_floor_is_the_one_the_relay_is_enforcing(tmp_path):
    rel, path, clock = org_relay(tmp_path, '[floor]\nrung3 = "notify"\n')
    a, b = FakeConn("a1", "sara"), FakeConn("a2", "dev")
    rel.join(ROOM, a)
    rel.join(ROOM, b)

    claim(rel, a, "src/pay.py")
    rel.handle(a, {"type": "event", "verb": "edit",
                   "region": wire_region("src/pay.py")})
    # Builtin says deny at rung 3 and a floor only ever raises, so this is deny.
    assert rel.handle(b, {"type": "event", "verb": "edit",
                          "region": wire_region("src/pay.py")})["effect"] == "deny"

    b.sent.clear()
    path.write_text('[floor]\nrung1 = "deny"\n')
    clock.advance(2.0)
    rel.handle(a, {"type": "heartbeat", "region": wire_region("src/pay.py")})

    pushed = [f for f in b.sent if f["type"] == "policy"][-1]
    assert pushed["floor"][1] == "deny"
    assert rel._policy.current().floor_table("")[1] == "deny"


# -- broken configuration is loud, never quiet -------------------------------


def test_a_broken_policy_file_never_makes_the_relay_quieter(tmp_path, caplog):
    bad = tmp_path / "policy.toml"
    bad.write_text("this is not [ toml")
    from agent_presence.policy import PolicyFile

    clock = VirtualClock(0.0)
    with caplog.at_level(logging.WARNING):
        rel = Relay(clock, roster=Roster.inert(),
                    policy=PolicyFile([("org", bad)], clock))
        a, b = FakeConn("a1", "sara"), FakeConn("a2", "dev")
        rel.join(ROOM, a)
        rel.join(ROOM, b)
        claim(rel, a, "src/pay.py")
        rel.handle(a, {"type": "event", "verb": "edit",
                       "region": wire_region("src/pay.py")})
        reply = rel.handle(b, {"type": "event", "verb": "edit",
                               "region": wire_region("src/pay.py")})

    assert reply["type"] == "negotiate"
    assert reply["effect"] == "deny"
    assert "policy" in caplog.text.lower()


def test_a_broken_roster_leaves_everyone_normal_and_still_serving(caplog):
    with caplog.at_level(logging.ERROR):
        broken = Roster.parse("this is not [ toml", source="<test>")
    rel = relay(roster=broken)
    conn = FakeConn("a1", "ci", principal="release-bot", token=BOT_TOKEN)
    assert rel.join(ROOM, conn) is True
    assert rel.priority_of(conn) == PRIORITY_NAMES["normal"]
    assert claim(rel, conn, "src/pay.py")["granted"] is True


def test_a_relay_built_with_no_arguments_still_works(monkeypatch, tmp_path):
    # The default construction path reads the org policy and the repo roster
    # off disk. Neither exists here, and that has to be a no-op rather than a
    # traceback at import time.
    monkeypatch.setenv("AGENT_PRESENCE_ORG_POLICY", str(tmp_path / "nope.toml"))
    monkeypatch.setenv("AGENT_PRESENCE_PRINCIPALS", str(tmp_path / "nope.toml"))
    rel = Relay(VirtualClock(0.0))
    conn = FakeConn("a1", "sara")
    assert rel.join(ROOM, conn) is True
    assert claim(rel, conn, "src/pay.py")["granted"] is True
    assert rel.priority_of(conn) == PRIORITY_NAMES["normal"]
