from __future__ import annotations

import argparse
import asyncio
import contextlib
import errno
import json
import logging
import os
import shutil
import signal
import sys
from collections import deque
from collections.abc import Callable
from pathlib import Path

import websockets
from websockets.asyncio.server import Server

from .clock import Clock, RealClock
from .redact import opaque_outbound
from .relay import Relay

log = logging.getLogger("agent_presence.serve")

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8799


# How much one subscriber is allowed to cost. Presence and lease frames are
# only useful while they are current, so a backlog is not worth keeping: past
# this many frames the oldest go and the newest stay.
SEND_QUEUE_MAX = 512
# A single frame that cannot reach the socket in this long means the peer has
# stopped reading, not that it is busy.
SEND_STALL_S = 15.0
# Queue continuously full for this long is the slow-but-alive version of the
# same thing: it is never going to catch up, and it is not getting a coherent
# view of the room either way.
SEND_SATURATED_S = 10.0
# How often a writer that is parked on a socket looks at the clock. Not a
# threshold — the two above are the thresholds, and they are read off the
# injectable clock. This is only the resolution we notice them at.
SEND_POLL_S = 0.05

# The inbound twin of the queue above. Outbound backpressure protects the
# relay from a peer that will not read; this protects it from a peer that
# will not stop sending.
#
# Real traffic — a hook's coalesced batch, an MCP claim, a 30s heartbeat —
# runs at a few frames a second per connection, nowhere near this. The number
# is set by a different client: tests/load's contention scenarios run a
# claim/refuse loop with no backoff at all, back-to-back as fast as the
# round trip allows, deliberately, to see how the relay behaves under
# maximum legitimate contention. That loop clears 2000/s in short bursts on
# a quiet loopback socket. The bucket is set above that so this class of
# real, if aggressive, retry traffic is never mistaken for a flood — a
# request the relay refuses is not the request this limiter exists to stop;
# a peer sending far more than any client, well-behaved or not, ever does is.
INBOUND_RATE_HZ = 2000.0
# Bucket capacity: how big a burst is let through before the rate applies. A
# reconnect replaying a backlog, or a burst of contention retries, should not
# be punished for arriving all at once.
INBOUND_BURST = 4000.0
# Tokens exhausted continuously for this long means the peer is not bursty,
# it is sustained — the same "stop trusting this peer" call SEND_SATURATED_S
# makes for outbound, mirrored for inbound.
INBOUND_SATURATED_S = 10.0
# One frame is a few hundred bytes on the wire even at its fattest (a claim
# with a long intent string). This bounds the other kind of inbound cost: one
# oversized frame trying to make the relay allocate and JSON-parse megabytes.
# websockets closes the connection with 1009 on anything over this.
MAX_FRAME_BYTES = 65536


