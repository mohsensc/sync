from __future__ import annotations

import logging
from typing import Protocol

from .clock import Clock
from .ladder import Activity, classify, interrupts_at
from .leases import PRESENCE_TTL_S, LeaseRegistry
from .negotiation import Negotiator
from .redact import (
    OPAQUE_MARK,
    clean_intent,
    clean_region_dict,
    opaque_enabled,
    redact,
)
from .types import AgentEvent, Claim, Region

log = logging.getLogger("agent_presence.relay")


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


def _wire_region(message: dict, key: str = "region") -> Region | None:
    """A region off a non-event frame. Same allowlist and same opaque hashing
    the event path gets, because a claim reaches just as far as a touch does."""
    d = clean_region_dict(message.get(key))
    return _region(d) if d is not None else None


def _region_payload(region: Region) -> dict:
    """A region on its way out, in the shape cpp/daemon/relay_client.cpp reads.

    path and symbol are always spelled out. A null symbol is how the daemon
    spells "the whole file": `str_field` gives back an empty string for it, so
    the cache key is `path + "|"`, which is exactly the prefix
    `LeaseCache::conflict_for_file` matches on.

    The opaque mark matters. Regions in the registry arrived through
    `clean_region_dict`, so under opaque mode they are already hashed; without
    the mark `opaque_outbound` hashes them a second time on the way out and
    every daemon caches a key the relay never arbitrates on.
    """
    payload: dict = {
        "path": region.path,
        "symbol": region.symbol,
        "lines": list(region.lines) if region.lines else None,
    }
    if opaque_enabled():
        payload[OPAQUE_MARK] = True
    return payload


def _lease_entry(claim: Claim, now: float) -> dict:
    """The body of a lease, shared by the `lease`, `leases` and `claim_result`
    frames because the daemon parses all three with the same `upsert_lease`.

    `expires_in_ms` is time remaining, never a deadline, and that is the field
    the daemon actually reads. LeaseCache is asked with the daemon's monotonic
    clock and the relay stamps wall clock seconds; the two have no relationship,
    so an absolute deadline on the wire would expire every lease on arrival or
    none of them ever. `expires_at` rides along on the relay's own clock for
    anything reading this off the wire directly.
    """
    return {
        "agent": claim.agent,
        "human": claim.human,
        "intent": claim.intent,
        "region": _region_payload(claim.scope),
        "expires_in_ms": max(0, int((claim.expires_at - now) * 1000)),
        "expires_at": claim.expires_at,
    }


class _PublishingRegistry(LeaseRegistry):
    """A LeaseRegistry that tells the room what changed.

    The relay used to grant a lease and answer the claimer alone. Every other
    daemon's LeaseCache stayed empty, so every hook lookup missed and no agent
    was ever told to stop — the ladder was live and had nothing to act on.

    This sits under the registry rather than in the handlers because the MCP
    tools hold `relay.registry` and mutate it directly. Publishing from
    `handle` alone would leave the tool channel silent, which is the same bug
    with a smaller blast radius.

    Diffing rather than announcing at each call site: SPLIT and HANDOFF change
    leases from inside Negotiator, and lazy expiry drops them with nobody
    calling anything. A diff catches all of it in one place.
    """

    def __init__(self, clock: Clock, relay: "Relay") -> None:
        super().__init__(clock)
        self._relay = relay

    def _before(self) -> dict[tuple[str, Region], tuple[str, str, str, float]]:
        """Values, not Claim objects: `acquire` renews by mutating the claim in
        place, so holding a reference here would compare a claim against itself
        and a renewal would never look like a change.

        Reads `_claims` raw rather than `_live()` on purpose. Pruning first
        would make an expiry indistinguishable from "was never there", and the
        room would never be told the region is free again.
        """
        return {
            (c.agent, c.scope): (c.room, c.human, c.intent, c.expires_at)
            for c in self._claims
        }

    def _publish(self, before: dict) -> None:
        now = self._clock.now()
        after = {(c.agent, c.scope): c for c in self._live()}

        for key, claim in after.items():
            prev = before.get(key)
            if prev is not None and (prev[2], prev[3]) == (claim.intent,
                                                           claim.expires_at):
                continue
            # New, or renewed. A renewal has to go out too: the daemon expires
            # its copy on the TTL it was last given, and a heartbeat the room
            # never hears about drops protection while the relay still holds it.
            frame = {"type": "lease", "state": "held"}
            frame.update(_lease_entry(claim, now))
            self._relay.publish(claim.room, frame)

        for (agent, scope), (room, _human, _intent, expires_at) in before.items():
            if (agent, scope) in after:
                continue
            self._relay.publish(room, {
                "type": "lease",
                # Both erase the entry daemon-side. The distinction is for
                # whoever is reading the wire, not for the cache.
                "state": "expired" if expires_at <= now else "released",
                "agent": agent,
                "region": _region_payload(scope),
            })

    def acquire(self, *args, **kwargs):
        before = self._before()
        result = super().acquire(*args, **kwargs)
        self._publish(before)
        return result

    def heartbeat(self, *args, **kwargs):
        before = self._before()
        result = super().heartbeat(*args, **kwargs)
        self._publish(before)
        return result

    def release(self, *args, **kwargs):
        before = self._before()
        result = super().release(*args, **kwargs)
        self._publish(before)
        return result

    def release_all(self, *args, **kwargs):
        before = self._before()
        result = super().release_all(*args, **kwargs)
        self._publish(before)
        return result


