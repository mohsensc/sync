from __future__ import annotations

from typing import Protocol

from .clock import Clock
from .ladder import Activity, classify, interrupts_at
from .leases import PRESENCE_TTL_S, LeaseRegistry
from .negotiation import Negotiator
from .redact import redact
from .types import AgentEvent, Region


class Conn(Protocol):
    agent: str
    human: str
    room: str | None

    def send(self, payload: dict) -> None: ...


def _region(d: dict) -> Region:
    lines = d.get("lines")
    return Region(
        path=d["path"],
        symbol=d.get("symbol"),
        lines=tuple(lines) if lines else None,
    )


class Relay:
    """Sole authority on leases and the only place protocol decisions are made.

    Stateless across restarts by design: leases expire, so a relay restart
    degrades to 'nobody has protection for 90 seconds', never to a wedged team.
    """

    def __init__(self, clock: Clock) -> None:
        self._clock = clock
        self.registry = LeaseRegistry(clock)
        self._negotiator = Negotiator(self.registry, clock)
        self._members: dict[str, list[Conn]] = {}
        self._activity: dict[str, list[tuple[float, Activity]]] = {}
        self._last_ts: dict[str, float] = {}

    # -- membership ---------------------------------------------------------

    def join(self, room: str, conn: Conn) -> None:
        conn.room = room
        self._members.setdefault(room, []).append(conn)

    def leave(self, conn: Conn) -> None:
        room = conn.room
        if room is None:
            return
        members = self._members.get(room, [])
        if conn in members:
            members.remove(conn)
        # A dropped connection must not hold protection. Leases would expire
        # anyway; releasing now just makes recovery immediate.
        self.registry.release_all(conn.agent)
        conn.room = None

    def broadcast(
        self, room: str, payload: dict, exclude: Conn | None = None
    ) -> list[Conn]:
        targets = [c for c in self._members.get(room, []) if c is not exclude]
        for c in targets:
            c.send(payload)
        return targets

    # -- presence -----------------------------------------------------------

    def presence(self, room: str) -> list[Activity]:
        cutoff = self._clock.now() - PRESENCE_TTL_S
        kept = [(t, a) for (t, a) in self._activity.get(room, []) if t > cutoff]
        self._activity[room] = kept
        return [a for (_, a) in kept]

    def last_event_ts(self, room: str) -> float | None:
        return self._last_ts.get(room)

    # -- ingest -------------------------------------------------------------

    def handle(self, conn: Conn, message: dict) -> dict | None:
        room = conn.room
        if room is None:
            return None

        kind = message.get("type")
        if kind == "event":
            return self._on_event(room, conn, message)
        if kind == "claim":
            return self._on_claim(room, conn, message)
        if kind == "release":
            self.registry.release(message["agent"], _region(message["region"]))
            return None
        if kind == "heartbeat":
            self.registry.heartbeat(message["agent"], _region(message["region"]))
            return None
        if kind == "move":
            outcome = self._negotiator.apply(
                room, message["agent"], _region(message["region"]),
                message["move"], message.get("reason", ""),
            )
            return {"type": "move_result", "granted": outcome.granted,
                    "action": outcome.action}
        return None

    def _on_event(self, room: str, conn: Conn, message: dict) -> dict | None:
        clean = redact(message)
        now = self._clock.now()          # relay-assigned; client ts discarded
        self._last_ts[room] = now

        region = _region(clean["region"])
        event = AgentEvent(
            room=room, human=conn.human, agent=conn.agent, kind="touch",
            source=clean.get("source", "hook"), verb=clean["verb"],
            region=region, ts=now,
        )

        others = self.presence(room)
        rung = classify(event, others)

        self._activity.setdefault(room, []).append(
            (now, Activity(agent=conn.agent, human=conn.human, verb=event.verb,
                           region=region, intent=""))
        )

        self.broadcast(room, {"type": "presence", "agent": conn.agent,
                              "human": conn.human, "verb": event.verb,
                              "region": clean["region"], "rung": rung, "ts": now},
                       exclude=conn)

        if not interrupts_at(rung):
            return {"type": "ack", "rung": rung}

        brief = self._negotiator.open(room, conn.agent, now, region, "")
        if brief is None:
            return {"type": "ack", "rung": rung}
        return {
            "type": "negotiate", "rung": rung,
            "holder_agent": brief.holder_agent, "holder_human": brief.holder_human,
            "holder_intent": brief.holder_intent, "moves": list(brief.moves),
        }

    def _on_claim(self, room: str, conn: Conn, message: dict) -> dict:
        result = self.registry.acquire(
            room, message.get("human", conn.human), message["agent"],
            _region(message["region"]), message.get("intent", ""),
        )
        if result.ok:
            return {"type": "claim_result", "granted": True}
        return {
            "type": "claim_result", "granted": False,
            "held_by": result.held_by.agent, "intent": result.held_by.intent,
        }