class WsConn:
    """One connection, one bounded outbound queue, one writer task.

    Sends used to be fire-and-forget: a task per frame, parked in a module-level
    set so it wouldn't be collected mid-flight. Nothing finished those tasks for
    a peer that never drained its socket, so the set and every payload it pinned
    grew for as long as the peer stayed attached — megabytes a second under
    load, with no ceiling and nothing to shed the connection.

    So: `send` is still non-blocking and still never raises, because ingest must
    not stall on a subscriber — that part of the old design was right. What
    changed is where the frames go. A deque with a cap holds them, one writer
    task drains it, and the cap is enforced by dropping the *oldest*: a stale
    presence frame is worth nothing, and the newest one is the whole point.

    A peer that stays saturated is disconnected. It is not receiving a coherent
    view of the room anyway, and the alternative is the relay paying for it
    forever. Every connection has its own queue and its own writer, so none of
    this reaches anybody else.

    Both shed thresholds are measured on the injectable clock, like every other
    deadline in this codebase. That is what makes the decision the same on a
    laptop and on a slow runner, and what lets a test reach it by moving the
    clock instead of by hoping a socket wedges at the right moment.

    The queue is the part this class bounds, and it is not the whole cost of a
    deaf peer: there is also the asyncio transport's write buffer and the
    kernel's own send buffer under it, which on Linux autotunes into megabytes.
    All of it is bounded and constant per connection — unlike the unbounded
    per-frame task set this replaced — but "one bounded queue" undersells the
    ceiling, and that is worth knowing before calibrating anything against it.
    """

    def __init__(self, ws, loop: asyncio.AbstractEventLoop, clock: Clock) -> None:
        self._ws = ws
        self._loop = loop
        self._clock = clock
        self.agent = ""
        self.human = ""
        self.room: str | None = None
        # Off the join frame, all optional. `principal` and `token` are a claim
        # of identity the relay checks against the roster; `unattended` is one
        # bit that selects inside whatever band that principal already owns.
        # None of them is authority — the relay latches a Grant from them once
        # and reads that from then on.
        self.principal: str | None = None
        self.token: str | None = None
        self.unattended = False

        # Read once, per connection: the limits are module constants so an
        # operator (or a test) can retune them without touching this class.
        self._max = SEND_QUEUE_MAX
        self._stall_s = SEND_STALL_S
        self._saturated_s = SEND_SATURATED_S
        self._poll_s = SEND_POLL_S

        self._queue: deque[dict | str] = deque()
        self._writer: asyncio.Task | None = None
        self._closed = False
        self._saturated_since: float | None = None
        self._sending_since: float | None = None
        self.dropped = 0

        # Inbound token bucket. Same read-once-per-connection rule as the
        # outbound limits just above, and the same reason: a test retunes the
        # module constant before the connection exists.
        self._in_rate = INBOUND_RATE_HZ
        self._in_burst = INBOUND_BURST
        self._in_saturated_s = INBOUND_SATURATED_S
        self._tokens = self._in_burst
        self._token_ts = self._clock.now()
        self._in_saturated_since: float | None = None
        self.inbound_dropped = 0

    def admit_inbound(self) -> bool:
        """One token per inbound frame. False means drop this one, unparsed.

        Refills continuously off the injectable clock, like every other
        deadline here — a test reaches the shed branch by moving the clock
        rather than by racing a real flood. A frame over budget costs the
        relay one counter increment and nothing else: it is never JSON-parsed
        or handed to the relay, which is the CPU a flooding peer is actually
        after.
        """
        now = self._clock.now()
        elapsed = max(0.0, now - self._token_ts)
        self._token_ts = now
        self._tokens = min(self._in_burst, self._tokens + elapsed * self._in_rate)
        if self._tokens < 1.0:
            self.inbound_dropped += 1
            if self._in_saturated_since is None:
                self._in_saturated_since = now
            return False
        self._tokens -= 1.0
        self._in_saturated_since = None
        return True

    def inbound_shed_reason(self) -> str | None:
        """Why this peer should be dropped for sending too much, or None.

        Mirrors `shed_reason` above: a burst alone never trips this, only
        tokens staying empty for `INBOUND_SATURATED_S` straight — the inbound
        version of "not busy, just never letting up."
        """
        if self._in_saturated_since is None:
            return None
        now = self._clock.now()
        if now - self._in_saturated_since >= self._in_saturated_s:
            return (f"inbound rate exceeded {self._in_rate}/s for over "
                    f"{self._in_saturated_s}s")
        return None

    def send(self, payload: dict) -> None:
        """Queue a frame. Never blocks, never raises, never waits on the peer."""
        self._enqueue(payload)

    def send_encoded(self, text: str) -> None:
        """Queue a frame whose wire text was already computed.

        `Relay.broadcast` calls this once per fan-out event with one shared
        string instead of handing every recipient the same dict and making
        each connection's `_drain` run `json.dumps` (and redaction) on it
        separately — see the docstring on `broadcast` for why that's safe to
        share and docs/relay-spike.md for why it's worth doing.
        """
        self._enqueue(text)

    def _enqueue(self, item: dict | str) -> None:
        if self._closed:
            return
        self._queue.append(item)
        while len(self._queue) > self._max:
            self._queue.popleft()
            self.dropped += 1
            if self._saturated_since is None:
                self._saturated_since = self._clock.now()
        if self._writer is None or self._writer.done():
            self._writer = self._loop.create_task(self._drain())

    def shed_reason(self) -> str | None:
        """Why this peer should be hung up on, or None to keep it.

        A pure function of the clock and two timestamps, so it gives the same
        answer on a fast laptop and a slow runner, and a test can reach either
        branch by moving the clock rather than by waiting.
        """
        now = self._clock.now()
        if (self._sending_since is not None
                and now - self._sending_since >= self._stall_s):
            return f"one frame did not leave in {self._stall_s}s"
        if (self._saturated_since is not None
                and now - self._saturated_since >= self._saturated_s):
            return f"send queue full for over {self._saturated_s}s"
        return None

    async def _drain(self) -> None:
        while self._queue and not self._closed:
            item = self._queue.popleft()
            if not self._queue:
                # Caught up. Whatever saturation there was is over.
                self._saturated_since = None
            # A str already went through opaque_outbound + json.dumps once,
            # room-wide, in Relay.broadcast — a dict is a direct/unicast send
            # (claim_result, leases, ...) that never shared an encode with
            # anyone, so it's still done here, per connection, as before.
            text = item if isinstance(item, str) else json.dumps(opaque_outbound(item))
            if not await self._write(text):
                return

    async def _write(self, text: str) -> bool:
        """Put one frame on the socket. False means this writer is finished.

        The send is a task we watch rather than an `asyncio.wait_for`, because
        `wait_for` can only measure its timeout on the event loop's own clock.
        Watching it lets both deadlines come off the injectable clock, and a
        peer whose socket has stopped draining is shed on the first look after
        the deadline passes rather than whenever the loop gets round to it.
        """
        send = asyncio.ensure_future(self._ws.send(text))
        self._sending_since = self._clock.now()
        try:
            while True:
                done, _ = await asyncio.wait({send}, timeout=self._poll_s)
                if done:
                    break
                why = self.shed_reason()
                if why is None:
                    continue
                # Off the socket before closing it: two coroutines touching one
                # websocket is not a supported thing to do, mid-shed included.
                send.cancel()
                await self._shed(why)
                return False

            try:
                send.result()
            except Exception:
                # Closed, reset, anything else: the session loop notices and
                # runs the ordinary teardown. Nothing to do here but stop.
                log.debug("dropped send to a dead connection", exc_info=True)
                self._closed = True
                self._queue.clear()
                return False

            # It landed, but a peer can be slow enough to keep the queue
            # permanently full without ever stalling one frame outright. That
            # counts too.
            why = self.shed_reason()
            if why is not None:
                await self._shed(why)
                return False
            return True
        finally:
            # However this writer leaves — shed, error, or the session
            # cancelling it — the send does not outlive it. An orphan task
            # pinning a payload nobody will ever collect is the exact leak this
            # class exists to stop.
            self._sending_since = None
            if not send.done():
                send.cancel()
            elif not send.cancelled():
                send.exception()   # retrieved, so nothing warns about it later

    async def _shed(self, why: str) -> None:
        """Hang up on a subscriber that is not keeping up.

        Closing is what puts its leases back: the session loop's `finally` calls
        `relay.leave`, which releases them and tells the room. Waiting for its
        own TTL would leave the room blocked on an agent nobody can reach.
        """
        self._closed = True
        self._queue.clear()
        self._sending_since = None
        log.warning("dropping subscriber %r (room %r): %s, %d frames shed",
                    self.agent, self.room, why, self.dropped)
        # 1013 Try Again Later. The close handshake needs the peer to read, and
        # this peer does not, so don't wait on it for long.
        with contextlib.suppress(Exception):
            await asyncio.wait_for(
                self._ws.close(code=1013, reason="subscriber too slow"),
                timeout=2.0,
            )
        # And if even that didn't land, take the socket down under it. Otherwise
        # the session loop stays parked on `async for` and the connection —
        # along with the leases it holds — never goes away.
        with contextlib.suppress(Exception):
            self._ws.transport.abort()

    def shutdown(self) -> None:
        """Stop writing to a connection whose session has ended."""
        self._closed = True
        self._queue.clear()
        self._sending_since = None
        if self._writer is not None and not self._writer.done():
            self._writer.cancel()


