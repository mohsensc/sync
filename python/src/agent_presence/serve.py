from __future__ import annotations

import argparse
import asyncio
import contextlib
import errno
import json
import logging
import os
import signal
import sys
from collections import deque
from collections.abc import Callable

import websockets
from websockets.asyncio.server import Server

from .clock import RealClock
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
    """

    def __init__(self, ws, loop: asyncio.AbstractEventLoop) -> None:
        self._ws = ws
        self._loop = loop
        self.agent = ""
        self.human = ""
        self.room: str | None = None

        # Read once, per connection: the limits are module constants so an
        # operator (or a test) can retune them without touching this class.
        self._max = SEND_QUEUE_MAX
        self._stall_s = SEND_STALL_S
        self._saturated_s = SEND_SATURATED_S

        self._queue: deque[dict] = deque()
        self._writer: asyncio.Task | None = None
        self._closed = False
        self._saturated_since: float | None = None
        self.dropped = 0

    def send(self, payload: dict) -> None:
        """Queue a frame. Never blocks, never raises, never waits on the peer."""
        if self._closed:
            return
        self._queue.append(payload)
        while len(self._queue) > self._max:
            self._queue.popleft()
            self.dropped += 1
            if self._saturated_since is None:
                self._saturated_since = self._loop.time()
        if self._writer is None or self._writer.done():
            self._writer = self._loop.create_task(self._drain())

    async def _drain(self) -> None:
        while self._queue and not self._closed:
            payload = self._queue.popleft()
            if not self._queue:
                # Caught up. Whatever saturation there was is over.
                self._saturated_since = None
            try:
                await asyncio.wait_for(
                    self._ws.send(json.dumps(opaque_outbound(payload))),
                    timeout=self._stall_s,
                )
            except asyncio.TimeoutError:
                await self._shed(f"one frame did not leave in {self._stall_s}s")
                return
            except Exception:
                # Closed, reset, anything else: the session loop notices and
                # runs the ordinary teardown. Nothing to do here but stop.
                log.debug("dropped send to a dead connection", exc_info=True)
                self._closed = True
                self._queue.clear()
                return
            if (self._saturated_since is not None
                    and self._loop.time() - self._saturated_since
                    > self._saturated_s):
                await self._shed(
                    f"send queue full for over {self._saturated_s}s"
                )
                return

    async def _shed(self, why: str) -> None:
        """Hang up on a subscriber that is not keeping up.

        Closing is what puts its leases back: the session loop's `finally` calls
        `relay.leave`, which releases them and tells the room. Waiting for its
        own TTL would leave the room blocked on an agent nobody can reach.
        """
        self._closed = True
        self._queue.clear()
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
        if self._writer is not None and not self._writer.done():
            self._writer.cancel()


async def _session(ws, relay: Relay) -> None:
    conn = WsConn(ws, asyncio.get_running_loop())
    try:
        async for raw in ws:
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
                    # The relay owns identity. It latches the first declaration
                    # and refuses a later one, and it puts the real identity
                    # back on the connection when it does, so a rename attempt
                    # leaves nothing behind on this side either.
                    if not relay.join(room, conn):
                        log.debug("join refused for room %s; frame dropped", room)
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
    async with websockets.serve(lambda ws: _session(ws, relay), host, port) as server:
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


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="agent-presence-relay",
        description="Run the agent-presence relay. Leases and fan-out live here.",
    )
    parser.add_argument(
        "--host",
        default=os.environ.get("AGENT_PRESENCE_HOST", DEFAULT_HOST),
        help="interface to bind (env AGENT_PRESENCE_HOST, default %(default)s)",
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
    args = parser.parse_args(argv)

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
