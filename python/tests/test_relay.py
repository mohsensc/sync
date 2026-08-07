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
    assert len(b.sent) == 1
    assert a.sent == []


def test_rooms_are_isolated(relay):
    a, b = FakeConn("a1"), FakeConn("a2")
    relay.join("r1", a)
    relay.join("r2", b)
    relay.handle(a, touch("a1"))
    assert b.sent == []


def test_leaving_releases_every_lease_that_connection_held(relay):
    a = FakeConn("a1")
    relay.join("r1", a)
    relay.handle(a, {"type": "claim", "agent": "a1", "human": "sara",
                     "region": {"path": "p.py", "symbol": "f", "lines": None},
                     "intent": "work"})
    relay.leave(a)
    assert relay.registry.active_claims("r1") == []


def test_forbidden_fields_never_reach_presence(relay):
    a = FakeConn("a1")
    relay.join("r1", a)
    evt = touch("a1")
    evt["content"] = "hunter2"
    relay.handle(a, evt)
    assert "hunter2" not in repr(relay.presence("r1"))