async def _session(ws, relay: Relay) -> None:
    conn = WsConn(ws, asyncio.get_running_loop(), relay.clock)
    try:
        async for raw in ws:
            if not conn.admit_inbound():
                why = conn.inbound_shed_reason()
                if why is None:
                    # Over budget but not sustained yet: drop this one frame,
                    # unparsed, and keep the connection. The common case for a
                    # legitimate peer is a burst that lets up.
                    continue
                log.warning(
                    "dropping connection %r (room %r): %s, %d frames dropped",
                    conn.agent, conn.room, why, conn.inbound_dropped,
                )
                # Same shutdown as a shed outbound peer: try the handshake,
                # then take the socket down under it if the peer won't
                # cooperate with that either.
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(
                        ws.close(code=1013, reason="too many requests"),
                        timeout=2.0,
                    )
                with contextlib.suppress(Exception):
                    ws.transport.abort()
                break
            try:
                msg = json.loads(raw)
            except Exception:
                # Malformed input is dropped, never fatal. Fail open.
                #
                # Not just JSONDecodeError: a binary frame reaches us as raw
                # bytes with none of the UTF-8 validation websockets does on
                # text frames, so json.loads can raise UnicodeDecodeError, and
                # a deeply nested payload can raise RecursionError. Neither is
                # a JSONDecodeError and both used to close the socket with a
                # 1011. Anything that fails to parse is just a dropped frame.
                log.debug("undecodable frame dropped", exc_info=True)
                continue
            if not isinstance(msg, dict):
                continue

            try:
                if msg.get("type") == "join":
                    # A join with no usable room is dropped like any other
                    # malformed frame. Indexing here used to raise KeyError and
                    # take the whole connection down with a 1011.
                    room = msg.get("room")
                    if not isinstance(room, str) or not room:
                        log.debug("join without a room; frame dropped")
                        continue
                    agent = msg.get("agent")
                    human = msg.get("human")
                    conn.agent = agent if isinstance(agent, str) else ""
                    conn.human = human if isinstance(human, str) else ""
                    principal = msg.get("principal")
                    token = msg.get("token")
                    conn.principal = (
                        principal if isinstance(principal, str) else None
                    )
                    conn.token = token if isinstance(token, str) else None
                    conn.unattended = msg.get("unattended") is True
                    # The relay owns identity. It latches the first declaration
                    # and refuses a later one, and it puts the real identity
                    # back on the connection when it does, so a rename attempt
                    # leaves nothing behind on this side either. The grant is
                    # latched by the same call and by the same rule.
                    # A refusal is answered, not dropped: the relay puts a
                    # `join_refused` frame on the socket saying which rule
                    # refused it and what to do instead. Silence left the client
                    # blocked on a lease snapshot that was never coming.
                    if not relay.join(room, conn):
                        log.debug("join refused for room %s; frame dropped", room)
                    # The relay has hashed and compared it. Keeping a bearer
                    # secret alive on a long-lived object for no further use is
                    # how it ends up in a traceback or a repr somewhere.
                    conn.token = None
                    continue

                reply = relay.handle(conn, msg)
            except Exception:
                log.exception("handler error; connection preserved")
                continue

            if reply is not None:
                # Through the same queue as everything else. Two coroutines
                # writing to one websocket is not a supported thing to do, and
                # it also puts the reply behind the fan-out this frame caused,
                # which is the order a client reading the socket expects.
                conn.send(reply)
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        try:
            relay.leave(conn)
        finally:
            # Always, even if the release fan-out went wrong: a writer task
            # left running on a dead socket is the leak this connection class
            # exists to prevent.
            conn.shutdown()


