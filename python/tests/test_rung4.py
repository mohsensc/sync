"""Rung 4: two agents doing the same work in different files.

The thing under test is as much the gating as the matching. Rung 4 is an
inference over free text sitting on top of four rungs that decide on facts, so
every test here that asserts silence is doing more work than the ones that
assert a hit.
"""

import pytest

from agent_presence.clock import VirtualClock
from agent_presence.ladder import (
    DEFAULT_RUNG4_THRESHOLD,
    RUNG4_ENV,
    THRESHOLD_ENV,
    Activity,
    classify,
    interrupts_at,
    redundant_peer,
    rung4_threshold,
)
from agent_presence.relay import Relay
from agent_presence.types import AgentEvent, Region

# The canonical pair: same work, no shared token that a hook could ever see,
# and no overlapping region to detect.
JWT = "add JWT refresh to auth"
TOKEN = "implement token refresh in the login flow"
UNRELATED = "fix the CSS grid on the settings page"


@pytest.fixture
def rung4_on(monkeypatch):
    monkeypatch.setenv(RUNG4_ENV, "1")


@pytest.fixture
def relay():
    return Relay(VirtualClock(1000.0))


class FakeConn:
    def __init__(self, agent="a1", human="sara"):
        self.agent = agent
        self.human = human
        self.room = None
        self.sent = []

    def send(self, payload):
        self.sent.append(payload)


def region(path, symbol=None):
    return Region(path=path, symbol=symbol, lines=None)


def declaring(intent, agent="a2", path="src/auth/jwt.py"):
    """An incoming MCP declaration."""
    return AgentEvent(
        room="r1", human="dev", agent=agent, kind="claim", source="mcp",
        verb="edit", region=region(path), ts=1000.0,
    ), intent


def declared(intent, agent="a1", path="src/login/session.py"):
    """A peer that declared its intent through MCP."""
    return Activity(agent=agent, human="sara", verb="edit",
                    region=region(path), intent=intent, source="mcp")


def observed(agent="a1", path="src/login/session.py"):
    """A peer seen only through hooks. No intent, and never any."""
    return Activity(agent=agent, human="sara", verb="edit",
                    region=region(path), intent="", source="hook")


# -- the ladder -------------------------------------------------------------


def test_true_positive_fires(rung4_on):
    event, intent = declaring(JWT)
    assert classify(event, [declared(TOKEN)], intent) == 4


def test_true_negative_stays_silent(rung4_on):
    event, intent = declaring(JWT)
    assert classify(event, [declared(UNRELATED)], intent) == 0


def test_a_near_miss_stays_below_the_bar(rung4_on):
    """Same shape, different subject. Two agents adding retry to two different
    uploaders are not duplicating each other, and this is exactly the case a
    lexical scorer has least idea about."""
    event, intent = declaring("add retry with backoff to the S3 uploader")
    peer = declared("add retry with backoff to the GCS uploader")
    assert classify(event, [peer], intent) == 0


def test_the_match_carries_who_and_what(rung4_on):
    event, intent = declaring(JWT)
    red = redundant_peer(event, [declared(TOKEN)], intent)
    assert red is not None
    assert (red.agent, red.human, red.intent) == ("a1", "sara", TOKEN)
    assert red.region.path == "src/login/session.py"
    assert red.score >= DEFAULT_RUNG4_THRESHOLD


def test_the_strongest_match_wins_not_the_first(rung4_on):
    event, intent = declaring(JWT)
    peers = [
        declared("rotate the auth token in the session layer",
                 agent="weak", path="src/a.py"),
        declared(TOKEN, agent="strong", path="src/b.py"),
    ]
    red = redundant_peer(event, peers, intent)
    assert red.agent == "strong"


# -- the flag ---------------------------------------------------------------


def test_the_flag_gates_it(monkeypatch):
    monkeypatch.delenv(RUNG4_ENV, raising=False)
    event, intent = declaring(JWT)
    assert classify(event, [declared(TOKEN)], intent) == 0
    assert redundant_peer(event, [declared(TOKEN)], intent) is None


@pytest.mark.parametrize("value", ["", "0", "no", "off", "false", "maybe", " "])
def test_only_a_truthy_flag_turns_it_on(monkeypatch, value):
    monkeypatch.setenv(RUNG4_ENV, value)
    event, intent = declaring(JWT)
    assert classify(event, [declared(TOKEN)], intent) == 0


