"""The scenarios. Each one starts what it needs, hammers it, and returns
numbers plus a list of things that went wrong.

A scenario never fixes anything and never asserts inside the product. It
measures and reports, because the whole point is to find out where this falls
over, not to prove it doesn't.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import os
import socket
import struct
import subprocess
import tempfile
import time
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

from _lib import (
    AP_HOOK,
    TLS_ENABLED,
    Client,
    DaemonProc,
    Latency,
    RelayProc,
    cpu_seconds,
    dev_client_ssl_context,
    event_line,
    pct,
    probe_leases,
    rss_kb,
)

HOOKBENCH = Path(__file__).resolve().parent / "build" / "hookbench"


@dataclass
class Result:
    name: str
    metrics: dict = field(default_factory=dict)
    findings: list[str] = field(default_factory=list)
    skipped: str = ""

    @property
    def ok(self) -> bool:
        return not self.findings and not self.skipped

    def bad(self, msg: str) -> None:
        self.findings.append(msg)


# -- helpers ------------------------------------------------------------------


async def connect_all(clients: list[Client], batch: int = 25) -> None:
    """Connect in batches. Two hundred simultaneous TCP handshakes into a
    single-threaded asyncio server is a test of the harness, not the relay."""
    for i in range(0, len(clients), batch):
        await asyncio.gather(*(c.connect() for c in clients[i:i + batch]))


async def close_all(clients: list[Client]) -> None:
    await asyncio.gather(*(c.close() for c in clients), return_exceptions=True)


# -- 1. many concurrent agents on hot regions ---------------------------------


async def swarm(agents: int, hot: int, rounds: int, hold_ms: float = 3.0) -> Result:
    r = Result(f"swarm-{agents}")
    relay = RelayProc()
    relay.start()
    room = f"swarm-{agents}"
    clients = [Client(relay.url, room, f"ag{i:04d}") for i in range(agents)]

    lat = Latency("claim")
    counts = Counter()
    stalls: list[str] = []

    try:
        t_connect = time.perf_counter()
        await connect_all(clients)
        connect_s = time.perf_counter() - t_connect
        rss_join = rss_kb(relay.pid)
        cpu0 = cpu_seconds(relay.pid)

        async def worker(idx: int, c: Client) -> None:
            # `n` only advances on a grant or an `abort` -- both end this
            # round, one by finishing it and one by wait-die saying retrying
            # this region is not worth it. `wait` means the opposite: hold
            # your place, the region will be yours. #36 found the harness
            # ignoring that distinction was the whole reason a wait-die fix
            # elsewhere (#35) never showed up here -- a worker that abandons
            # the region on every refusal never gives a `wait` verdict
            # anything to be right about. See tests/test_grant_rate.py for
            # the deterministic version of this finding.
            n = 0
            while n < rounds:
                path = f"src/hot{(idx + n) % hot}.py"
                try:
                    reply, ms = await c.claim(path, intent=f"round {n}")
                except asyncio.TimeoutError:
                    stalls.append(f"{c.agent} got no claim_result for {path}")
                    return
                lat.add(ms)
                if reply.get("granted"):
                    counts["granted"] += 1
                    counts["rounds_done"] += 1
                    if hold_ms:
                        await asyncio.sleep(hold_ms / 1000.0)
                    await c.release(path)
                    n += 1
                else:
                    counts["refused"] += 1
                    counts[f"decision:{reply.get('decision')}"] += 1
                    # Losing is normal on a hot region. Backing off the way a
                    # real client would keeps this from being a pure spin.
                    await asyncio.sleep(0.002)
                    if reply.get("decision") != "wait":
                        counts["rounds_done"] += 1
                        n += 1

        t0 = time.perf_counter()
        try:
            await asyncio.wait_for(
                asyncio.gather(*(worker(i, c) for i, c in enumerate(clients))),
                timeout=180,
            )
            elapsed = time.perf_counter() - t0
        except asyncio.TimeoutError:
            elapsed = time.perf_counter() - t0
            r.bad(f"DEADLOCK/STALL: {agents} agents did not finish {rounds} rounds "
                  f"in 180s (completed {len(lat.samples)} of {agents * rounds})")

        rss_peak = rss_kb(relay.pid)
        cpu_used = cpu_seconds(relay.pid) - cpu0
        ops = len(lat.samples)

        # Everyone has released everything they were granted. Anything the
        # relay still holds is a leak, not a live claim.
        await asyncio.sleep(0.5)
        left = await probe_leases(relay.url, room, "probe-live")
        if left:
            r.bad(f"LEASE LEAK: {len(left)} leases still held after every agent "
                  f"released; e.g. {left[0]}")

        frames = sum(sum(c.kinds.values()) for c in clients)
        dead = [c.agent for c in clients if c.closed_early]
        errs = [e for c in clients for e in c.errors]

        await close_all(clients)
        await asyncio.sleep(1.0)
        after = await probe_leases(relay.url, room, "probe-post")
        if after:
            r.bad(f"LEASE LEAK ON DISCONNECT: {len(after)} leases survived every "
                  f"connection closing; e.g. {after[0]}")

        rss_end = rss_kb(relay.pid)

        if not relay.alive():
            r.bad("relay process died during the swarm")
        if dead:
            r.bad(f"{len(dead)} connections were closed by the relay mid-run: "
                  f"{dead[:5]}")
        for e in errs[:3]:
            r.bad(f"client error: {e}")
        for s in stalls[:3]:
            r.bad(f"STALL: {s}")

        p99 = pct(lat.samples, 0.99)
        if p99 > 20.0:
            r.bad(f"CLAIM LATENCY DEGRADES AT SCALE: p99 {p99:.1f}ms with "
                  f"{agents} agents in one room, against {pct(lat.samples, 0.5):.1f}ms "
                  f"at the median. Every lease change is fanned out to every "
                  f"member and _PublishingRegistry diffs the whole claim table "
                  f"around each call, so one claim costs O(members + claims).")

        # Against rounds_done, not ops (#36). ops is every wire round trip,
        # including a worker holding its place and asking again after
        # `wait` — that inflates the denominator without buying anything,
        # the same way it would inflate a naive requests-per-second count.
        # rounds_done is agents * rounds by construction: every worker's
        # unit of work ends in exactly one grant or one abort, so this is
        # "how much of the work the swarm needed to do actually got done",
        # which single-round contention on a hot region does not bound the
        # way ops does — see tests/test_grant_rate.py.
        rounds_done = counts["rounds_done"]
        grant_rate = counts["granted"] / rounds_done if rounds_done else 0
        if grant_rate < 0.15 and rounds_done > 100:
            r.bad(f"USEFUL WORK COLLAPSES UNDER CONTENTION: only "
                  f"{counts['granted']} of {rounds_done} rounds ({grant_rate:.1%}) "
                  f"ended granted. Not a deadlock — everyone else is told to "
                  f"wait or abort and retries — but {agents} agents on {hot} "
                  f"regions get almost nothing through.")

        if counts["refused"] > 100 and counts["decision:wait"] == 0:
            r.bad(f"WAIT-DIE NEVER SAYS WAIT: {counts['refused']} refusals, all "
                  f"'abort', zero 'wait'. LeaseRegistry.age_of returns "
                  f"clock.now() for an agent holding nothing, so a requester "
                  f"with no live lease is always younger than the holder and "
                  f"always dies. The waiting half of wait-die is unreachable "
                  f"for the common case, and each abort also calls "
                  f"release_all, dropping that agent's unrelated leases.")

        r.metrics = {
            "agents": agents,
            "hot_regions": hot,
            "rounds_each": rounds,
            "connect_s": round(connect_s, 2),
            "ops": ops,
            "rounds_done": rounds_done,
            "elapsed_s": round(elapsed, 2),
            "claims_per_s": round(ops / elapsed, 1) if elapsed else 0,
            "granted": counts["granted"],
            "grant_rate": f"{grant_rate:.1%}",
            "refused": counts["refused"],
            "wait": counts["decision:wait"],
            "abort": counts["decision:abort"],
            "claim_latency": lat.row(),
            "frames_delivered": frames,
            "fanout_per_op": round(frames / ops, 1) if ops else 0,
            "relay_cpu_s": round(cpu_used, 2),
            "relay_cpu_ms_per_op": round(cpu_used * 1000 / ops, 3) if ops else 0,
            "relay_rss_kb": {"after_join": rss_join, "peak": rss_peak,
                             "after_drain": rss_end},
            "relay_rss_kb_per_agent": round((rss_peak - rss_join) / agents, 1),
        }
    finally:
        with contextlib.suppress(Exception):
            await close_all(clients)
        relay.stop()
    return r


# -- 2. many rooms at once ----------------------------------------------------


async def rooms(n_rooms: int, per_room: int, rounds: int) -> Result:
    r = Result(f"rooms-{n_rooms}x{per_room}")
    relay = RelayProc()
    relay.start()
    clients: list[Client] = []
    lat = Latency("claim")
    try:
        for ri in range(n_rooms):
            for ai in range(per_room):
                c = Client(relay.url, f"room{ri:03d}", f"r{ri:03d}-a{ai:02d}")
                # Every room uses the same paths on purpose: isolation is only
                # interesting when the keys collide.
                c.expect_prefix = f"r{ri:03d}-"
                clients.append(c)

        await connect_all(clients)
        rss_join = rss_kb(relay.pid)

        async def worker(c: Client) -> None:
            for n in range(rounds):
                path = f"src/shared{n % 3}.py"
                reply, ms = await c.claim(path)
                lat.add(ms)
                if reply.get("granted"):
                    await asyncio.sleep(0.002)
                    await c.release(path)

        t0 = time.perf_counter()
        await asyncio.wait_for(
            asyncio.gather(*(worker(c) for c in clients)), timeout=180)
        elapsed = time.perf_counter() - t0
        rss_peak = rss_kb(relay.pid)

        leaks = 0
        for ri in range(n_rooms):
            held = await probe_leases(relay.url, f"room{ri:03d}", f"probe{ri}",
                                      settle=0.2)
            leaks += len(held)
        if leaks:
            r.bad(f"LEASE LEAK: {leaks} leases left across {n_rooms} rooms after "
                  f"every agent released")

        violations = [v for c in clients for v in c.isolation_violations]
        if violations:
            r.bad(f"ROOM ISOLATION BROKEN: {len(violations)} frames named an agent "
                  f"from another room; e.g. {violations[0]}")

        await close_all(clients)
        await asyncio.sleep(1.0)
        rss_end = rss_kb(relay.pid)

        # Rooms that no longer have members: does anything about them go away?
        #
        # Two identical phases, because a single number cannot tell a leak from
        # the allocator warming up. A leak keeps costing the same per room in
        # phase two; an arena that has already grown does not.
        async def churn_rooms(tag: str, count: int) -> None:
            for burst in range(count // 50):
                burn = [Client(relay.url, f"churn-{tag}-{burst}-{i}",
                               f"c{tag}{burst}-{i}") for i in range(50)]
                await connect_all(burn)
                await asyncio.gather(*(c.claim(f"src/x{i}.py")
                                       for i, c in enumerate(burn)))
                await asyncio.gather(*(c.event("read", f"src/x{i}.py")
                                       for i, c in enumerate(burn)))
                await close_all(burn)
            await asyncio.sleep(1.0)

        churn_rss0 = rss_kb(relay.pid)
        await churn_rooms("p1", 500)
        churn_rss1 = rss_kb(relay.pid)
        await churn_rooms("p2", 500)
        churn_rss2 = rss_kb(relay.pid)
        phase1, phase2 = churn_rss1 - churn_rss0, churn_rss2 - churn_rss1
        if phase2 > 512 and phase2 > phase1 * 0.5:
            r.bad(f"DEAD ROOMS ARE NEVER FORGOTTEN: 500 rooms whose every "
                  f"member has disconnected cost {phase1} KiB, and the next 500 "
                  f"cost {phase2} KiB — it is not levelling off. Relay._members, "
                  f"._activity and ._last_ts are keyed by room and nothing ever "
                  f"deletes a room, so a long-lived relay grows with the number "
                  f"of repos it has ever seen.")

        shared_name = await _shared_agent_name_across_rooms(relay)
        for f in shared_name["findings"]:
            r.bad(f)

        r.metrics = {
            "rooms": n_rooms,
            "agents_per_room": per_room,
            "shared_agent_name_across_rooms": shared_name["metrics"],
            "total_agents": len(clients),
            "ops": len(lat.samples),
            "elapsed_s": round(elapsed, 2),
            "claims_per_s": round(len(lat.samples) / elapsed, 1) if elapsed else 0,
            "claim_latency": lat.row(),
            "isolation_violations": len(violations),
            "relay_rss_kb": {"after_join": rss_join, "peak": rss_peak,
                             "after_drain": rss_end,
                             "after_500_dead_rooms": churn_rss1,
                             "after_1000_dead_rooms": churn_rss2},
            "dead_room_cost_kb": {"first_500": phase1, "second_500": phase2},
        }
        if not relay.alive():
            r.bad("relay died during the multi-room run")
    finally:
        with contextlib.suppress(Exception):
            await close_all(clients)
        relay.stop()
    return r


async def _shared_agent_name_across_rooms(relay: RelayProc) -> dict:
    """Two rooms, one agent id.

    Not a contrived case. presenced defaults its relay identity to
    "presenced@<hostname>" (cpp/daemon/main.cpp), so two checkouts on one
    laptop are two daemons, two rooms and one name. Both of the relay's
    release paths — the wait-die abort in Relay._on_claim and the disconnect
    sweep in Relay.leave — call LeaseRegistry.release_all(agent), which is
    documented as dropping "every lease an agent holds, in every room".
    """
    out: dict = {"findings": [], "metrics": {}}
    name = "presenced@laptop"
    a = Client(relay.url, "repo-a", name)
    b = Client(relay.url, "repo-b", name)
    rival = Client(relay.url, "repo-b", "rival-agent")
    try:
        await a.connect()
        await rival.connect()
        # rival takes repo-b/src/x.py first, and holds it, so it is older.
        await rival.claim("src/x.py", intent="older holder")
        await a.claim("src/only-in-repo-a.py", intent="the innocent lease")
        await asyncio.sleep(0.3)

        held = await probe_leases(relay.url, "repo-a", "probe-a1", settle=0.3)
        out["metrics"]["repo_a_leases_before"] = len(held)

        await b.connect()
        reply, _ = await b.claim("src/x.py", intent="loser")
        out["metrics"]["decision_in_repo_b"] = reply.get("decision")
        await asyncio.sleep(0.5)

        after = await probe_leases(relay.url, "repo-a", "probe-a2", settle=0.3)
        out["metrics"]["repo_a_leases_after_abort_in_repo_b"] = len(after)
        if held and not after:
            out["findings"].append(
                "CROSS-ROOM LEASE LOSS ON WAIT-DIE ABORT: an agent id that "
                "exists in two rooms lost its repo-a lease because a claim it "
                "made in repo-b was refused. Relay._on_claim answers an abort "
                "with registry.release_all(agent), and release_all is not "
                "room-scoped. presenced names itself presenced@<hostname> by "
                "default, so two checkouts on one machine hit this.")

        # And again for the disconnect path.
        await a.claim("src/only-in-repo-a.py", intent="the innocent lease")
        await asyncio.sleep(0.3)
        before_close = await probe_leases(relay.url, "repo-a", "probe-a3", settle=0.3)
        await b.close()
        await asyncio.sleep(0.5)
        after_close = await probe_leases(relay.url, "repo-a", "probe-a4", settle=0.3)
        out["metrics"]["repo_a_leases_after_repo_b_disconnect"] = len(after_close)
        if before_close and not after_close:
            out["findings"].append(
                "CROSS-ROOM LEASE LOSS ON DISCONNECT: closing the repo-b "
                "connection released the same agent id's repo-a leases. "
                "Relay.leave calls release_all(agent), which sweeps every "
                "room.")
    finally:
        for c in (a, b, rival):
            with contextlib.suppress(Exception):
                await c.close()
    return out


# -- 3. relay restart mid-session ---------------------------------------------


async def relay_restart(daemons: int) -> Result:
    r = Result(f"relay-restart-{daemons}")
    tmp = Path(tempfile.mkdtemp(prefix="ap-load-restart-"))
    relay = RelayProc()
    relay.start()
    room = "restart-room"
    procs = [DaemonProc(tmp, f"presenced-{i:02d}", room, relay.url)
             for i in range(daemons)]
    obs: Client | None = None
    try:
        for p in procs:
            p.start()

        async def observe(seconds: float, tag: str) -> tuple[set[str], set[str]]:
            """Which daemons the relay is fanning out for, and which paths
            reached it. Distinct paths per round so the coalescer, which
            suppresses a repeat of agent|verb|path inside a second, cannot be
            mistaken for a lost event."""
            c = Client(relay.url, room, f"observer-{tag}")
            c.keep_fanout = True
            await c.connect()
            await asyncio.sleep(0.3)
            end = time.time() + seconds
            n = 0
            while time.time() < end:
                for p in procs:
                    p.send_lines([event_line(f"sess-{p.name}", "read",
                                             f"src/{tag}/{p.name}-{n}.py")])
                n += 1
                await asyncio.sleep(0.25)
            await asyncio.sleep(1.5)
            agents_seen: set[str] = set()
            paths_seen: set[str] = set()
            for f in c.fanout:
                if f.get("type") == "presence":
                    agents_seen.add(f.get("agent", ""))
                    paths_seen.add((f.get("region") or {}).get("path", ""))
            await c.close()
            return agents_seen, paths_seen

        before, _ = await observe(4.0, "before")
        missing = {p.name for p in procs} - before
        if missing:
            r.bad(f"{len(missing)} daemons never reached the relay before the "
                  f"restart: {sorted(missing)[:5]}")

        # A lease held across the restart. The relay is stateless by design,
        # so what matters is whether the daemons agree with it afterwards.
        holder = Client(relay.url, room, "lease-holder")
        await holder.connect()
        got, _ = await holder.claim("src/contested.py", intent="held across restart")
        await asyncio.sleep(1.5)
        blocked_before = _hook_says_blocked(procs[0], "src/contested.py")

        t_kill = time.perf_counter()
        relay.sigkill()
        await holder.close()

        # Events fired while there is nothing to send them to. Outbound is
        # supposed to hold these and drain on reconnect.
        outage_paths = [f"src/outage/{i}.py" for i in range(6)]
        for i, path in enumerate(outage_paths):
            for p in procs:
                p.send_lines([event_line(f"sess-{p.name}", "edit", path)])
            await asyncio.sleep(0.25)

        crashed = [p.name for p in procs if not p.alive()]
        if crashed:
            r.bad(f"DAEMON CRASH: {len(crashed)} presenced died while the relay "
                  f"was down: {crashed}")

        relay.start()

        # Connected before the daemons get back, so anything Outbound held
        # during the outage is observable when it drains.
        drain_obs = Client(relay.url, room, "observer-drain")
        drain_obs.keep_fanout = True
        await drain_obs.connect()

        # Backoff is 250ms doubling to 30s, and the outage above is short, so
        # this should be quick. Give it room anyway.
        after, _ = await observe(20.0, "after")
        reconnect_s = time.perf_counter() - t_kill
        gone = {p.name for p in procs if p.alive()} - after
        if gone:
            r.bad(f"NO RECONNECT: {len(gone)} daemons never came back after the "
                  f"relay restart: {sorted(gone)[:5]}")

        drained_paths = {(f.get("region") or {}).get("path", "")
                         for f in drain_obs.fanout if f.get("type") == "presence"}
        drained = len(drained_paths & set(outage_paths))
        await drain_obs.close()
        if drained == 0:
            r.bad(f"BUFFERED EVENTS LOST: none of the {len(outage_paths)} paths "
                  f"each daemon emitted while the relay was down were replayed "
                  f"after the reconnect")

        # The relay came back with an empty lease table. Does the daemon know?
        blocked_after = _hook_says_blocked(procs[0], "src/contested.py")
        if blocked_before and blocked_after:
            r.bad("STALE LEASE SURVIVES RELAY RESTART: the relay lost the lease "
                  "table on restart and sends no snapshot to an empty room, so "
                  "presenced still blocks edits to src/contested.py for a lease "
                  "nothing holds. Clears only when the daemon's own copy ages "
                  "out (up to 90s).")

        still_alive = sum(1 for p in procs if p.alive())
        if still_alive != daemons:
            r.bad(f"only {still_alive}/{daemons} daemons survived the restart")

        r.metrics = {
            "daemons": daemons,
            "seen_before_restart": len(before & {p.name for p in procs}),
            "seen_after_restart": len(after & {p.name for p in procs}),
            "reconnect_window_s": round(reconnect_s, 2),
            "outage_paths_per_daemon": len(outage_paths),
            "outage_paths_replayed_after_reconnect": drained,
            "daemons_alive_at_end": still_alive,
            "hook_blocked_before_restart": blocked_before,
            "hook_blocked_after_restart": blocked_after,
        }
    finally:
        with contextlib.suppress(Exception):
            if obs is not None:
                await obs.close()
        for p in procs:
            p.stop()
        relay.stop()
    return r


def hook_payload(path: str, session: str) -> str:
    """A PreToolUse payload in the shape hook.cpp can actually read.

    Compact, like event_line and for the same reason: ap::field looks for the
    literal `"file_path":"`, so `"file_path": "x"` — valid JSON, and what
    json.dumps writes by default — extracts an empty path and the hook asks
    the daemon about nothing.
    """
    return json.dumps({
        "hook_event_name": "PreToolUse", "tool_name": "Edit",
        "tool_input": {"file_path": path}, "file_path": path,
        "session_id": session,
    }, separators=(",", ":"))


def _hook_says_blocked(p: DaemonProc, path: str) -> bool:
    """Ask the daemon the same question a PreToolUse hook would."""
    payload = hook_payload(path, "probe-session")
    env = dict(os.environ, AGENT_PRESENCE_SOCK=str(p.sock))
    try:
        out = subprocess.run([str(AP_HOOK)], input=payload, capture_output=True,
                             text=True, timeout=10, env=env)
    except Exception:
        return False
    return "permissionDecision" in out.stdout


# -- 4. daemon killed under load ----------------------------------------------


async def daemon_kill(threads: int, iters: int) -> Result:
    r = Result("daemon-kill-under-load")
    tmp = Path(tempfile.mkdtemp(prefix="ap-load-kill-"))
    relay = RelayProc()
    relay.start()
    d = DaemonProc(tmp, "victim", "kill-room", relay.url)
    d.start()

    try:
        # A lease in the daemon's cache so the hooks it answers are doing real
        # work, not short-circuiting on an empty table.
        # Every path hookbench cycles through, so an unanswered call means
        # protection was actually lost rather than the path simply being free.
        c = Client(relay.url, "kill-room", "lease-holder")
        await c.connect()
        for i in range(8):
            await c.claim(f"/repo/src/hot{i}.py", intent="held")
        await asyncio.sleep(1.5)

        # What the answer rate looks like with the daemon healthy, so the rate
        # across the kill has something to be compared against.
        alive = json.loads(subprocess.run(
            [str(HOOKBENCH), str(d.sock), "600", "1", "0"],
            capture_output=True, text=True, timeout=120,
        ).stdout.strip().splitlines()[-1])

        # Enough iterations to still be running a second from now, whatever the
        # answers cost. The measurement is of hooks caught mid-flight by the
        # kill, so a bench that has already finished measures nothing — and it
        # finishes sooner every time the daemon gets faster.
        bench = subprocess.Popen(
            [str(HOOKBENCH), str(d.sock), str(max(iters, 8000)), str(threads), "200"],
            stdout=subprocess.PIPE, text=True,
        )
        await asyncio.sleep(1.0)
        if bench.poll() is not None:
            r.bad("hookbench exited before the daemon was killed; iters too low")

        t_kill = time.perf_counter()
        d.sigkill()
        kill_at = t_kill

        # The binary itself, not the library, while the daemon is dead. Exit
        # code is the whole promise: a hook that fails fails the tool call.
        exits, walls = [], []
        for i in range(20):
            payload = hook_payload(f"/repo/src/hot{i}.py", "post-kill")
            t0 = time.perf_counter()
            p = subprocess.run(
                [str(AP_HOOK)], input=payload, capture_output=True, text=True,
                timeout=30, env=dict(os.environ, AGENT_PRESENCE_SOCK=str(d.sock)),
            )
            walls.append((time.perf_counter() - t0) * 1000)
            exits.append(p.returncode)

        out, _ = bench.communicate(timeout=180)
        stats = json.loads(out.strip().splitlines()[-1])

        bad_exits = [e for e in exits if e != 0]
        if bad_exits:
            r.bad(f"HOOK NONZERO EXIT after the daemon was killed: {bad_exits}")
        # The hook's own socket budget is 2ms; process spawn is the rest.
        if stats["p99_ms"] > 5.0:
            r.bad(f"HOOK p99 {stats['p99_ms']}ms exceeds the 5ms budget with the "
                  f"daemon being killed under it")
        if stats["max_ms"] > 25.0:
            r.bad(f"HOOK max {stats['max_ms']}ms: something blocked the agent "
                  f"while the daemon died")

        if stats["over_5ms"] > stats["n"] * 0.01:
            r.bad(f"{stats['over_5ms']} of {stats['n']} hook calls took more "
                  f"than 5ms while the daemon was being killed")

        r.metrics = {
            "hook_calls": stats["n"],
            "concurrent_hook_threads": threads,
            "single_threaded_daemon_alive": {
                k: alive[k] for k in ("p50_ms", "p99_ms", "max_ms", "over_5ms",
                                      "answered", "empty")},
            "latency_across_the_kill": {k: stats[k] for k in
                                        ("p50_ms", "p95_ms", "p99_ms", "max_ms",
                                         "over_5ms")},
            "answered": stats["answered"],
            "allowed_no_answer": stats["empty"],
            "post_kill_binary_exit_codes": sorted(set(exits)),
            "post_kill_binary_wall_ms_max": round(max(walls), 2),
            "relay_alive": relay.alive(),
        }
        if not relay.alive():
            r.bad("relay died when the daemon was SIGKILLed")
        await c.close()
    finally:
        d.stop()
        relay.stop()
    return r


# -- 5. flood -----------------------------------------------------------------


def _flood_worker(sock_path: str, agent: str, paths: list[str], out: list) -> None:
    sent = failed = 0
    why: Counter[str] = Counter()
    for path in paths:
        try:
            s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            s.settimeout(2.0)
            s.connect(sock_path)
            s.sendall((event_line(agent, "search", path) + "\n").encode())
            s.close()
            sent += 1
        except OSError as exc:
            failed += 1
            why[getattr(exc, "strerror", None) or type(exc).__name__] += 1
    out.append((sent, failed, why))


async def flood(events: int, threads: int) -> Result:
    import threading

    r = Result("flood")
    tmp = Path(tempfile.mkdtemp(prefix="ap-load-flood-"))
    relay = RelayProc()
    relay.start()
    d = DaemonProc(tmp, "flooder", "flood-room", relay.url)
    d.start()
    obs = Client(relay.url, "flood-room", "observer")
    obs.keep_fanout = True
    try:
        await obs.connect()
        await asyncio.sleep(1.0)

        rss0 = rss_kb(d.pid)
        cpu0 = cpu_seconds(d.pid)
        inodes: set[int] = set()
        stop = threading.Event()

        def watch_snapshot() -> None:
            while not stop.is_set():
                try:
                    inodes.add(os.stat(d.snapshot).st_ino)
                except OSError:
                    pass
                time.sleep(0.001)

        watcher = threading.Thread(target=watch_snapshot, daemon=True)
        watcher.start()

        per = events // threads
        results: list = []
        pool = [threading.Thread(
            target=_flood_worker,
            args=(str(d.sock), "grep-agent",
                  [f"src/tree/{t}/{i}.py" for i in range(per)], results))
            for t in range(threads)]

        t0 = time.perf_counter()
        for p in pool:
            p.start()
        for p in pool:
            p.join()
        send_s = time.perf_counter() - t0

        await asyncio.sleep(3.0)
        stop.set()
        watcher.join(timeout=2)

        rss1 = rss_kb(d.pid)
        cpu1 = cpu_seconds(d.pid)
        sent = sum(s for s, _, _ in results)
        failed = sum(f for _, f, _ in results)
        why: Counter[str] = Counter()
        for _, _, w in results:
            why.update(w)

        arrived = sum(1 for f in obs.fanout if f.get("type") == "presence")

        # The coalescer's cap is 200 admitted per 1000ms window. Anything much
        # over that per second of flood means the cap is not holding.
        cap_budget = 200 * (send_s + 4.0)
        if arrived > cap_budget * 1.25:
            r.bad(f"COALESCER CAP NOT HOLDING: {arrived} events reached the relay "
                  f"in ~{send_s + 4:.1f}s; the 200/window cap allows about "
                  f"{cap_budget:.0f}")
        if not d.alive():
            r.bad("DAEMON DIED under the flood")
        if not relay.alive():
            r.bad("RELAY DIED under the flood")
        if rss1 - rss0 > 51200:
            r.bad(f"DAEMON MEMORY GROWTH: RSS went {rss0} -> {rss1} KiB "
                  f"(+{rss1 - rss0}) over {sent} events and did not come back")
        if failed:
            r.bad(f"DAEMON REFUSED CONNECTIONS: {failed} of {sent + failed} event "
                  f"connections could not be served during the flood "
                  f"({dict(why)}). The listen backlog is 64 and the loop serves "
                  f"one connection at a time. What is lost here is events, and "
                  f"an event lost costs an animation frame — decisions moved to "
                  f"their own socket and their own threads and are not in this "
                  f"queue. Worth watching all the same: this is the loop "
                  f"falling behind.")

        window = send_s + 4.0
        writes = len(inodes)
        rate = writes / window
        if rate > 5:
            r.bad(f"SNAPSHOT WRITE AMPLIFICATION: at least {writes} distinct "
                  f"snapshot files in {window:.1f}s ({rate:.0f}/s, and a 1ms "
                  f"sampler can only undercount). The documented tick is 1/s. "
                  f"daemon/main.cpp writes whenever `dirty`, and a flood of "
                  f"paths the daemon has not seen before sets dirty on every "
                  f"single event, so the file is rewritten and renamed on every "
                  f"loop iteration for as long as the flood lasts.")

        # One connection carrying a big batch, which is what a hook writing
        # more than it can flush in its 5ms slice looks like. The daemon's
        # presence table records the last line it got to, so the index in the
        # snapshot says how far it read before the budget ran out.
        batch_n = 5000
        batch = [event_line("batch-agent", "read", f"src/batch/{i:05d}.py")
                 for i in range(batch_n)]
        obs.fanout.clear()
        d.send_lines(batch)
        await asyncio.sleep(3.0)
        batch_seen = sum(1 for f in obs.fanout if f.get("type") == "presence")
        last = d.snapshot_paths().get("batch-agent", "")
        try:
            batch_read = int(last.split("/")[-1].split(".")[0]) + 1
        except ValueError:
            batch_read = 0
        if batch_read < batch_n:
            r.bad(f"ONE CONNECTION IS TRUNCATED AT THE BUDGET: of {batch_n} "
                  f"lines written on a single socket the daemon read {batch_read} "
                  f"and closed. SocketServer::drain_conn gets 5ms and drops "
                  f"whatever is left, silently. Fine for one line per hook; a "
                  f"client that batches loses the tail with no error anywhere.")

        r.metrics = {
            "events_offered": sent + failed,
            "events_accepted_by_socket": sent,
            "connections_refused": failed,
            "refusal_reasons": dict(why),
            "send_s": round(send_s, 2),
            "offered_per_s": round((sent + failed) / send_s, 0) if send_s else 0,
            "events_reaching_relay": arrived,
            "coalescer_suppression": (
                f"{100 * (1 - arrived / sent):.1f}%" if sent else "n/a"),
            "daemon_rss_kb": {"before": rss0, "after": rss1},
            "daemon_cpu_s": round(cpu1 - cpu0, 2),
            "snapshot_writes_min": writes,
            "snapshot_writes_per_s_min": round(rate, 1),
            "single_conn_batch_offered": batch_n,
            "single_conn_batch_lines_read": batch_read,
            "single_conn_batch_reaching_relay": batch_seen,
            "daemon_alive": d.alive(),
        }
    finally:
        with contextlib.suppress(Exception):
            await obs.close()
        d.stop()
        relay.stop()
    return r


# -- 6. slow subscriber -------------------------------------------------------


def _ws_frame(payload: bytes) -> bytes:
    """A masked client text frame. Hand-rolled because the point is a peer
    that completes the handshake and then never reads a byte, and every
    websocket library reads in the background."""
    mask = os.urandom(4)
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    n = len(payload)
    if n < 126:
        head = struct.pack("!BB", 0x81, 0x80 | n)
    elif n < (1 << 16):
        head = struct.pack("!BBH", 0x81, 0x80 | 126, n)
    else:
        head = struct.pack("!BBQ", 0x81, 0x80 | 127, n)
    return head + mask + masked


class DeafSubscriber:
    """Handshakes, joins, then never reads again.

    Raw socket, not `websockets`, on purpose (see `_ws_frame`) — which means
    it's this class's own job to speak TLS when the run is over `wss://`
    (`AP_LOAD_TLS=1`, see `_lib.TLS_ENABLED`), the same cert every other
    client in the run trusts.
    """

    def __init__(self, url_host: str, port: int, room: str, agent: str) -> None:
        raw = socket.create_connection((url_host, port), 10)
        raw.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 2048)
        self.s = (dev_client_ssl_context().wrap_socket(raw, server_hostname=url_host)
                  if TLS_ENABLED else raw)
        key = base64.b64encode(os.urandom(16)).decode()
        req = (f"GET / HTTP/1.1\r\nHost: {url_host}:{port}\r\nUpgrade: websocket\r\n"
               f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
               f"Sec-WebSocket-Version: 13\r\n\r\n")
        self.s.sendall(req.encode())
        buf = b""
        self.s.settimeout(10)
        while b"\r\n\r\n" not in buf:
            chunk = self.s.recv(4096)
            if not chunk:
                raise RuntimeError("relay refused the raw upgrade")
            buf += chunk
        self.s.sendall(_ws_frame(json.dumps(
            {"type": "join", "room": room, "agent": agent,
             "human": "deaf"}).encode()))
        # From here on nothing is ever read. The kernel buffer fills, then the
        # relay's own write buffer, then whatever the relay does about it.

    def close(self) -> None:
        with contextlib.suppress(Exception):
            self.s.close()


async def slow_subscriber(busy_agents: int, seconds: float) -> Result:
    r = Result("slow-subscriber")
    relay = RelayProc()
    relay.start()
    room = "slow-room"
    deaf = None
    clients = [Client(relay.url, room, f"busy{i:03d}") for i in range(busy_agents)]
    try:
        await connect_all(clients)
        lat_clean = Latency("before")

        async def churn(c: Client, idx: int, lat: Latency, stop_at: float) -> int:
            n = 0
            while time.perf_counter() < stop_at:
                path = f"src/f{(idx + n) % 40}.py"
                reply, ms = await c.claim(path, timeout=60)
                lat.add(ms)
                if reply.get("granted"):
                    await c.release(path)
                n += 1
            return n

        # Baseline with everyone healthy.
        stop_at = time.perf_counter() + seconds
        base_ops = sum(await asyncio.gather(
            *(churn(c, i, lat_clean, stop_at) for i, c in enumerate(clients))))
        rss_base = rss_kb(relay.pid)

        deaf = DeafSubscriber("127.0.0.1", relay.port, room, "deaf-agent")
        await asyncio.sleep(0.5)

        lat_deaf = Latency("with-deaf")
        rss_track = [rss_kb(relay.pid)]
        stop_at = time.perf_counter() + seconds

        async def sample_rss() -> None:
            while time.perf_counter() < stop_at:
                rss_track.append(rss_kb(relay.pid))
                await asyncio.sleep(0.25)

        sampler = asyncio.create_task(sample_rss())
        try:
            deaf_ops = sum(await asyncio.wait_for(asyncio.gather(
                *(churn(c, i, lat_deaf, stop_at)
                  for i, c in enumerate(clients))), timeout=seconds + 60))
        except asyncio.TimeoutError:
            deaf_ops = 0
            r.bad("INGEST STALLED: a subscriber that never reads stopped the "
                  "other agents from making progress")
        sampler.cancel()
        with contextlib.suppress(BaseException):
            await sampler

        rss_peak = max(rss_track)
        growth = rss_peak - rss_base
        # Split the window in half. A one-off allocation shows up in the first
        # half and stops; a leak keeps costing the same in the second.
        mid = len(rss_track) // 2
        first_half = rss_track[mid] - rss_track[0] if mid else 0
        second_half = rss_track[-1] - rss_track[mid] if mid else 0
        rate = growth / seconds if seconds else 0

        if not relay.alive():
            r.bad("RELAY DIED with one non-reading subscriber attached")
        if base_ops and deaf_ops < base_ops * 0.5:
            r.bad(f"INGEST DEGRADED: throughput fell from {base_ops} to "
                  f"{deaf_ops} ops in the same window with one deaf subscriber")
        if growth > 20480:
            r.bad(f"UNBOUNDED RELAY MEMORY ON A SLOW SUBSCRIBER: RSS grew "
                  f"{growth} KiB in {seconds}s ({rate:.0f} KiB/s), "
                  f"{first_half} KiB in the first half and {second_half} KiB in "
                  f"the second — it is a rate, not a one-off. "
                  f"serve.WsConn.send fires a task per outbound frame and parks "
                  f"it in the module-level _INFLIGHT set; a peer that never "
                  f"reads never lets those tasks finish, so the set and the "
                  f"payloads they pin grow without limit. Nothing sheds the "
                  f"connection and nothing bounds the queue.")

        deaf.close()
        await asyncio.sleep(2.0)
        rss_after = rss_kb(relay.pid)

        r.metrics = {
            "busy_agents": busy_agents,
            "window_s": seconds,
            "ops_healthy": base_ops,
            "ops_with_deaf_subscriber": deaf_ops,
            "throughput_ratio": round(deaf_ops / base_ops, 2) if base_ops else 0,
            "claim_latency_healthy": lat_clean.row(),
            "claim_latency_with_deaf": lat_deaf.row(),
            "relay_rss_kb": {"baseline": rss_base, "peak_with_deaf": rss_peak,
                             "after_deaf_left": rss_after},
            "relay_rss_growth_kb": growth,
            "relay_rss_growth_kb_per_s": round(rate, 0),
            "relay_rss_growth_first_half_kb": first_half,
            "relay_rss_growth_second_half_kb": second_half,
            "relay_alive": relay.alive(),
        }
    finally:
        if deaf is not None:
            deaf.close()
        with contextlib.suppress(Exception):
            await close_all(clients)
        relay.stop()
    return r


# -- 7. hook latency under load ----------------------------------------------


async def hook_latency(busy_agents: int, leases_each: int, hook_threads: int,
                       iters: int, storm_lanes: int = 6) -> Result:
    r = Result("hook-latency-under-load")
    tmp = Path(tempfile.mkdtemp(prefix="ap-load-hook-"))
    relay = RelayProc()
    relay.start()
    room = "hook-room"
    d = DaemonProc(tmp, "busy-daemon", room, relay.url)
    d.start()
    clients = [Client(relay.url, room, f"hold{i:03d}") for i in range(busy_agents)]

    def bench(threads: int, n: int, pace_us: int = 0) -> dict:
        out = subprocess.run(
            [str(HOOKBENCH), str(d.sock), str(n), str(threads), str(pace_us)],
            capture_output=True, text=True, timeout=300)
        return json.loads(out.stdout.strip().splitlines()[-1])

    try:
        await asyncio.sleep(1.5)
        idle = bench(1, iters)

        await connect_all(clients)
        # Fill the daemon's lease cache the only way it can be filled: real
        # claims, fanned out over the wire.
        for i, c in enumerate(clients):
            for k in range(leases_each):
                await c.claim(f"src/pkg{i}/mod{k}.py", intent="held")
        # The eight paths hookbench cycles through, held by someone else, so
        # an unanswered call means protection was lost and not that the path
        # was simply free.
        for k in range(8):
            await clients[0].claim(f"/repo/src/hot{k}.py", intent="held")
        await asyncio.sleep(3.0)
        total_leases = busy_agents * leases_each + 8

        loaded_quiet = bench(1, iters)

        # Now with the relay churning as well: heartbeats and releases keep the
        # daemon parsing lease frames while it is answering hooks.
        stop = time.perf_counter() + 60.0

        async def churn(lane: int) -> None:
            n = lane
            while time.perf_counter() < stop:
                c = clients[n % len(clients)]
                try:
                    await c.heartbeat(f"src/pkg{n % len(clients)}/mod0.py")
                    await c.fire_and_forget_event(
                        "read", f"src/pkg{n % len(clients)}/mod1.py")
                except Exception:
                    return
                n += 1
                await asyncio.sleep(0.001)

        churn_tasks = [asyncio.create_task(churn(i)) for i in range(8)]
        loaded_busy = await asyncio.get_running_loop().run_in_executor(
            None, lambda: bench(hook_threads, max(400, iters // hook_threads)))

        # The case the daemon's design is most exposed to: PreToolUse decisions
        # and a burst of one-way events arriving on the same unix socket, which
        # one single-threaded accept loop has to serve one connection at a time.
        import threading
        storm_stop = threading.Event()

        def storm(lane: int) -> None:
            i = 0
            while not storm_stop.is_set():
                try:
                    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                    s.settimeout(2.0)
                    s.connect(str(d.sock))
                    s.sendall((event_line(f"storm{lane}", "search",
                                          f"src/storm/{lane}/{i}.py") + "\n").encode())
                    s.close()
                except OSError:
                    pass
                i += 1

        storm_pool = [threading.Thread(target=storm, args=(i,), daemon=True)
                      for i in range(storm_lanes)]
        for t in storm_pool:
            t.start()
        try:
            under_storm = await asyncio.get_running_loop().run_in_executor(
                None, lambda: bench(hook_threads, max(400, iters // hook_threads)))
        finally:
            storm_stop.set()
            for t in storm_pool:
                t.join(timeout=5)

        for t in churn_tasks:
            t.cancel()
        await asyncio.gather(*churn_tasks, return_exceptions=True)

        budget = 5.0
        for label, s in (("idle", idle), ("big lease cache", loaded_quiet),
                         ("under full load", loaded_busy),
                         ("hook storm on the same socket", under_storm)):
            if s["p99_ms"] > budget:
                r.bad(f"HOOK p99 BUDGET BLOWN ({label}): p99 {s['p99_ms']}ms > "
                      f"{budget}ms, max {s['max_ms']}ms")

        # Degradation that stays inside budget is still the headline number.
        worst = max(loaded_busy["p99_ms"], under_storm["p99_ms"])
        if idle["p99_ms"] > 0 and worst / idle["p99_ms"] > 5:
            r.bad(f"HOOK p99 DEGRADES {worst / idle['p99_ms']:.1f}x under load "
                  f"({idle['p99_ms']}ms idle -> {worst}ms loaded)")

        # An empty answer is the hook allowing an edit. Under load that is a
        # protection failure, not a latency one.
        for label, s in (("big lease cache", loaded_quiet),
                         ("under full load", loaded_busy),
                         ("hook storm on the same socket", under_storm)):
            share = s["empty"] / s["n"] if s["n"] else 0
            if share > 0.01:
                r.bad(f"PROTECTION LOST UNDER LOAD ({label}): {s['empty']} of "
                      f"{s['n']} hook calls ({share:.0%}) got no answer from the "
                      f"daemon inside the 2ms socket budget and therefore "
                      f"allowed the edit. The hook exits 0 either way, so this "
                      f"is silent.")

        r.metrics = {
            "leases_in_daemon_cache": total_leases,
            "idle_empty_cache": idle,
            "with_big_lease_cache": loaded_quiet,
            "under_relay_churn": loaded_busy,
            "under_hook_storm_same_socket": under_storm,
            "hook_threads": hook_threads,
            "event_storm_lanes": storm_lanes,
            "daemon_alive": d.alive(),
        }
        if not d.alive():
            r.bad("daemon died under hook load")
    finally:
        with contextlib.suppress(Exception):
            await close_all(clients)
        d.stop()
        relay.stop()
    return r


# -- 8. lease expiry under churn ---------------------------------------------


def _region_key(region: dict | None) -> str:
    """How relay_client.cpp keys the cache: path + '|' + symbol, where a null
    symbol is the empty string."""
    region = region or {}
    return f"{region.get('path', '')}|{region.get('symbol') or ''}"


def _replay_lease_stream(frames: list[dict]) -> list[dict]:
    """Run the fan-out through the daemon's cache rules and report every point
    where it ends up empty for a region the relay still considers held.

    Mirrors RelayClient::on_text: `held` upserts by region key, and
    `released`/`expired` erase that key only when the frame names the agent the
    cache has holding it. An erasure that would have taken somebody else's lease
    with it is what gets reported — with the match in place there should be
    none, and one showing up means the two implementations have drifted.
    """
    cache: dict[str, str] = {}
    bad: list[dict] = []
    for f in frames:
        if f.get("type") == "leases":
            cache = {_region_key(e.get("region")): e.get("agent", "")
                     for e in f.get("leases") or []}
            continue
        if f.get("type") != "lease":
            continue
        key = _region_key(f.get("region"))
        state = f.get("state")
        if state == "held":
            cache[key] = f.get("agent", "")
        elif state in ("released", "expired"):
            holder = cache.get(key)
            if holder is not None and holder != f.get("agent"):
                bad.append({"region": key, "would_have_erased": holder,
                            "by_frame_for": f.get("agent"), "state": state,
                            "kept": True})
                continue
            cache.pop(key, None)
    return bad


async def lease_takeover() -> Result:
    """One region, one handover, one daemon watching.

    The smallest case that shows what the churn scenario finds in bulk: A
    holds a region, A's lease expires, B claims it and is granted, and then a
    third agent asks the daemon whether it may edit that region.
    """
    r = Result("lease-takeover")
    tmp = Path(tempfile.mkdtemp(prefix="ap-load-takeover-"))
    ttl = 2.0
    relay = RelayProc(lease_ttl_s=ttl)
    relay.start()
    room = "takeover-room"
    d = DaemonProc(tmp, "watcher-daemon", room, relay.url)
    d.start()
    watch = Client(relay.url, room, "wire-watcher")
    watch.keep_fanout = True
    a = Client(relay.url, room, "agent-A")
    b = Client(relay.url, room, "agent-B")
    try:
        await watch.connect()
        await a.connect()
        await b.connect()
        await asyncio.sleep(1.0)

        await a.claim("src/handover.py", intent="A is working here")
        await asyncio.sleep(1.0)
        blocked_for_a = _hook_says_blocked(d, "src/handover.py")

        # Let A's lease die on its own, the way an agent that crashed would.
        await asyncio.sleep(ttl + 1.0)

        granted, _ = await b.claim("src/handover.py", intent="B is working here")
        await asyncio.sleep(1.5)
        blocked_for_b = _hook_says_blocked(d, "src/handover.py")

        order = [f"{f.get('state')}:{f.get('agent')}" for f in watch.fanout
                 if f.get("type") == "lease"]
        replay = _replay_lease_stream(watch.fanout)

        if not granted.get("granted"):
            r.bad("harness assumption broken: B was not granted the region "
                  "after A's lease expired")
        elif blocked_for_a and not blocked_for_b:
            r.bad("LEASE HANDOVER LEAVES THE REGION UNPROTECTED: the relay says "
                  "agent-B holds src/handover.py, and presenced lets a third "
                  "agent edit it. The relay publishes `held` for the new holder "
                  "before `expired` for the old one "
                  f"(order: {order}), both frames name the same region, and "
                  "RelayClient::on_text erases on the region key without "
                  "checking which agent the frame is about — so the expiry "
                  "frame deletes the lease that was just granted. Every "
                  "takeover after an expiry lands here, and it stays wrong "
                  "until the new holder's next heartbeat.")

        r.metrics = {
            "lease_ttl_s": ttl,
            "b_granted_by_relay": bool(granted.get("granted")),
            "daemon_blocked_while_A_held": blocked_for_a,
            "daemon_blocked_while_B_holds": blocked_for_b,
            "lease_frame_order": order,
            "replay_handovers_survived": replay,
        }
    finally:
        for c in (watch, a, b):
            with contextlib.suppress(Exception):
                await c.close()
        d.stop()
        relay.stop()
    return r


async def lease_churn(agents: int, ttl_s: float, seconds: float) -> Result:
    r = Result("lease-expiry-churn")
    relay = RelayProc(lease_ttl_s=ttl_s)
    relay.start()
    room = "churn-room"
    clients = [Client(relay.url, room, f"ch{i:03d}") for i in range(agents)]
    watcher = Client(relay.url, room, "lease-watcher")
    watcher.keep_fanout = True
    try:
        await watcher.connect()
        await connect_all(clients)

        grants: list[dict] = []
        over_ttl = 0
        stop_at = time.perf_counter() + seconds

        async def worker(idx: int, c: Client) -> None:
            nonlocal over_ttl
            n = 0
            while time.perf_counter() < stop_at:
                path = f"src/churn{(idx + n) % 8}.py"
                reply, _ = await c.claim(path, timeout=60)
                if reply.get("granted"):
                    grants.append({"agent": c.agent, "path": path,
                                   "t": time.time(),
                                   "expires_in_ms": reply.get("expires_in_ms")})
                    if reply.get("expires_in_ms", 0) > ttl_s * 1000 + 50:
                        over_ttl += 1
                    # Abandoned on purpose. Nobody releases; expiry is the only
                    # thing that can free these.
                n += 1
                await asyncio.sleep(0.01)

        await asyncio.wait_for(
            asyncio.gather(*(worker(i, c) for i, c in enumerate(clients))),
            timeout=seconds + 120)

        # Nobody has released anything. Wait out the TTL with the room quiet.
        await asyncio.sleep(ttl_s * 2)
        quiet = await probe_leases(relay.url, room, "probe-quiet", settle=0.5)
        if quiet:
            r.bad(f"LEASES OUTLIVED THEIR TTL: {len(quiet)} still held "
                  f"{ttl_s * 2:.0f}s after the last claim, TTL is {ttl_s}s; "
                  f"e.g. {quiet[0]}")

        # Expiry is lazy and only diffed when something touches the registry.
        # A quiet room therefore never hears that a lease expired.
        states = Counter(f.get("state") for f in watcher.fanout
                         if f.get("type") == "lease")
        expired_frames = states["expired"]
        released_frames = states["released"]
        held_frames = states["held"]
        if held_frames and expired_frames == 0:
            r.bad(f"NO EXPIRY EVER BROADCAST: the watcher saw {held_frames} "
                  f"lease-held frames, {released_frames} 'released' and zero "
                  f"'expired'. Expiry is lazy and only diffed when something "
                  f"else touches the registry, so when the room goes quiet — "
                  f"which is exactly when the holder has crashed — every daemon "
                  f"keeps blocking on leases the relay has already dropped, "
                  f"until its own copy of the TTL runs out.")

        if over_ttl:
            r.bad(f"{over_ttl} grants came back with expires_in_ms above the "
                  f"configured TTL")

        # Replay the wire the way a daemon's LeaseCache does, and count the
        # handovers where the relay announced the new holder before the old
        # holder's expiry. The daemon matches the agent before erasing, so these
        # are survived rather than lost; the count is here because the wire
        # pattern is real and a regression would show up as the cache going
        # empty on exactly these.
        blinded = _replay_lease_stream(watcher.fanout)

        r.metrics = {
            "agents": agents,
            "lease_ttl_s": ttl_s,
            "window_s": seconds,
            "grants": len(grants),
            "grants_per_s": round(len(grants) / seconds, 1),
            "lease_held_frames_seen": held_frames,
            "lease_released_frames_seen": released_frames,
            "lease_expired_frames_seen": expired_frames,
            "leases_left_after_2x_ttl": len(quiet),
            "handovers_survived_stale_expiry": len(blinded),
            "relay_alive": relay.alive(),
        }
    finally:
        await watcher.close()
        with contextlib.suppress(Exception):
            await close_all(clients)
        relay.stop()
    return r