async def serve(
    host: str,
    port: int,
    relay: Relay,
    *,
    stop: asyncio.Event | None = None,
    on_ready: Callable[[Server], None] | None = None,
) -> None:
    """Serve until `stop` is set, or forever if there's nothing to stop it.

    `on_ready` fires once the listening sockets are bound. Pass port 0 and read
    the real port off the server there — that's the only way to learn it.
    """
    async with websockets.serve(
        lambda ws: _session(ws, relay), host, port, max_size=MAX_FRAME_BYTES,
        # permessage-deflate is on by default and, per docs/relay-spike.md's
        # profiler, cost more CPU than every other part of a broadcast
        # combined -- more than json encoding, more than the lease diff.
        # These frames run a couple hundred bytes; deflating each one, per
        # connection, per send, buys back little wire size for real CPU.
        # That trade only holds because today every deployment is loopback
        # (relay_client.py, cpp/daemon, go/internal/relay all dial
        # 127.0.0.1) — bandwidth is free and latency is a memcpy. #22 is the
        # relay's first network-reachable hop; whoever picks that up should
        # re-cost this against a real link before assuming "off" still wins.
        compression=None,
    ) as server:
        if on_ready is not None:
            on_ready(server)
        if stop is None:
            await asyncio.Future()
        else:
            await stop.wait()


def _bound_ports(server: Server) -> list[tuple[str, int]]:
    out = []
    for sock in server.sockets:
        name = sock.getsockname()
        if isinstance(name, tuple) and len(name) >= 2:
            out.append((str(name[0]), int(name[1])))
    return out


def _install_stop_handlers(stop: asyncio.Event) -> None:
    """SIGINT and SIGTERM set the stop event instead of tearing the loop down.

    add_signal_handler is the loop-safe route and it's what we want; the
    signal.signal fallback is for loops that don't implement it (Windows
    proactor), where a plain handler is still better than a traceback.
    """
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except (NotImplementedError, RuntimeError, ValueError):
            signal.signal(sig, lambda *_: loop.call_soon_threadsafe(stop.set))


async def run(host: str, port: int) -> None:
    """One relay, one process, shut down on a signal."""
    relay = Relay(RealClock())
    stop = asyncio.Event()
    _install_stop_handlers(stop)

    def ready(server: Server) -> None:
        for bound_host, bound_port in _bound_ports(server):
            log.info("relay listening on %s:%d", bound_host, bound_port)

    await serve(host, port, relay, stop=stop, on_ready=ready)
    log.info("shutting down")


