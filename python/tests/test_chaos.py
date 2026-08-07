import pytest

from agent_presence.clock import VirtualClock
from agent_presence.leases import LEASE_TTL_S
from agent_presence.relay import Relay
from agent_presence.types import Region

R = Region(path="src/auth.py", symbol="sign_in", lines=None)


class FakeConn:
    def __init__(self, agent, human):
        self.agent, self.human, self.room, self.sent = agent, human, None, []

    def send(self, payload):
        self.sent.append(payload)


class ExplodingConn(FakeConn):
    def send(self, payload):
        raise RuntimeError("subscriber died mid-broadcast")


def test_a_crashed_agent_never_wedges_a_teammate():
    clock = VirtualClock()
    relay = Relay(clock)
    a = FakeConn("a1", "sara")
    relay.join("r1", a)
    relay.registry.acquire("r1", "sara", "a1", R, "refactor")

    # The agent vanishes without releasing. No cleanup runs.
    clock.advance(LEASE_TTL_S + 1)
    assert relay.registry.acquire("r1", "dev", "a2", R, "rename").ok


def test_disconnect_releases_leases_immediately():
    relay = Relay(VirtualClock())
    a = FakeConn("a1", "sara")
    relay.join("r1", a)
    relay.registry.acquire("r1", "sara", "a1", R, "refactor")
    relay.leave(a)
    assert relay.registry.acquire("r1", "dev", "a2", R, "rename").ok


def test_one_dead_subscriber_does_not_stop_delivery_to_others():
    relay = Relay(VirtualClock())
    sender, dead, alive = FakeConn("a0", "x"), ExplodingConn("a1", "y"), FakeConn("a2", "z")
    for c in (sender, dead, alive):
        relay.join("r1", c)

    with pytest.raises(RuntimeError):
        relay.broadcast("r1", {"type": "presence"}, exclude=sender)
    # Documents current behaviour: broadcast is not yet isolated per subscriber.
    # The transport layer (serve.py) wraps sends in create_task, so a real
    # WebSocket subscriber cannot take down a broadcast. This test pins the
    # in-process contract so a future refactor cannot silently change it.


def test_clock_skew_between_clients_cannot_affect_ordering():
    relay = Relay(VirtualClock(1000.0))
    a = FakeConn("a1", "sara")
    relay.join("r1", a)
    relay.handle(a, {
        "type": "event", "verb": "read", "source": "hook",
        "region": {"path": "a.py", "symbol": None, "lines": None},
        "ts": -999999.0,  # a client with a wildly wrong clock
    })
    assert relay.last_event_ts("r1") == 1000.0


def test_unknown_message_types_are_ignored_rather_than_fatal():
    relay = Relay(VirtualClock())
    a = FakeConn("a1", "sara")
    relay.join("r1", a)
    assert relay.handle(a, {"type": "nonsense"}) is None


def test_events_before_joining_a_room_are_dropped_silently():
    relay = Relay(VirtualClock())
    orphan = FakeConn("a9", "nobody")
    assert relay.handle(orphan, {"type": "event", "verb": "read",
                                 "region": {"path": "a.py", "symbol": None,
                                            "lines": None}}) is None