@pytest.mark.parametrize("value", ["1", "true", "yes", "on", "TRUE", " on "])
def test_the_usual_truthy_spellings_all_work(monkeypatch, value):
    monkeypatch.setenv(RUNG4_ENV, value)
    event, intent = declaring(JWT)
    assert classify(event, [declared(TOKEN)], intent) == 4


def test_rungs_0_to_3_are_unchanged_with_the_flag_off(monkeypatch):
    """The whole point of the flag: with it down, this file may as well not
    exist."""
    monkeypatch.delenv(RUNG4_ENV, raising=False)
    event = AgentEvent(room="r1", human="dev", agent="a2", kind="touch",
                       source="hook", verb="edit",
                       region=region("src/auth.py", "sign_in"), ts=1.0)
    peer = Activity(agent="a1", human="sara", verb="edit",
                    region=region("src/auth.py", "sign_in"), intent="")
    assert classify(event, [peer]) == 3


# -- the threshold ----------------------------------------------------------


def test_the_threshold_is_tunable(monkeypatch, rung4_on):
    event, intent = declaring("add retry with backoff to the S3 uploader")
    peer = declared("add retry with backoff to the GCS uploader")
    assert classify(event, [peer], intent) == 0
    monkeypatch.setenv(THRESHOLD_ENV, "0.7")
    assert classify(event, [peer], intent) == 4


@pytest.mark.parametrize("bad", ["", "high", "0", "-1", "1.5", "nan-ish"])
def test_a_bad_threshold_falls_back_instead_of_raising(monkeypatch, bad):
    """A fat finger in an env var must not decide that everything is
    redundant, and must not take the relay down either."""
    monkeypatch.setenv(THRESHOLD_ENV, bad)
    assert rung4_threshold() == DEFAULT_RUNG4_THRESHOLD


def test_the_default_threshold_sits_above_the_worst_near_miss():
    """Guards the tuning. See python/tools/tune_rung4.py for the corpus."""
    from agent_presence.similarity import LexicalSimilarity

    sim = LexicalSimilarity()
    worst_near_miss = max(
        sim.score(a, b) for a, b in [
            ("add retry with backoff to the S3 uploader",
             "add retry with backoff to the GCS uploader"),
            ("fix the payment webhook signature check",
             "write tests for the payment webhook"),
            ("migrate the users table to the new schema",
             "migrate the orders table to the new schema"),
            ("write unit tests for the auth module",
             "write unit tests for the billing module"),
        ]
    )
    assert worst_near_miss < DEFAULT_RUNG4_THRESHOLD
    assert sim.score(JWT, TOKEN) >= DEFAULT_RUNG4_THRESHOLD


# -- what can never trigger it ----------------------------------------------


def test_hook_activity_with_no_intent_never_triggers_it(rung4_on):
    """Hooks observe a path and a verb. They cannot know why, so they can never
    put an agent on rung 4 - which is the reason rung 4 needs MCP at all."""
    event, intent = declaring(JWT)
    assert classify(event, [observed()], intent) == 0


def test_a_hook_sourced_incoming_event_never_triggers_it(rung4_on):
    """Even handed an intent from somewhere. `source` is the second guard and
    it is deliberately redundant with the empty-string one."""
    event = AgentEvent(room="r1", human="dev", agent="a2", kind="touch",
                       source="hook", verb="edit",
                       region=region("src/auth/jwt.py"), ts=1.0)
    assert classify(event, [declared(TOKEN)], JWT) == 0


def test_a_hook_sourced_peer_with_an_intent_is_still_inert(rung4_on):
    """`source` is checked separately from the empty string, and this is why.
    An event frame carries both fields off the wire, so a client can put a hook
    event and an intent in the same message. Only the MCP channel declares
    intent; a hook that claims to have one is not a second opinion, it is a
    hook with a text field on it."""
    peer = Activity(agent="a1", human="sara", verb="edit",
                    region=region("src/login/session.py"), intent=TOKEN,
                    source="hook")
    event, intent = declaring(JWT)
    assert classify(event, [peer], intent) == 0
    assert redundant_peer(event, [peer], intent) is None