class Relay:
    """Sole authority on leases and the only place protocol decisions are made.

    Stateless across restarts by design: leases expire, so a relay restart
    degrades to 'nobody has protection for 90 seconds', never to a wedged team.
    """

    def __init__(self, clock: Clock) -> None:
        self._clock = clock
        self._members: dict[str, list[Conn]] = {}
        self.registry = _PublishingRegistry(clock, self)
        self._negotiator = Negotiator(self.registry, clock)
        self._activity: dict[str, list[tuple[float, Activity]]] = {}
        self._last_ts: dict[str, float] = {}
        # The connection currently being served, if any. Lease fan-out skips
        # it: it gets its own answer on the same socket, and a client waiting
        # on that answer must not have to skip past its own echo to find it.
        self._actor: Conn | None = None
        # Identity as first declared, per connection. Keyed on the object, so
        # it dies with the connection.
        self._identity: dict[Conn, tuple[str, str]] = {}

    # -- membership ---------------------------------------------------------

    def join(self, room: str, conn: Conn) -> bool:
        """Put a connection in a room. False means the join was refused.

        Identity is latched here and never changes for the life of the
        connection. `handle` already refuses to read identity off a message
        body — a second join frame is that same client-supplied field wearing a
        different hat, and honouring it would let one socket re-declare itself
        as a teammate and then claim, renew or release that teammate's leases.
        It also strands leases: `leave` releases by the connection's *current*
        agent, so anything taken under the old name has nobody left to drop it.

        A connection with no agent id is refused outright. Two of those would
        share the identity "", which means either could release the other's
        leases and either one hanging up would take both sets down.
        """
        if not conn.agent:
            log.debug("join with no agent id; refused")
            return False

        declared = (conn.agent, conn.human)
        latched = self._identity.get(conn)
        if latched is None:
            self._identity[conn] = declared
        elif declared != latched:
            # Put the real identity back before returning: the caller has
            # already written the claimed one onto the connection.
            conn.agent, conn.human = latched
            log.warning(
                "refused identity change on a live connection: %s -> %s",
                latched[0], declared[0],
            )
            return False

        # One connection, one room membership. Without the sweep a connection
        # that moves rooms keeps receiving the old room's traffic forever,
        # because `leave` only ever cleans up conn.room.
        for members in self._members.values():
            while conn in members:
                members.remove(conn)

        conn.room = room
        self._members.setdefault(room, []).append(conn)
        self._send_lease_snapshot(conn, room)
        return True

    def _send_lease_snapshot(self, conn: Conn, room: str) -> None:
        """Tell a joiner what this relay holds. Always, even when it is nothing.

        Incremental frames only ever reach whoever was already in the room, so
        without this a daemon that connects after a claim never learns about it
        and its hook waves the edit through. The daemon replaces its whole table
        from this frame — `relay_client.cpp` clears `held_` and refills it — so
        this is a reconciliation against the authority, not a top-up.

        The empty case is the one that matters most. The relay is stateless
        across restarts by design, so a restarted one comes back holding
        nothing; the daemons do not, and they go on enforcing what they cached.
        Staying quiet used to leave them blocking edits on a lease nobody holds
        until their own copy aged out, up to the full 90 second TTL. An empty
        `leases` array says "the authority holds none", which is a fact, and it
        clears the cache in the time a reconnect takes.
        """
        now = self._clock.now()
        held = self.registry.active_claims(room)
        conn.send({"type": "leases",
                   "leases": [_lease_entry(c, now) for c in held]})

    def leave(self, conn: Conn) -> None:
        for members in self._members.values():
            while conn in members:
                members.remove(conn)
        # A dropped connection must not hold protection. Leases would expire
        # anyway; releasing now just makes recovery immediate. Identity was
        # latched at join, so this is guaranteed to name whoever took them.
        #
        # The connection is off every member list before the release, so the
        # release frames go to everyone still there and not to the socket that
        # just died.
        identity = self._identity.pop(conn, None)
        if identity is not None:
            self.registry.release_all(identity[0])
        conn.room = None

    def broadcast(
        self, room: str, payload: dict, exclude: Conn | None = None
    ) -> list[Conn]:
        targets = [c for c in self._members.get(room, []) if c is not exclude]
        for c in targets:
            c.send(payload)
        return targets

    def publish(self, room: str, payload: dict) -> None:
        """Fan-out from the lease table.

        The connection being served is skipped for its *own* leases only. It
        already gets claim_result or move_result on the same socket, and a
        client waiting on that answer should not have to skip past its own echo
        to find it. Anyone else's lease still goes to it — one frame can prune
        a stranger's expired lease, and the connection that happened to trigger
        the prune needs that news as much as the rest of the room.
        """
        actor = self._actor
        mine = actor is not None and actor.agent == payload.get("agent")
        self.broadcast(room, payload, exclude=actor if mine else None)

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
        # Anything this frame does to the lease table fans out to the rest of
        # the room, never back to the sender. Cleared in `finally` so a raised
        # handler cannot leave a stale connection excluded from the next one.
        self._actor = conn
        try:
            return self._dispatch(conn, message)
        finally:
            self._actor = None

    def _dispatch(self, conn: Conn, message: dict) -> dict | None:
        room = conn.room
        if room is None:
            return None

        # conn.agent is the authenticated identity. message["agent"] is
        # whatever the client typed, so it is never trusted for anything that
        # touches a lease — otherwise any room member could drop, renew or
        # steal a teammate's claim by naming them.
        kind = message.get("type")
        if kind == "event":
            return self._on_event(room, conn, message)
        if kind not in ("claim", "release", "heartbeat", "move"):
            return None

        # Every remaining frame carries a region, and every one of them used to
        # take it straight off the wire. A region with no usable path is dropped
        # rather than guessed at.
        region = _wire_region(message)
        if region is None:
            return None

        if kind == "claim":
            return self._on_claim(room, conn, message, region)
        if kind == "release":
            self.registry.release(room, conn.agent, region)
            return None
        if kind == "heartbeat":
            self.registry.heartbeat(room, conn.agent, region)
            return None
        if kind == "move":
            outcome = self._negotiator.apply(
                room, conn.agent, region,
                message.get("move", ""), clean_intent(message.get("reason")),
                split_scope=_wire_region(message, "split_region"),
            )
            reply = {"type": "move_result", "granted": outcome.granted,
                     "action": outcome.action}
            if outcome.error is not None:
                reply["error"] = outcome.error
            return reply
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

        brief = self._negotiator.open(
            room, conn.agent, self.registry.age_of(conn.agent), region, "",
        )
        if brief is None:
            return {"type": "ack", "rung": rung}
        return {
            "type": "negotiate", "rung": rung,
            "holder_agent": brief.holder_agent, "holder_human": brief.holder_human,
            "holder_intent": brief.holder_intent, "moves": list(brief.moves),
            "decision": brief.decision,
        }

    def _on_claim(
        self, room: str, conn: Conn, message: dict, region: Region
    ) -> dict:
        result = self.registry.acquire(
            room, conn.human, conn.agent,
            region, clean_intent(message.get("intent")),
        )
        now = self._clock.now()

        # The reply carries the lease body as well as the verdict, because the
        # daemon upserts its own cache straight out of claim_result. With no
        # region on the frame there is nothing to key it by, and the one agent
        # guaranteed to care about this region learns nothing from the answer.
        if result.ok:
            granted = {"type": "claim_result", "granted": True}
            granted.update(_lease_entry(result.claim, now))
            return granted

        # Refusal alone is not enough: without an instruction two agents can
        # both sit and retry forever. Wait-die says exactly one of them backs
        # off and the other dies, and the loser's leases have to actually go,
        # or the wait-for graph keeps its cycle.
        if result.decision == "abort":
            self.registry.release_all(conn.agent)

        held = result.held_by
        return {
            "type": "claim_result", "granted": False,
            "held_by": held.agent,
            # `human` is the name decide.cpp renders to the blocked agent.
            "human": held.human,
            "intent": held.intent,
            "decision": result.decision,
            # The region asked for, not the holder's scope. A whole-file lease
            # refusing a symbol-level claim has to land under the key the hook
            # will look up, which is the one on the request.
            "region": _region_payload(region),
            "expires_in_ms": max(0, int((held.expires_at - now) * 1000)),
            "expires_at": held.expires_at,
        }
