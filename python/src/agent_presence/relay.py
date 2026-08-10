from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Protocol

from .clock import Clock
from .ladder import Activity, Redundancy, classify, interrupts_at, redundant_peer
from .leases import PRESENCE_TTL_S, RESERVATION_S, LeaseRegistry
from .negotiation import MOVES, Negotiator
from .policy import PolicyFile, Resolution
from .principals import Grant, Roster
from .priority import PRIORITY_NORMAL, name_of
from .redact import (
    OPAQUE_MARK,
    clean_intent,
    clean_region_dict,
    opaque_enabled,
    redact,
)
from .types import AgentEvent, Claim, Contender, Region, Source

log = logging.getLogger("agent_presence.relay")


class Conn(Protocol):
    agent: str
    human: str
    room: str | None

    def send(self, payload: dict) -> None: ...


def _declared_str(conn: Conn, attr: str) -> str | None:
    """A claimed field off a connection, if the transport put one there.

    `principal`, `token` and `unattended` are optional on the join frame, so
    they are optional on the connection object too — a Conn that has never
    heard of them is an un-configured client, which is the common case and
    lands at `normal` like everything else.
    """
    value = getattr(conn, attr, None)
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value or None


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


def _source(value: object) -> Source:
    """Which channel an event claims to have come from.

    Narrowed to the two legal values rather than trusted, because the field
    decides rung 4 eligibility. An agent declaring intent about its own work is
    not an escalation - the intent is its own text about its own region - but
    an unrecognised string must not sail through into a Literal-typed field.
    """
    return "mcp" if value == "mcp" else "hook"


def redundancy_payload(red: Redundancy) -> dict:
    """A rung 4 hit, in the shape both channels hand back.

    Everything the second agent needs to decide for itself and nothing else:
    who is already on this, what they said they were doing, where, and the
    score that triggered it. The score travels so the interrupt is auditable -
    an agent that thinks the match is nonsense can see how close it was, and
    the override log is the tuning signal for the threshold.

    The moves are the rung 3 four, but they are advice here, not lease
    operations. Rung 4 fires on *different* paths, so there is no contested
    region for the negotiator to arbitrate: DEFER means wait and build on
    their work, SPLIT means take a different piece of it, PROCEED means the
    match is wrong. Nothing in the lease table changes either way.
    """
    return {
        "agent": red.agent,
        "human": red.human,
        "intent": red.intent,
        "region": _region_payload(red.region),
        "score": round(red.score, 3),
        "moves": list(MOVES),
        "advisory": True,
    }


def _lease_entry(claim: Claim, now: float) -> dict:
    """The body of a lease, shared by the `lease`, `leases` and `claim_result`
    frames because the daemon parses all three with the same `upsert_lease`.

    `expires_in_ms` is time remaining, never a deadline, and that is the field
    the daemon actually reads. LeaseCache is asked with the daemon's monotonic
    clock and the relay stamps wall clock seconds; the two have no relationship,
    so an absolute deadline on the wire would expire every lease on arrival or
    none of them ever. `expires_at` rides along on the relay's own clock for
    anything reading this off the wire directly.

    `priority` is here rather than on one frame that remembered it. The relay
    orders every contest by the tier stamped on the lease, and the daemon
    renders what the relay pushes; a body without it means `ap-hook` can name
    the holder and never say they outrank you. Always spelled out, `normal`
    included, so no reader needs a special case for a missing field.

    The handover fields travel for one reader: the holder itself. Its own lease
    comes back to it in every snapshot, and these are what let its daemon warn
    it — while it still has the region and can act — that the clock is running
    and who the region goes to. They are omitted entirely when nobody is
    waiting, which is the common case and the quiet one.
    """
    entry = {
        "agent": claim.agent,
        "human": claim.human,
        "intent": claim.intent,
        "priority": name_of(claim.priority),
        "region": _region_payload(claim.scope),
        "expires_in_ms": max(0, int((claim.expires_at - now) * 1000)),
        "expires_at": claim.expires_at,
    }
    winner = claim.handover_winner()
    if claim.handover_at is not None and winner is not None:
        entry.update({
            "handover_in_ms": max(0, int((claim.handover_at - now) * 1000)),
            "handover_at": claim.handover_at,
            "handover_to": winner.agent,
            "handover_to_human": winner.human,
            "handover_to_priority": name_of(winner.priority),
            "waiting": len(claim.contenders),
        })
    return entry