def _env_port(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except ValueError:
        raise SystemExit(f"{name} must be an integer, got {raw!r}") from None


IMPL_ENV = "AGENT_PRESENCE_RELAY_IMPL"
GORELAY_BIN_ENV = "AGENT_PRESENCE_GORELAY_BIN"


def _find_gorelay_bin() -> str:
    """Where the Go relay binary lives, checked in the order an operator
    would expect: an explicit override, then the conventional build output
    next to this checkout, then whatever `gorelay` resolves to on PATH.

    Raises SystemExit with a build hint rather than a bare FileNotFoundError
    two frames of traceback later — `--impl go` with nothing built is the
    common way to hit this, not a bug.
    """
    override = os.environ.get(GORELAY_BIN_ENV, "").strip()
    if override:
        return override
    # python/src/agent_presence/serve.py -> repo root is four parents up.
    repo_root = Path(__file__).resolve().parents[3]
    candidate = repo_root / "go" / "bin" / "gorelay"
    if candidate.exists():
        return str(candidate)
    found = shutil.which("gorelay")
    if found:
        return found
    raise SystemExit(
        "AGENT_PRESENCE_RELAY_IMPL=go (or --impl go) but no gorelay binary "
        f"was found. Build it: cd go && go build -o bin/gorelay ./cmd/gorelay "
        f"— or set {GORELAY_BIN_ENV} to its path."
    )


def _exec_go_relay(host: str, port: int, log_level: str) -> int:
    """Replace this process with the Go relay, opt-in per docs/relay-parity.md.

    A real exec, not a subprocess: `agent-presence-relay --impl go` becomes
    indistinguishable at the OS level from running `gorelay` directly, so
    signal handling, port binding and exit codes are the Go binary's own —
    nothing here is a second copy of that logic to keep in sync.
    """
    bin_path = _find_gorelay_bin()
    argv = [bin_path, "--host", host, "--port", str(port)]
    env = dict(os.environ)
    env["AGENT_PRESENCE_LOG_LEVEL"] = log_level
    os.execve(bin_path, argv, env)
    raise AssertionError("os.execve returned, which never happens on success")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="agent-presence-relay",
        description="Run the agent-presence relay. Leases and fan-out live here.",
    )
    parser.add_argument(
        "--host",
        default=os.environ.get("AGENT_PRESENCE_HOST", DEFAULT_HOST),
        help="interface to bind (env AGENT_PRESENCE_HOST, default %(default)s). "
             "Traffic is unencrypted and room membership needs no credential — "
             "see docs/threat-model.md before binding anything but loopback.",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=_env_port("AGENT_PRESENCE_PORT", DEFAULT_PORT),
        help="port to bind, 0 picks a free one (env AGENT_PRESENCE_PORT, "
             "default %(default)s)",
    )
    parser.add_argument(
        "--log-level",
        default=os.environ.get("AGENT_PRESENCE_LOG_LEVEL", "INFO"),
        help="python logging level (env AGENT_PRESENCE_LOG_LEVEL, default INFO)",
    )
    parser.add_argument(
        "--impl",
        choices=("python", "go"),
        default=os.environ.get(IMPL_ENV, "python"),
        help="which relay implementation to run (env AGENT_PRESENCE_RELAY_IMPL, "
             "default python). 'go' execs the Go relay from go/cmd/gorelay — "
             "opt-in, see docs/relay-parity.md for what parity has and hasn't "
             "been verified before switching a real room to it.",
    )
    args = parser.parse_args(argv)

    if args.impl == "go":
        return _exec_go_relay(args.host, args.port, args.log_level)

    level = args.log_level.upper()
    if level not in logging.getLevelNamesMapping():
        raise SystemExit(f"unknown log level {args.log_level!r}")

    # stderr, not stdout: something downstream will want to parse stdout one
    # day and logs on it would be a nuisance to unpick later.
    logging.basicConfig(
        stream=sys.stderr,
        level=level,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    # websockets logs open and close per connection at INFO. One line per hook
    # burst per machine is noise, not information. Turn it on with DEBUG.
    if level != "DEBUG":
        logging.getLogger("websockets").setLevel(logging.WARNING)

    try:
        asyncio.run(run(args.host, args.port))
    except KeyboardInterrupt:
        # Only reachable if a signal lands outside the running loop.
        pass
    except OSError as exc:
        # Bind failures are the common case and deserve the specific message.
        # Anything else that gets this far is still fatal, just not a bind.
        if exc.errno in (errno.EADDRINUSE, errno.EADDRNOTAVAIL, errno.EACCES):
            log.error("cannot bind %s:%d — %s", args.host, args.port, exc)
        else:
            log.error("relay stopped on an OS error: %s", exc)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