def test_an_mcp_peer_with_an_empty_intent_is_inert(rung4_on):
    peer = Activity(agent="a1", human="sara", verb="edit",
                    region=region("src/login/session.py"), intent="  ",
                    source="mcp")
    event, intent = declaring(JWT)
    assert classify(event, [peer], intent) == 0


def test_an_agent_never_matches_itself(rung4_on):
    """The commonest way to build a system nobody trusts: interrupt an agent
    with its own declaration."""
    event, intent = declaring(JWT, agent="a1")
    mine = declared(TOKEN, agent="a1", path="src/somewhere/else.py")
    assert classify(event, [mine], intent) == 0
    assert redundant_peer(event, [mine], intent) is None


def test_the_same_path_is_rungs_0_to_3_not_rung_4(rung4_on):
    """Same-path contention is decided on region overlap, which is a fact.
    Routing it through a text comparison would swap a certain signal for a
    guess."""
    event, intent = declaring(JWT, path="src/auth.py")
    peer = declared(TOKEN, path="src/auth.py")
    assert redundant_peer(event, [peer], intent) is None


def test_rung_4_interrupts():
    assert interrupts_at(4)


# -- the relay --------------------------------------------------------------


def claim(path, intent, symbol=None):
    return {"type": "claim", "intent": intent,
            "region": {"path": path, "symbol": symbol, "lines": None}}


def test_a_claim_gets_the_other_agents_intent_and_name(relay, rung4_on):
    sara = FakeConn("a1", "sara")
    dev = FakeConn("a2", "dev")
    relay.join("r1", sara)
    relay.join("r1", dev)

    relay.handle(sara, claim("src/login/session.py", TOKEN))
    reply = relay.handle(dev, claim("src/auth/jwt.py", JWT))

    # Different files never contend, so the lease is still granted. Rung 4 is
    # news, not a refusal.
    assert reply["granted"] is True
    assert reply["rung"] == 4

    red = reply["redundant"]
    assert red["agent"] == "a1"
    assert red["human"] == "sara"
    assert red["intent"] == TOKEN
    assert red["region"]["path"] == "src/login/session.py"
    assert red["score"] >= DEFAULT_RUNG4_THRESHOLD
    # Enough to split or defer on.
    assert "SPLIT" in red["moves"] and "DEFER" in red["moves"]
    assert red["advisory"] is True


def test_the_relay_stays_quiet_with_the_flag_off(relay, monkeypatch):
    monkeypatch.delenv(RUNG4_ENV, raising=False)
    sara = FakeConn("a1", "sara")
    dev = FakeConn("a2", "dev")
    relay.join("r1", sara)
    relay.join("r1", dev)

    relay.handle(sara, claim("src/login/session.py", TOKEN))
    reply = relay.handle(dev, claim("src/auth/jwt.py", JWT))

    assert reply["granted"] is True
    assert "rung" not in reply and "redundant" not in reply


def test_the_relay_stays_quiet_on_unrelated_work(relay, rung4_on):
    sara = FakeConn("a1", "sara")
    dev = FakeConn("a2", "dev")
    relay.join("r1", sara)
    relay.join("r1", dev)

    relay.handle(sara, claim("web/src/settings.css", UNRELATED))
    reply = relay.handle(dev, claim("src/auth/jwt.py", JWT))
    assert "redundant" not in reply


def test_a_claim_does_not_flag_itself(relay, rung4_on):
    dev = FakeConn("a2", "dev")
    relay.join("r1", dev)
    relay.handle(dev, claim("src/auth/jwt.py", JWT))
    # Renewing the same claim, and a second one from the same agent.
    again = relay.handle(dev, claim("src/auth/jwt.py", JWT))
    second = relay.handle(dev, claim("src/login/session.py", TOKEN))
    assert "redundant" not in again
    assert "redundant" not in second


def test_an_expired_claim_stops_matching(relay, rung4_on):
    sara = FakeConn("a1", "sara")
    dev = FakeConn("a2", "dev")
    relay.join("r1", sara)
    relay.join("r1", dev)

    relay.handle(sara, claim("src/login/session.py", TOKEN))
    relay._clock.advance(91.0)  # past LEASE_TTL_S
    reply = relay.handle(dev, claim("src/auth/jwt.py", JWT))
    assert "redundant" not in reply


