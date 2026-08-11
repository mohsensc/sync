"""A connection to the relay for callers that are not `serve.py` itself.

`Tools` used to hold a `Relay` object and mutate its registry in-process — a
claim made through the MCP tool never left the Python process, so no other
daemon ever heard about it. This module is the fix: `RelayConnection` speaks
the exact frame protocol `serve.py` answers (join / claim / release / move),
the same protocol `cpp/daemon/relay_client.cpp` and every websocket test in
`test_serve.py` speak. There is no in-process shortcut left for the MCP tools
to take.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import time

import websockets

from .leases import PRESENCE_TTL_S

log = logging.getLogger("agent_presence.relay_client")

# Same env var and same default `cpp/daemon/main.cpp` reads for the daemon's
# own relay client — one name for "where the relay is" across the whole
# system, not a Python-specific one.
RELAY_ENV = "AGENT_PRESENCE_RELAY"
DEFAULT_RELAY_URL = "ws://127.0.0.1:8799"

CONNECT_TIMEOUT_S = 5.0
REQUEST_TIMEOUT_S = 5.0

_REQUEST_REPLY_TYPES = frozenset({"claim_result", "move_result"})
_JOIN_REPLY_TYPES = frozenset({"leases", "join_refused"})


def relay_url() -> str:
    return os.environ.get(RELAY_ENV, "").strip() or DEFAULT_RELAY_URL


class RelayUnavailable(Exception):
    """The relay could not be reached, refused the join, or did not answer a
    request in time.

    Every wire operation on `RelayConnection` raises this instead of hanging
    or leaking a raw `OSError` / `websockets` exception past the tool
    boundary — an MCP server is long-lived, and a tool call that blocks
    forever on a relay that will never answer is worse than one that errors
    promptly.
    """


class RelayConnection:
    """One MCP session's link to the relay — the same kind of connection a
    daemon or a scripted client opens.

    Connects lazily: nothing dials out until the first tool call, and every
    dial and every request carries its own deadline. Any failure — connect
    refused, join refused, a request that times out — tears the connection
    down, so the next call starts clean instead of reusing a socket that may
    be half-dead.
    """

    def __init__(
        self,
        url: str,
        room: str,
        agent: str,
        human: str,
        *,
        principal: str | None = None,
        token: str = "",
        unattended: bool = False,
        connect_timeout: float = CONNECT_TIMEOUT_S,
        request_timeout: float = REQUEST_TIMEOUT_S,
    ) -> None:
        self._url = url
        self._room = room
        self._agent = agent
        self._human = human
        self._principal = principal
        self._token = token
        self._unattended = unattended
        self._connect_timeout = connect_timeout
        self._request_timeout = request_timeout

        # Guards connect *and* the request/reply pairing below. Tool calls on
        # one MCP session are effectively sequential, but a lock makes that a
        # guarantee instead of an assumption: two calls racing on one socket
        # cannot cross replies or trample the reconnect.
        self._lock = asyncio.Lock()
        self._ws: websockets.ClientConnection | None = None
        self._reader: asyncio.Task | None = None
        self._replies: asyncio.Queue[dict] = asyncio.Queue()

        # (path, symbol) -> lease body, reconciled from the join snapshot and
        # every incremental `lease` frame since. Not read by anything yet —
        # kept for the reader loop to have somewhere to put fan-out that isn't
        # a reply to a specific request — but it's the seam a future
        # `who_holds` tool would use without touching the wire layer again.
        self._leases: dict[tuple[str, str | None], dict] = {}
        # agent -> (received_at, frame). Only ever grows with what *this*
        # connection has observed since it joined. The relay does not replay
        # presence history to a joiner, only the lease table — so an MCP
        # session that only just connected genuinely does not know about hook
        # activity from before it did. That's a gap in the relay's join frame,
        # not something a client can paper over.
        self._presence: dict[str, tuple[float, dict]] = {}

    async def close(self) -> None:
        async with self._lock:
            await self._teardown()

    async def _teardown(self) -> None:
        if self._reader is not None:
            self._reader.cancel()
            self._reader = None
        if self._ws is not None:
            with contextlib.suppress(Exception):
                await self._ws.close()
            self._ws = None
        # A torn-down connection cannot vouch for a stale reply arriving after
        # the fact, so start the next connection with a clean queue.
        self._replies = asyncio.Queue()

    # -- connect --------------------------------------------------------

    async def _connect_locked(self) -> None:
        """Connect and join, if not already connected. Caller holds `_lock`."""
        if self._ws is not None:
            return

        try:
            ws = await asyncio.wait_for(
                websockets.connect(self._url), timeout=self._connect_timeout
            )
        except (OSError, asyncio.TimeoutError,
                websockets.exceptions.WebSocketException) as exc:
            raise RelayUnavailable(
                f"could not reach the relay at {self._url}: {exc}"
            ) from exc

        join = {
            "type": "join", "room": self._room,
            "agent": self._agent, "human": self._human,
            "unattended": self._unattended,
        }
        if self._principal is not None:
            join["principal"] = self._principal
        if self._token:
            join["token"] = self._token

        try:
            reply = await asyncio.wait_for(
                self._join(ws, join), timeout=self._connect_timeout
            )
        except (OSError, asyncio.TimeoutError,
                websockets.exceptions.WebSocketException) as exc:
            with contextlib.suppress(Exception):
                await ws.close()
            raise RelayUnavailable(
                f"relay at {self._url} did not answer the join: {exc}"
            ) from exc

        if reply["type"] == "join_refused":
            with contextlib.suppress(Exception):
                await ws.close()
            raise RelayUnavailable(
                f"relay refused the join ({reply.get('reason')}): "
                f"{reply.get('detail')}"
            )

        self._apply_leases(reply)
        self._ws = ws
        self._reader = asyncio.ensure_future(self._read_loop(ws))

    async def _join(self, ws, join: dict) -> dict:
        await ws.send(json.dumps(join))
        # The lease snapshot answers the join synchronously, but a relay with
        # an org policy file queues a `policy` frame right behind it, so the
        # first frame off the wire is not guaranteed to be the one we want.
        while True:
            msg = json.loads(await ws.recv())
            if isinstance(msg, dict) and msg.get("type") in _JOIN_REPLY_TYPES:
                return msg

    async def _read_loop(self, ws) -> None:
        try:
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except Exception:
                    continue
                if not isinstance(msg, dict):
                    continue
                kind = msg.get("type")
                if kind == "leases":
                    self._apply_leases(msg)
                elif kind == "lease":
                    self._apply_lease(msg)
                elif kind == "presence":
                    self._apply_presence(msg)
                elif kind in _REQUEST_REPLY_TYPES:
                    self._replies.put_nowait(msg)
                # policy / ack / negotiate / redundant_work / join_refused:
                # nothing on this connection asks for these today.
        except websockets.exceptions.ConnectionClosed:
            pass
        finally:
            # The socket is gone either way; the next call reconnects rather
            # than trusting a half-closed one.
            self._ws = None
            self._reader = None

    # -- local caches, fed by the reader loop ----------------------------

    @staticmethod
    def _region_key(region: dict | None) -> tuple[str, str | None] | None:
        if not isinstance(region, dict) or not isinstance(region.get("path"), str):
            return None
        return (region["path"], region.get("symbol"))

    def _apply_leases(self, msg: dict) -> None:
        leases = {}
        for entry in msg.get("leases", []):
            key = self._region_key(entry.get("region"))
            if key is not None:
                leases[key] = entry
        self._leases = leases

    def _apply_lease(self, msg: dict) -> None:
        key = self._region_key(msg.get("region"))
        if key is None:
            return
        if msg.get("state") in ("released", "expired"):
            self._leases.pop(key, None)
        else:
            self._leases[key] = msg

    def _apply_presence(self, msg: dict) -> None:
        agent = msg.get("agent")
        if isinstance(agent, str) and agent:
            self._presence[agent] = (time.time(), msg)

    # -- requests ---------------------------------------------------------

    async def _request(self, payload: dict) -> dict:
        """Send a frame and wait for the one reply it provokes."""
        async with self._lock:
            await self._connect_locked()
            try:
                await asyncio.wait_for(
                    self._ws.send(json.dumps(payload)),
                    timeout=self._request_timeout,
                )
                return await asyncio.wait_for(
                    self._replies.get(), timeout=self._request_timeout
                )
            except (OSError, asyncio.TimeoutError,
                    websockets.exceptions.WebSocketException) as exc:
                await self._teardown()
                raise RelayUnavailable(
                    f"relay at {self._url} did not answer: {exc}"
                ) from exc

    async def claim(self, region: dict, intent: str) -> dict:
        return await self._request(
            {"type": "claim", "region": region, "intent": intent}
        )

    async def move(self, region: dict, move: str, reason: str) -> dict:
        return await self._request(
            {"type": "move", "region": region, "move": move, "reason": reason}
        )

    async def release(self, region: dict) -> None:
        """No reply travels for a release — the room hears about it, not the
        releaser (see `Relay.publish`) — so this only has to land the send."""
        async with self._lock:
            await self._connect_locked()
            try:
                await asyncio.wait_for(
                    self._ws.send(json.dumps({"type": "release", "region": region})),
                    timeout=self._request_timeout,
                )
            except (OSError, asyncio.TimeoutError,
                    websockets.exceptions.WebSocketException) as exc:
                await self._teardown()
                raise RelayUnavailable(
                    f"relay at {self._url} dropped the release: {exc}"
                ) from exc

    async def presence(self, *, exclude: str) -> list[dict]:
        """Peers seen on this connection since it joined, same TTL the relay
        applies server-side to its own presence table."""
        async with self._lock:
            await self._connect_locked()
        cutoff = time.time() - PRESENCE_TTL_S
        out = []
        for agent, (seen_at, msg) in self._presence.items():
            if agent == exclude or seen_at < cutoff:
                continue
            region = msg.get("region") or {}
            out.append({
                "human": msg.get("human"),
                "agent": agent,
                "verb": msg.get("verb"),
                "path": region.get("path"),
                "symbol": region.get("symbol"),
                # The wire's `presence` frame carries no intent field — only a
                # claim does, and a claim is not an event. Left None rather
                # than guessed at.
                "intent": None,
            })
        return out
