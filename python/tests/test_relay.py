import pytest

from agent_presence.clock import VirtualClock
from agent_presence.relay import Relay


class FakeConn:
    def __init__(self, agent="a1", human="sara"):
        self.agent = agent
        self.human = human
        self.room = None
        self.sent = []

    def send(self, payload):
        self.sent.append(payload)

    @property
    def fanout(self):
        """Everything the room sent this connection.

        Minus the lease snapshot, which is a reconciliation answer to this
        connection's own join and not traffic from anyone.
        """
        return [f for f in self.sent if f.get("type") != "leases"]


SECRET = "hunter2"


@pytest.fixture
def relay():
    return Relay(VirtualClock(1000.0))


def touch(agent="a1", path="src/auth.py", symbol="sign_in", verb="edit"):
    return {
        "type": "event", "agent": agent, "human": agent, "kind": "touch",
        "source": "hook", "verb": verb,
        "region": {"path": path, "symbol": symbol, "lines": None},
        "ts": 99999.0,  # client-supplied, must be discarded
    }


def test_relay_assigns_its_own_timestamp_and_discards_the_clients(relay):
    c = FakeConn()
    relay.join("r1", c)
    relay.handle(c, touch())
    assert relay.presence("r1")[0].region.path == "src/auth.py"
    stored = relay.last_event_ts("r1")
    assert stored == 1000.0


def test_events_fan_out_to_other_members_but_not_the_sender(relay):
    a, b = FakeConn("a1"), FakeConn("a2")
    relay.join("r1", a)
    relay.join("r1", b)
    relay.handle(a, touch("a1"))
    assert len(b.fanout) == 1
    assert a.fanout == []


def test_rooms_are_isolated(relay):
    a, b = FakeConn("a1"), FakeConn("a2")
    relay.join("r1", a)
    relay.join("r2", b)
    relay.handle(a, touch("a1"))
    assert b.fanout == []


def test_leaving_releases_every_lease_that_connection_held(relay):
    a = FakeConn("a1")
    relay.join("r1", a)
    relay.handle(a, {"type": "claim", "agent": "a1", "human": "sara",
                     "region": {"path": "p.py", "symbol": "f", "lines": None},
                     "intent": "work"})
    relay.leave(a)
    assert relay.registry.active_claims("r1") == []


def test_forbidden_fields_never_reach_the_wire_or_the_store(relay):
    # The presence store is built from named fields, so it can't leak whatever
    # redaction does. The fan-out payload forwards the region the client sent,
    # so that's the boundary worth testing.
    a, b = FakeConn("a1"), FakeConn("a2")
    relay.join("r1", a)
    relay.join("r1", b)

    evt = touch("a1")
    evt["content"] = SECRET                 # smuggled at the top level
    evt["region"]["note"] = SECRET          # smuggled inside a permitted key
    relay.handle(a, evt)

    assert len(b.fanout) == 1
    payload = b.fanout[0]
    assert SECRET not in repr(payload)
    assert set(payload["region"]) == {"path", "symbol", "lines"}
    assert SECRET not in repr(relay.presence("r1"))


# -- (C) identity comes from the connection, never from the payload ----------

REGION = {"path": "src/auth.py", "symbol": "sign_in", "lines": None}


def _claim(relay, conn, region=None, intent="work"):
    return relay.handle(conn, {"type": "claim", "agent": conn.agent,
                               "human": conn.human,
                               "region": region or REGION, "intent": intent})


def test_a_member_cannot_release_someone_elses_lease(relay):
    a, b = FakeConn("a1", "sara"), FakeConn("a2", "dev")
    relay.join("r1", a)
    relay.join("r1", b)
    _claim(relay, a, intent="refactor")
    # b lies about who it is.
    relay.handle(b, {"type": "release", "agent": "a1", "region": REGION})
    holder = relay.registry.active_claims("r1")
    assert len(holder) == 1
    assert holder[0].agent == "a1"


def test_a_member_cannot_heartbeat_someone_elses_lease(relay):
    from agent_presence.leases import LEASE_TTL_S

    clock = relay._clock
    a, b = FakeConn("a1", "sara"), FakeConn("a2", "dev")
    relay.join("r1", a)
    relay.join("r1", b)
    _claim(relay, a)
    clock.advance(LEASE_TTL_S - 1)
    relay.handle(b, {"type": "heartbeat", "agent": "a1", "region": REGION})
    clock.advance(2)
    assert relay.registry.active_claims("r1") == []


def test_a_member_cannot_claim_under_another_agents_name(relay):
    a = FakeConn("a2", "dev")
    relay.join("r1", a)
    relay.handle(a, {"type": "claim", "agent": "a1", "human": "sara",
                     "region": REGION, "intent": "work"})
    claims = relay.registry.active_claims("r1")
    assert [c.agent for c in claims] == ["a2"]
    assert [c.human for c in claims] == ["dev"]


def test_a_member_cannot_negotiate_under_another_agents_name(relay):
    a, b = FakeConn("a1", "sara"), FakeConn("a2", "dev")
    relay.join("r1", a)
    relay.join("r1", b)
    _claim(relay, a)
    # b sends HANDOFF claiming to be a1, which would drop a1's lease.
    relay.handle(b, {"type": "move", "agent": "a1", "region": REGION,
                     "move": "HANDOFF"})
    assert relay.registry.active_claims("r1")[0].agent == "a1"


# -- (A) a refused claim carries an instruction ------------------------------