@dataclass(frozen=True)
class Refusal:
    """Why a join was refused, in a shape the client can act on.

    A refused join used to be silent: the relay logged a line on its own
    machine and dropped the frame, and the client sat waiting for a lease
    snapshot that was never coming until something else timed out. An agent
    cannot fix a name collision nobody told it about. `reason` is the stable
    slug to branch on; `detail` is the sentence to put in front of a person.

    Sent from the relay rather than handed back to the transport because the
    relay is where protocol decisions are made — it already writes the lease
    snapshot and the policy frame to `conn.send`, and this is one more.
    """

    reason: str
    detail: str

    def frame(self, room: str) -> dict:
        return {
            "type": "join_refused",
            "room": room,
            "reason": self.reason,
            "detail": self.detail,
        }


@dataclass(frozen=True)
class _Snapshot:
    """What a claim looked like before a registry call touched it."""

    room: str
    human: str
    intent: str
    expires_at: float
    handover_at: float | None
    winner: Contender | None

    def same_as(self, claim: Claim) -> bool:
        return (
            self.intent == claim.intent
            and self.expires_at == claim.expires_at
            and self.handover_at == claim.handover_at
            and self.winner == claim.handover_winner()
        )


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

    def _before(self) -> dict[tuple[str, Region], _Snapshot]:
        """Values, not Claim objects: `acquire` renews by mutating the claim in
        place, so holding a reference here would compare a claim against itself
        and a renewal would never look like a change.

        Reads `_claims` raw rather than `_live()` on purpose. Pruning first
        would make an expiry indistinguishable from "was never there", and the
        room would never be told the region is free again.

        `handover_at` and the winner are part of the compared value, not just
        carried along. The first contention on a fresh lease usually leaves
        `expires_at` exactly where it was — the deadline is a TTL away and so is
        the expiry — so keying on expiry alone meant the holder learned it was
        on the clock only at its next heartbeat. It should learn immediately;
        that is most of the time it has.
        """
        return {
            (c.agent, c.scope): _Snapshot(
                room=c.room, human=c.human, intent=c.intent,
                expires_at=c.expires_at, handover_at=c.handover_at,
                winner=c.handover_winner(),
            )
            for c in self._claims
        }

    def _publish(self, before: dict[tuple[str, Region], _Snapshot]) -> None:
        now = self._clock.now()
        after = {(c.agent, c.scope): c for c in self._live()}

        for key, claim in after.items():
            prev = before.get(key)
            if prev is not None and prev.same_as(claim):
                continue
            # New, or renewed. A renewal has to go out too: the daemon expires
            # its copy on the TTL it was last given, and a heartbeat the room
            # never hears about drops protection while the relay still holds it.
            frame = {"type": "lease", "state": "held"}
            frame.update(_lease_entry(claim, now))
            self._relay.publish(claim.room, frame)

        for (agent, scope), prev in before.items():
            if (agent, scope) in after:
                continue
            frame = {
                "type": "lease",
                # All three erase the entry daemon-side. The distinction is for
                # whoever is reading the wire, not for the cache.
                "state": "expired" if prev.expires_at <= now else "released",
                "agent": agent,
                "region": _region_payload(scope),
            }
            kept = self.reservation_for(prev.room, scope)
            if kept is not None and kept.from_agent == agent:
                # This lease did not just run out, it was handed on: somebody
                # asked for the region, the holder's renewals stopped at the
                # deadline it was given, and the region is being kept for the
                # agent that waited. Say so, and say to whom. A lease that
                # vanishes with "expired" and nothing else is the one event in
                # this system an agent cannot make sense of on its own — least
                # of all the agent it was taken from, which is the one reader
                # that has half-finished work sitting in that region.
                frame.update({
                    "state": "handover",
                    "to": kept.agent,
                    "to_human": kept.human,
                    "to_priority": name_of(kept.priority),
                    "reserved_for_ms": max(
                        0, int((kept.expires_at - now) * 1000)
                    ),
                    "from": agent,
                    "from_human": prev.human,
                })
                if prev.winner is not None:
                    frame["waited_s"] = max(
                        0.0, now - prev.winner.first_asked_at
                    )
            self._relay.publish(prev.room, frame)

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

    def contend(self, *args, **kwargs):
        # An ask moves the holder's deadline, and the holder is the one reader
        # that has to hear about that while it still has time to act on it.
        before = self._before()
        result = super().contend(*args, **kwargs)
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

    def __init__(
        self,
        clock: Clock,
        *,
        policy: PolicyFile | None = None,
        roster: Roster | None = None,
    ) -> None:
        self._clock = clock
        self._members: dict[str, list[Conn]] = {}
        self.registry = _PublishingRegistry(clock, self)
        self._negotiator = Negotiator(self.registry, clock)
        self._activity: dict[str, list[tuple[float, Activity]]] = {}
        self._last_ts: dict[str, float] = {}
        # Builtin plus org floors, and nothing else. The repo, user and session
        # layers are files on the client's disk that the relay cannot see, so
        # what it stamps on a frame is advisory and the daemon's own table is
        # what actually blocks. They can differ by the client's own local
        # strictness, which is fine; `ap doctor` reports it when it is not.
        self._policy = policy if policy is not None else PolicyFile.for_relay(clock)
        # What the room was last told the floor was. Live reload is only useful
        # if the change reaches the daemons, and they learn about it here.
        self._policy_digest = self._policy.current().digest
        self._roster = roster if roster is not None else Roster.discover()
        # Grant per connection, latched at join. Keyed on the object, so it dies
        # with the connection — same mechanism as `_identity`, and deliberately
        # not an attribute on Conn: nothing a client can write to may decide
        # what a client is entitled to.
        self._principal: dict[Conn, tuple[str | None, bool, Grant]] = {}
        # The connection currently being served, if any. Lease fan-out skips
        # it: it gets its own answer on the same socket, and a client waiting
        # on that answer must not have to skip past its own echo to find it.
        self._actor: Conn | None = None
        # Identity as first declared, per connection. Keyed on the object, so
        # it dies with the connection.
        self._identity: dict[Conn, tuple[str, str]] = {}

    # -- membership ---------------------------------------------------------

    def join(self, room: str, conn: Conn) -> bool:
        """Put a connection in a room. False means the join was refused, and the
        connection is told which of the four rules refused it and what to do.

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

        The grant is latched here too, by the same mechanism and for a sharper
        version of the same reason. A second join frame re-declaring a
        principal would be a live connection re-rating itself mid-session, and
        an agent that could do that could hold two claims at two tiers — which
        is exactly the asymmetry ``LeaseRegistry.acquire`` latches ``priority``
        to prevent.

        And the agent id itself is bound to that grant for as long as any
        connection holds it — see ``_bind_agent``. Latching per connection is
        not enough on its own, because the lease table is keyed on the agent id
        and nothing else.
        """
        if not conn.agent:
            log.debug("join with no agent id; refused")
            return self._refuse(conn, room, Refusal(
                "no-agent-id",
                "the join frame carried no agent id; set one and join again",
            ))

        declared = (conn.agent, conn.human)
        latched = self._identity.get(conn)
        fresh = latched is None
        if fresh:
            self._identity[conn] = declared
        elif declared != latched:
            # Put the real identity back before returning: the caller has
            # already written the claimed one onto the connection.
            conn.agent, conn.human = latched
            log.warning(
                "refused identity change on a live connection: %s -> %s",
                latched[0], declared[0],
            )
            return self._refuse(conn, room, Refusal(
                "identity-latched",
                f"this connection is {latched[0]} and stays {latched[0]}; "
                "open a second connection to join as somebody else",
            ))

        refusal = self._latch_grant(conn, room)
        if refusal is not None:
            if fresh:
                self._identity.pop(conn, None)
            return self._refuse(conn, room, refusal)

        refusal = self._bind_agent(conn)
        if refusal is not None:
            if fresh:
                self._principal.pop(conn, None)
                self._identity.pop(conn, None)
            return self._refuse(conn, room, refusal)

        # One connection, one room membership. Without the sweep a connection
        # that moves rooms keeps receiving the old room's traffic forever,
        # because `leave` only ever cleans up conn.room.
        for members in self._members.values():
            while conn in members:
                members.remove(conn)

        # Before the joiner is a member, so a change picked up here fans out to
        # the room that already exists and the joiner gets its own copy below
        # rather than two.
        self._publish_policy_change()

        conn.room = room
        self._members.setdefault(room, []).append(conn)
        self._send_lease_snapshot(conn, room)
        # Only when there is an org policy to state. A relay with no org file
        # has nothing to say that the daemon's compiled-in floor does not
        # already say, and saying it anyway would put a new frame on the wire
        # of every install that configured nothing — which is exactly what
        # test_golden_noop.py exists to forbid.
        frame = self._policy_frame()
        if frame is not None:
            conn.send(frame)
        return True

    def _refuse(self, conn: Conn, room: str, refusal: Refusal) -> bool:
        """Tell the client why, then refuse. Always returns False."""
        conn.send(refusal.frame(room))
        return False

    def _policy_frame(self) -> dict | None:
        """The org floor, as this relay currently reads it.

        Only the floor travels. Effects are the client's business — the relay
        cannot see this machine's repo, user or session layers — but a floor
        composes with whatever the client resolved locally by taking the louder
        of the two, which is well defined without knowing what the other side
        said. `cpp/daemon/policy_cache.cpp` is what reads this.
        """
        policy = self._policy.current()
        org = policy.layer("org")
        if org is None:
            return None
        return {
            "type": "policy",
            "floor": policy.floor_table("").names(),
            "source": f"org:{org.source}",
            "digest": policy.digest,
        }

    def _publish_policy_change(self) -> bool:
        """Push a new org floor to every room, if there is one.

        This is what makes "saved is applied" true for the org layer without a
        restart: `PolicyFile.current()` re-reads the file when its mtime moves,
        and the first frame handled after that carries the new floor to every
        daemon attached. Nothing polls and nothing is scheduled — the relay only
        does work when something happens, and when nothing is happening there is
        nobody whose edit the new floor would have changed.
        """
        digest = self._policy.current().digest
        if digest == self._policy_digest:
            return False
        self._policy_digest = digest
        frame = self._policy_frame()
        if frame is None:
            # The org file went away. The floor drops back to the compiled-in
            # one, which every daemon already has, so there is nothing to send.
            return False
        log.info("org policy changed (%s); republishing the floor", digest[:12])
        for room in list(self._members):
            self.broadcast(room, frame)
        return True

    # -- priority -----------------------------------------------------------

    def _latch_grant(self, conn: Conn, room: str) -> Refusal | None:
        """Authenticate once, remember forever. None means carry on; a Refusal
        means refuse the join and tell the client why."""
        principal = _declared_str(conn, "principal")
        unattended = getattr(conn, "unattended", False) is True

        latched = self._principal.get(conn)
        if latched is None:
            grant = self._roster.authenticate(
                principal, _declared_str(conn, "token"), room=room
            )
            self._principal[conn] = (principal, unattended, grant)
            if grant.authenticated:
                log.info(
                    "principal %s joined room %s at %s",
                    grant.principal, room, grant.tier_name(unattended=unattended),
                )
            return None

        prev_principal, prev_unattended, _grant = latched
        if (principal, unattended) != (prev_principal, prev_unattended):
            # Put the latched values back, like the identity check does, so a
            # re-rate attempt leaves nothing behind on the connection either.
            with_principal = getattr(conn, "principal", None)
            if with_principal is not None or prev_principal is not None:
                conn.principal = prev_principal  # type: ignore[attr-defined]
            conn.unattended = prev_unattended    # type: ignore[attr-defined]
            log.warning(
                "refused principal change on a live connection: %s -> %s",
                prev_principal, principal,
            )
            return Refusal(
                "principal-latched",
                f"this connection authenticated as {prev_principal or 'nobody'} "
                "and cannot re-rate itself; open a second connection",
            )
        return None

    def _bind_agent(self, conn: Conn) -> Refusal | None:
        """One agent id, one grant, for as long as anybody holds it.

        This is the check that closes priority laundering, and it is worth
        knowing exactly what it closes. The lease table is keyed on the agent id
        alone — it has to be, because ``age_of`` and ``priority_of`` are what
        make the wait-for relation a strict total order, and a room-scoped or
        connection-scoped version of either one reintroduces the asymmetry that
        lets a wait cycle open (``wait_die`` §deadlock, ``leases.priority_of``).
        So ``acquire`` reads an agent's tier off that agent's live claims.

        Which meant the agent id *was* the credential. An unauthenticated client
        that declared ``presenced@sara-mbp`` — a string the relay broadcasts on
        every presence frame and hands out in the join snapshot, and the stock
        default of ``presenced@<hostname>`` — inherited sara's ``critical`` in
        whatever room it liked, beat older normal-tier agents in wait-die, and
        forced them to abort and drop live leases. It kept the tier after sara
        disconnected, laundered out of its own claims.

        Both halves are needed and this is the second one. A grant latched per
        connection says nothing about a *different* connection wearing the same
        name, and the lease table cannot tell them apart.

        Two connections may share an id — that is the ordinary case, two
        checkouts on one laptop under the default ``presenced@<hostname>`` — as
        long as they present the same principal and land on the same tier.
        Differ on either and one of them is refused.

        Which one is refused is not arbitrary. An unauthenticated squatter that
        got there first would otherwise lock a rostered principal out of its own
        id, so the authenticated principal takes it and the squatter is dropped:
        off its rooms, leases released, so nothing it laundered survives. Only
        when *both* sides are authenticated as different principals does the
        incumbent keep the id and the newcomer get refused — two rostered
        principals sharing one agent id is a configuration mistake, and picking
        a winner there would just make it silent.
        """
        agent, grant = conn.agent, self.grant_of(conn)
        tier = self.priority_of(conn)

        for other in list(self._identity):
            mine = self._identity.get(other)
            if other is conn or mine is None or mine[0] != agent:
                continue
            theirs = self.grant_of(other)
            if (theirs.principal, self.priority_of(other)) == (grant.principal, tier):
                continue
            if theirs.authenticated:
                log.warning(
                    "refused join: agent id %s is principal %s's, at %s",
                    agent, theirs.principal, name_of(self.priority_of(other)),
                )
                return Refusal(
                    "agent-id-taken",
                    f"agent id {agent!r} is already in use on this relay by "
                    "another principal; pick a different one (set "
                    "AGENT_PRESENCE_AGENT) and join again",
                )
            # Incumbent is unauthenticated and this one is not. Evict it.
            log.warning(
                "agent id %s reclaimed by principal %s; dropping the "
                "unauthenticated connection holding it",
                agent, grant.principal,
            )
            self.leave(other)
        return None

    def authenticate(
        self, principal: str | None, token: str, room: str
    ) -> Grant:
        """Resolve a grant from the roster this relay read off disk.

        For channels that are not websocket connections. The MCP tool surface is
        one: it holds `relay.registry` directly, and until this existed it
        claimed at `normal` no matter what the roster said — so an exec who put
        themselves at `critical`, minted a token and installed it got seniority
        on the hook path and not on the deliberate one. Configure once has to
        mean once.
        """
        return self._roster.authenticate(principal, token, room=room)

    def grant_of(self, conn: Conn) -> Grant:
        latched = self._principal.get(conn)
        if latched is None:
            return Grant(
                principal=None, attended=PRIORITY_NORMAL,
                unattended=PRIORITY_NORMAL, reason="no-roster",
            )
        return latched[2]

    def unattended_of(self, conn: Conn) -> bool:
        latched = self._principal.get(conn)
        return latched[1] if latched is not None else False

    def priority_of(self, conn: Conn) -> int:
        """The tier this connection is entitled to.

        Note what is *not* read here: the message body. A claim frame carrying
        ``"priority": "critical"`` is ignored the same way a claim frame
        carrying someone else's agent id is ignored — the only inputs are the
        roster the relay read off disk and the one supervision bit the join
        frame latched, and that bit only selects inside the band the roster
        already granted.
        """
        return self.grant_of(conn).priority(unattended=self.unattended_of(conn))

    def resolve_policy(self, conn: Conn, rung: int, path: str) -> Resolution:
        return self._policy.current().resolve(
            rung, path, unattended=self.unattended_of(conn)
        )

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
        room = conn.room
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
        #
        # Only this connection's room. The same agent id can be live in another
        # room on another socket — two checkouts on one laptop share the default
        # presenced@<hostname> — and that room's leases have nothing to do with
        # this socket hanging up.
        identity = self._identity.pop(conn, None)
        self._principal.pop(conn, None)
        if identity is not None and room is not None:
            self.registry.release_all(room, identity[0])
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

    # -- rung 4 -------------------------------------------------------------

    def declared_work(self, room: str) -> list[Activity]:
        """Every live MCP-declared intent in the room.

        Live claims, not presence activity, because a claim is the only thing
        an agent ever attaches an intent to. Presence comes off hooks, which
        observe a path and a verb and can never know *why*. Claims also expire
        on the lease TTL, so a rung 4 match is always against work somebody is
        still doing.
        """
        return [
            Activity(agent=c.agent, human=c.human, verb="edit",
                     region=c.scope, intent=c.intent, source="mcp")
            for c in self.registry.active_claims(room)
            if c.intent
        ]

    def check_redundancy(
        self, room: str, agent: str, human: str, region: Region, intent: str
    ) -> Redundancy | None:
        """Is somebody else already doing this, somewhere else in the tree?

        Both declaration channels land here - the wire `claim` frame and the
        MCP `claim_work` tool - so they cannot drift. Returns None whenever the
        flag is off, which is the default and is checked inside the ladder
        before any text is compared.

        The ladder decides, not this method: `classify` has to actually return
        4 before the match is looked up, so the rung the relay reports and the
        rung the ladder computes are the same number by construction.
        """
        peers = self.declared_work(room)
        probe = AgentEvent(
            room=room, human=human, agent=agent, kind="claim", source="mcp",
            verb="edit", region=region, ts=self._clock.now(),
        )
        if classify(probe, peers, intent) != 4:
            return None
        return redundant_peer(probe, peers, intent)

    # -- ingest -------------------------------------------------------------

    def handle(self, conn: Conn, message: dict) -> dict | None:
        # Anything this frame does to the lease table fans out to the rest of
        # the room, never back to the sender. Cleared in `finally` so a raised
        # handler cannot leave a stale connection excluded from the next one.
        self._actor = conn
        try:
            # Live reload, on the only clock the relay has. PolicyFile gates its
            # own stat at one a second, so this costs a comparison per frame in
            # the steady state and one file read when somebody edits the org
            # policy. The broadcast goes out before the frame is dispatched so
            # the answer this connection is about to get and the floor the room
            # is holding cannot disagree.
            self._publish_policy_change()
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
                requester_priority=self.priority_of(conn),
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
        # Hooks never carry one; only an MCP-sourced event does, and only that
        # kind can reach rung 4.
        intent = clean_intent(clean.get("intent"))
        event = AgentEvent(
            room=room, human=conn.human, agent=conn.agent, kind="touch",
            source=_source(clean.get("source")), verb=clean["verb"],
            region=region, ts=now,
        )

        others = self.presence(room)
        rung = classify(event, others, intent)

        self._activity.setdefault(room, []).append(
            (now, Activity(agent=conn.agent, human=conn.human, verb=event.verb,
                           region=region, intent=intent, source=event.source))
        )

        self.broadcast(room, {"type": "presence", "agent": conn.agent,
                              "human": conn.human, "verb": event.verb,
                              "region": clean["region"], "rung": rung, "ts": now},
                       exclude=conn)

        # Policy decides how loudly this rung is told. It does not decide the
        # rung, and it never reaches the lease table: `classify` above and
        # `Negotiator.open` below run exactly as they did before, whatever the
        # effect turns out to be.
        resolution = self.resolve_policy(conn, rung, region.path)
        effect = resolution.effect

        # Rung 4 always asks the negotiator, whatever its effect says. The
        # effect governs how loudly a *text match* is reported; it cannot decide
        # whether there is a lease underneath, and only the negotiator knows
        # that. Rungs 0-3 are the effect's business alone.
        if not interrupts_at(rung, effect) and rung != 4:
            return {"type": "ack", "rung": rung, "effect": effect}

        # A lease conflict on this exact region outranks a text match on a
        # different one. Rung 3 is a fact; rung 4 is an inference, and when
        # both are true the agent should be told about the certain one.
        brief = self._negotiator.open(
            room, conn.agent, self.registry.age_of(conn.agent), region, "",
            requester_priority=self.priority_of(conn),
            requester_human=conn.human,
        )
        if brief is None:
            # Note this compares against presence only, not against live claims -
            # `others` is what the ladder was handed for rungs 0-3 and folding
            # claims into it would change those rungs, which is not this feature's
            # business. So an event matches other events and a claim matches other
            # claims. Nothing emits an MCP-sourced event today, so in practice rung
            # 4 arrives through `_on_claim`; if the daemon ever starts forwarding
            # intent as events, the two peer sets want unifying.
            if rung == 4 and effect != "silent":
                red = redundant_peer(event, others, intent)
                if red is not None:
                    frame = {
                        "type": "redundant_work", "rung": 4,
                        "effect": effect,
                        "effect_source": resolution.winning_layer,
                    }
                    frame.update(redundancy_payload(red))
                    return frame
            return {"type": "ack", "rung": rung, "effect": effect}
        frame = {
            "type": "negotiate", "rung": rung,
            "holder_agent": brief.holder_agent, "holder_human": brief.holder_human,
            "holder_intent": brief.holder_intent, "moves": list(brief.moves),
            "decision": brief.decision,
            "effect": effect,
            "effect_source": resolution.winning_layer,
            "priority": name_of(brief.requester_priority),
            "holder_priority": name_of(brief.holder_priority),
        }
        if brief.handover_at is not None:
            # How long DEFER actually costs. Without it DEFER and "give up" read
            # the same to whoever is choosing between the four moves.
            frame["handover_in_ms"] = max(
                0, int((brief.handover_at - now) * 1000)
            )
            frame["handover_to"] = brief.handover_to
            if brief.handover_to == conn.agent:
                frame["retry_in_ms"] = frame["handover_in_ms"]
                frame["reserved_for_ms"] = int(RESERVATION_S * 1000)
        return frame

    def _on_claim(
        self, room: str, conn: Conn, message: dict, region: Region
    ) -> dict:
        intent = clean_intent(message.get("intent"))
        # The tier comes off the latched grant, never off `message`. A claim
        # frame naming its own priority is ignored exactly the way a claim frame
        # naming somebody else's agent id is ignored.
        result = self.registry.acquire(
            room, conn.human, conn.agent, region, intent,
            priority=self.priority_of(conn),
        )
        now = self._clock.now()

        # The reply carries the lease body as well as the verdict, because the
        # daemon upserts its own cache straight out of claim_result. With no
        # region on the frame there is nothing to key it by, and the one agent
        # guaranteed to care about this region learns nothing from the answer.
        if result.ok:
            granted = {"type": "claim_result", "granted": True}
            # `priority` comes with the body now; it used to be bolted on here
            # and nowhere else, which is how the fan-out lost it.
            granted.update(_lease_entry(result.claim, now))
            # The lease is granted either way. Rung 4 is not contention - the
            # paths are disjoint, so there is nothing to arbitrate - it is the
            # news that somebody else already declared this work, delivered at
            # the one moment the agent is still deciding what to do.
            # Same volume knob as the event path: rung 4's effect says how
            # loudly a text match is reported, and `silent` means the agent is
            # told nothing. The lease itself is unaffected either way.
            rung4_effect = self.resolve_policy(conn, 4, region.path).effect
            if rung4_effect != "silent":
                red = self.check_redundancy(room, conn.agent, conn.human,
                                            region, intent)
                if red is not None:
                    granted["rung"] = 4
                    granted["redundant"] = redundancy_payload(red)
                    log.info("rung 4: %s duplicates %s (%.3f) room=%s",
                             conn.agent, red.agent, red.score, room)
            return granted

        # Refusal alone is not enough: without an instruction two agents can
        # both sit and retry forever. Wait-die says exactly one of them backs
        # off and the other dies, and the loser's leases in *this* room have to
        # actually go so it is not holding anything while it retries. Leases the
        # same agent id holds in another room are not part of this contest.
        #
        # Read the tier before the abort sweep: release_all drops the claims
        # priority_of reads it off, and a loser told its own tier was `normal`
        # when it was `elevated` learns the wrong thing about why it lost.
        requester_priority = self.registry.priority_of(
            conn.agent, default=self.priority_of(conn)
        )

        if result.decision == "abort":
            self.registry.release_all(room, conn.agent)

        # A refused claim is a rung 3 by definition: a relay-granted lease on a
        # contending region. The effect is advisory here — the daemon's own
        # table is what blocks the edit — but it is what the MCP and web
        # surfaces render, so it travels.
        resolution = self.resolve_policy(conn, 3, region.path)

        reply = {
            "type": "claim_result", "granted": False,
            "decision": result.decision,
            "effect": resolution.effect,
            "effect_source": resolution.winning_layer,
            # Both tiers by name, so a blocked agent can be told why it lost
            # rather than only that it did.
            "priority": name_of(requester_priority),
            # The region asked for, not the holder's scope. A whole-file lease
            # refusing a symbol-level claim has to land under the key the hook
            # will look up, which is the one on the request.
            "region": _region_payload(region),
        }

        held = result.held_by
        if held is None:
            # Nobody holds it: a handover freed it seconds ago and it is being
            # kept for the agent that waited it out. Answered in the same shape
            # as a held region, with the reserved agent standing in as the
            # holder, because that is the shape every reader already handles and
            # the instruction — do not edit this yet, here is when — is the same
            # one. `retry_in_ms` is the whole answer, and it is short.
            kept = result.reserved_by
            reply.update({
                "held_by": kept.agent,
                "human": kept.human,
                "intent": "taking over this region",
                "holder_priority": name_of(kept.priority),
                "reserved": True,
                "reserved_from": kept.from_agent,
                "reserved_from_human": kept.from_human,
                "expires_in_ms": max(0, int((kept.expires_at - now) * 1000)),
                "expires_at": kept.expires_at,
                "retry_in_ms": max(0, int((kept.expires_at - now) * 1000)),
            })
            return reply

        reply.update({
            "held_by": held.agent,
            # `human` is the name decide.cpp renders to the blocked agent.
            "human": held.human,
            "intent": held.intent,
            "holder_priority": name_of(held.priority),
            "expires_in_ms": max(0, int((held.expires_at - now) * 1000)),
            "expires_at": held.expires_at,
        })

        # When this agent is the one the region is queued for, say so and say
        # when. A `wait` with no number is the verdict an agent cannot act on:
        # it has no way to tell "try again shortly" from "this is never coming",
        # so it either spins or gives up, and both used to be correct.
        winner = held.handover_winner()
        if held.handover_at is not None and winner is not None:
            handover_in_ms = max(0, int((held.handover_at - now) * 1000))
            reply["waiting"] = len(held.contenders)
            if winner.agent == conn.agent:
                reply.update({
                    "handover_in_ms": handover_in_ms,
                    "handover_at": held.handover_at,
                    # The region is yours after this, and kept for you while you
                    # come back for it. Retry once, not in a loop.
                    "retry_in_ms": handover_in_ms,
                    "reserved_for_ms": int(RESERVATION_S * 1000),
                })
            else:
                reply.update({
                    "handover_in_ms": handover_in_ms,
                    "handover_at": held.handover_at,
                    "handover_to": winner.agent,
                    "handover_to_human": winner.human,
                    "handover_to_priority": name_of(winner.priority),
                })
        return reply