def test_claims_in_another_room_never_match(relay, rung4_on):
    sara = FakeConn("a1", "sara")
    dev = FakeConn("a2", "dev")
    relay.join("r1", sara)
    relay.join("r2", dev)

    relay.handle(sara, claim("src/login/session.py", TOKEN))
    reply = relay.handle(dev, claim("src/auth/jwt.py", JWT))
    assert "redundant" not in reply


def test_hook_traffic_alone_never_reaches_rung_4(relay, rung4_on):
    """Two agents editing different files, both through hooks. No intent
    anywhere, so there is nothing for rung 4 to compare and the answer is a
    plain ack."""
    sara = FakeConn("a1", "sara")
    dev = FakeConn("a2", "dev")
    relay.join("r1", sara)
    relay.join("r1", dev)

    def touch(path):
        return {"type": "event", "kind": "touch", "source": "hook",
                "verb": "edit",
                "region": {"path": path, "symbol": None, "lines": None}}

    relay.handle(sara, touch("src/login/session.py"))
    reply = relay.handle(dev, touch("src/auth/jwt.py"))
    assert reply == {"type": "ack", "rung": 0}


def test_an_mcp_event_with_intent_gets_a_redundant_work_frame(relay, rung4_on):
    """The event channel can carry a declaration too, if the daemon ever
    forwards one. Nothing does today; this pins the shape."""
    sara = FakeConn("a1", "sara")
    dev = FakeConn("a2", "dev")
    relay.join("r1", sara)
    relay.join("r1", dev)

    def declare(path, intent):
        return {"type": "event", "kind": "touch", "source": "mcp",
                "verb": "edit", "intent": intent,
                "region": {"path": path, "symbol": None, "lines": None}}

    relay.handle(sara, declare("src/login/session.py", TOKEN))
    reply = relay.handle(dev, declare("src/auth/jwt.py", JWT))

    assert reply["type"] == "redundant_work"
    assert reply["rung"] == 4
    assert reply["agent"] == "a1"
    assert reply["intent"] == TOKEN


def test_a_lease_conflict_outranks_a_text_match(relay, rung4_on):
    """Rung 3 is a fact about this region, rung 4 an inference about another
    one. When both fire the agent hears about the certain one."""
    sara = FakeConn("a1", "sara")
    dev = FakeConn("a2", "dev")
    relay.join("r1", sara)
    relay.join("r1", dev)

    # sara holds the region dev is about to touch, and separately declared
    # matching work elsewhere.
    relay.handle(sara, claim("src/auth/jwt.py", "rewrite the token store"))
    relay.handle(sara, {"type": "event", "kind": "touch", "source": "mcp",
                        "verb": "edit", "intent": TOKEN,
                        "region": {"path": "src/login/session.py",
                                   "symbol": None, "lines": None}})

    reply = relay.handle(dev, {
        "type": "event", "kind": "touch", "source": "mcp", "verb": "edit",
        "intent": JWT,
        "region": {"path": "src/auth/jwt.py", "symbol": None, "lines": None},
    })
    assert reply["type"] == "negotiate"


# -- the mcp tool -----------------------------------------------------------


def test_claim_work_reports_redundancy(relay, rung4_on):
    from agent_presence.mcp_server import Tools

    sara = Tools(relay, "r1", "a1", "sara")
    dev = Tools(relay, "r1", "a2", "dev")

    sara.claim_work("src/login/session.py", None, TOKEN)
    out = dev.claim_work("src/auth/jwt.py", None, JWT)

    assert out["granted"] is True
    assert out["rung"] == 4
    assert out["redundant"]["human"] == "sara"
    assert out["redundant"]["intent"] == TOKEN


def test_claim_work_is_unchanged_with_the_flag_off(relay, monkeypatch):
    from agent_presence.mcp_server import Tools

    monkeypatch.delenv(RUNG4_ENV, raising=False)
    sara = Tools(relay, "r1", "a1", "sara")
    dev = Tools(relay, "r1", "a2", "dev")

    sara.claim_work("src/login/session.py", None, TOKEN)
    assert dev.claim_work("src/auth/jwt.py", None, JWT) == {"granted": True}