def test_a_refused_claim_tells_the_loser_what_to_do(relay):
    a, b = FakeConn("a1", "sara"), FakeConn("a2", "dev")
    relay.join("r1", a)
    relay.join("r1", b)
    _claim(relay, a, intent="refactor to JWT")
    relay._clock.advance(5)
    reply = _claim(relay, b, intent="rename param")
    assert reply["granted"] is False
    assert reply["held_by"] == "a1"
    assert reply["decision"] == "abort"


def test_the_older_requester_is_told_to_wait_and_keeps_its_leases(relay):
    other = {"path": "src/db.py", "symbol": "query", "lines": None}
    a, b = FakeConn("a1", "sara"), FakeConn("a2", "dev")
    relay.join("r1", a)
    relay.join("r1", b)
    _claim(relay, b, region=other, intent="old work")   # a2 is the old one
    relay._clock.advance(5)
    _claim(relay, a, intent="refactor")                 # a1 is younger
    reply = _claim(relay, b, intent="rename")
    assert reply["decision"] == "wait"
    # Waiting must not cost the waiter what it already holds.
    assert any(c.agent == "a2" for c in relay.registry.active_claims("r1"))


def test_an_aborting_requester_actually_loses_its_leases(relay):
    other = {"path": "src/db.py", "symbol": "query", "lines": None}
    a, b = FakeConn("a1", "sara"), FakeConn("a2", "dev")
    relay.join("r1", a)
    relay.join("r1", b)
    _claim(relay, a, intent="refactor")
    relay._clock.advance(5)
    _claim(relay, b, region=other, intent="side work")
    reply = _claim(relay, b, intent="rename")
    assert reply["decision"] == "abort"
    # Releasing the loser's holdings is what removes the wait-for cycle.
    assert all(c.agent != "a2" for c in relay.registry.active_claims("r1"))


def test_a_contested_edit_brief_carries_the_same_instruction(relay):
    a, b = FakeConn("a1", "sara"), FakeConn("a2", "dev")
    relay.join("r1", a)
    relay.join("r1", b)
    _claim(relay, a, intent="refactor to JWT")
    relay.handle(a, touch("a1"))
    relay._clock.advance(5)
    reply = relay.handle(b, touch("a2"))
    assert reply["type"] == "negotiate"
    assert reply["decision"] == "abort"


# -- (F) a bad move name comes back as data, not as an exception -------------


def test_an_invented_move_over_the_wire_is_an_error_payload(relay):
    a = FakeConn("a1", "sara")
    relay.join("r1", a)
    reply = relay.handle(a, {"type": "move", "region": REGION, "move": "ARGUE"})
    assert reply["granted"] is False
    assert reply["action"] == "invalid_move"
    assert "ARGUE" in reply["error"]


def test_a_lowercase_move_over_the_wire_still_works(relay):
    a, b = FakeConn("a1", "sara"), FakeConn("a2", "dev")
    relay.join("r1", a)
    relay.join("r1", b)
    _claim(relay, a, intent="refactor")
    other = {"path": "src/auth.py", "symbol": "sign_out", "lines": None}
    reply = relay.handle(b, {"type": "move", "region": REGION, "move": "split",
                             "split_region": other})
    assert reply["granted"] is True
    assert reply["action"] == "split"


# -- (G) a sweep in one room never reaches another ---------------------------
#
# presenced defaults its relay identity to presenced@<hostname>, so two
# checkouts on one laptop are two rooms and one agent id. Both of the relay's
# release paths used to sweep every room.

ONLY_IN_A = {"path": "src/only-in-repo-a.py", "symbol": None, "lines": None}


def _two_room_standoff(relay):
    """a1 holds a lease in repo-a. rival already holds the contested region in
    repo-b, and holds it first, so a1's claim there loses wait-die."""
    in_a = FakeConn("presenced@laptop", "sara")
    in_b = FakeConn("presenced@laptop", "sara")
    rival = FakeConn("rival-agent", "dev")

    relay.join("repo-b", rival)
    _claim(relay, rival, intent="older holder")
    relay._clock.advance(5)
    relay.join("repo-a", in_a)
    _claim(relay, in_a, region=ONLY_IN_A, intent="the innocent lease")
    relay.join("repo-b", in_b)
    return in_a, in_b, rival


def test_a_wait_die_abort_in_one_room_leaves_another_rooms_leases_alone(relay):
    in_a, in_b, _ = _two_room_standoff(relay)

    reply = _claim(relay, in_b, intent="loser")
    assert reply["granted"] is False
    assert reply["decision"] == "abort", "the setup has to actually abort"

    held = relay.registry.active_claims("repo-a")
    assert [c.scope.path for c in held] == ["src/only-in-repo-a.py"], (
        "an abort in repo-b released the same agent id's repo-a lease"
    )


def test_a_disconnect_in_one_room_leaves_another_rooms_leases_alone(relay):
    in_a, in_b, _ = _two_room_standoff(relay)

    relay.leave(in_b)

    held = relay.registry.active_claims("repo-a")
    assert [c.scope.path for c in held] == ["src/only-in-repo-a.py"], (
        "closing the repo-b connection released the repo-a lease"
    )


def test_a_disconnect_still_releases_that_rooms_leases(relay):
    # The scoping must not turn into "releases nothing".
    a = FakeConn("a1", "sara")
    relay.join("r1", a)
    _claim(relay, a)
    relay.leave(a)
    assert relay.registry.active_claims("r1") == []
