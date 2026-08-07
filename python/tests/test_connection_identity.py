"""A connection declares who it is once.

docs/design.md is explicit: identity comes off the connection, never off a
client-supplied field, "otherwise any room member could drop, renew or steal a
teammate's claim by naming them". ``Relay.handle`` honours that for the message
body. The join frame is the same field wearing a different hat: it is also
client-supplied, and re-sending it renames a live connection.
"""

from __future__ import annotations

import json

from agent_presence.clock import VirtualClock
from agent_presence.relay import Relay
from agent_presence.types import Region

ROOM = "r1"
VICTIM = {"path": "src/auth.py", "symbol": "sign_in", "lines": None}
MINE = {"path": "src/db.py", "symbol": "query", "lines": None}


def region(d: dict) -> Region:
    return Region(path=d["path"], symbol=d["symbol"], lines=None)


class FakeConn:
    def __init__(self, agent: str, human: str) -> None:
        self.agent, self.human, self.room = agent, human, None
        self.sent: list[dict] = []

    def send(self, payload: dict) -> None:
        self.sent.append(payload)


def holders(relay: Relay) -> dict[str, str]:
    return {c.scope.path: c.agent for c in relay.registry.active_claims(ROOM)}


# -- renaming a live connection ----------------------------------------------


def test_a_second_join_cannot_rename_a_live_connection():
    relay = Relay(VirtualClock(0.0))
    attacker = FakeConn("a2", "dev")
    relay.join(ROOM, attacker)

    attacker.agent, attacker.human = "a1", "sara"
    relay.join(ROOM, attacker)

    assert (attacker.agent, attacker.human) == ("a2", "dev")


def test_a_renamed_connection_cannot_release_the_named_agents_lease():
    relay = Relay(VirtualClock(0.0))
    victim = FakeConn("a1", "sara")
    relay.join(ROOM, victim)
    relay.handle(victim, {"type": "claim", "region": VICTIM, "intent": "refactor"})

    attacker = FakeConn("a2", "dev")
    relay.join(ROOM, attacker)
    # Re-declare as the victim, then drop their lease.
    attacker.agent, attacker.human = "a1", "sara"
    relay.join(ROOM, attacker)
    relay.handle(attacker, {"type": "release", "region": VICTIM})

    assert holders(relay).get("src/auth.py") == "a1", "a1's lease was released by a2"


def test_a_renamed_connection_cannot_take_over_the_named_agents_claim():
    relay = Relay(VirtualClock(0.0))
    victim = FakeConn("a1", "sara")
    relay.join(ROOM, victim)
    relay.handle(victim, {"type": "claim", "region": VICTIM, "intent": "refactor"})

    attacker = FakeConn("a2", "dev")
    relay.join(ROOM, attacker)
    attacker.agent, attacker.human = "a1", "sara"
    relay.join(ROOM, attacker)
    reply = relay.handle(attacker, {"type": "claim", "region": VICTIM, "intent": "x"})

    # Either it is refused, or the relay never let the rename happen at all --
    # what it must not be is granted to a connection that is really a2.
    assert not (reply["granted"] and attacker.agent == "a1" and victim.agent == "a1")
    assert holders(relay).get("src/auth.py") == "a1"


# -- leases must not outlive the connection that took them -------------------


def test_a_rename_cannot_strand_the_first_identitys_leases():
    # leave() releases by conn.agent. If a rename sticks, the leases the
    # connection took under its first name have no owner left on the wire and
    # sit there until the TTL runs out.
    relay = Relay(VirtualClock(0.0))
    conn = FakeConn("a2", "dev")
    relay.join(ROOM, conn)
    relay.handle(conn, {"type": "claim", "region": MINE, "intent": "work"})

    conn.agent, conn.human = "a9", "someone"
    relay.join(ROOM, conn)
    relay.leave(conn)

    assert holders(relay) == {}, "disconnect left a lease behind: " + str(holders(relay))


# -- one connection, one room membership -------------------------------------


def test_moving_rooms_does_not_leave_the_connection_in_the_old_one():
    relay = Relay(VirtualClock(0.0))
    conn = FakeConn("a1", "sara")
    other = FakeConn("a2", "dev")
    relay.join("r1", conn)
    relay.join("r2", conn)
    relay.join("r1", other)

    relay.broadcast("r1", {"type": "presence"})
    assert conn.sent == [], "a connection that moved to r2 still gets r1 traffic"


def test_leaving_removes_the_connection_from_every_room():
    relay = Relay(VirtualClock(0.0))
    conn = FakeConn("a1", "sara")
    relay.join("r1", conn)
    relay.join("r2", conn)
    relay.leave(conn)

    relay.broadcast("r1", {"type": "presence"})
    relay.broadcast("r2", {"type": "presence"})
    assert conn.sent == [], "a closed connection is still on a member list"


def test_rejoining_the_same_room_does_not_duplicate_the_membership():
    relay = Relay(VirtualClock(0.0))
    conn = FakeConn("a1", "sara")
    other = FakeConn("a2", "dev")
    relay.join(ROOM, conn)
    relay.join(ROOM, conn)
    relay.join(ROOM, other)

    relay.broadcast(ROOM, {"type": "presence"}, exclude=other)
    assert len(conn.sent) == 1, f"one broadcast fanned out {len(conn.sent)} times"


# -- an unnamed connection cannot own anything -------------------------------


def test_a_connection_with_no_agent_id_is_not_admitted():
    # Two anonymous connections would share the identity "", so either one
    # could release the other's leases and either one disconnecting would drop
    # both. There is no safe way to hand a lease to a nameless connection.
    relay = Relay(VirtualClock(0.0))
    anon = FakeConn("", "")
    assert relay.join(ROOM, anon) is False
    assert relay.handle(anon, {"type": "claim", "region": MINE, "intent": "x"}) is None
    assert holders(relay) == {}


# -- the same rules over the wire --------------------------------------------


def test_the_websocket_session_does_not_let_a_join_frame_rename_a_connection():
    import asyncio

    from agent_presence.serve import _session

    class FakeWs:
        def __init__(self, frames: list[dict]) -> None:
            self._frames = [json.dumps(f) for f in frames]
            self.sent: list[str] = []

        async def __aiter__(self):
            for f in self._frames:
                yield f

        def __aiter__(self):  # noqa: F811 - async generator, defined once
            frames = self._frames

            async def gen():
                for f in frames:
                    yield f

            return gen()

        async def send(self, raw: str) -> None:
            self.sent.append(raw)

    relay = Relay(VirtualClock(0.0))
    victim = FakeConn("a1", "sara")
    relay.join(ROOM, victim)
    relay.handle(victim, {"type": "claim", "region": VICTIM, "intent": "refactor"})

    ws = FakeWs([
        {"type": "join", "room": ROOM, "agent": "a2", "human": "dev"},
        {"type": "join", "room": ROOM, "agent": "a1", "human": "sara"},
        {"type": "release", "region": VICTIM},
    ])
    asyncio.run(_session(ws, relay))

    assert holders(relay).get("src/auth.py") == "a1", "a2 released a1's lease"
