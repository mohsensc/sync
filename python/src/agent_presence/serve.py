from __future__ import annotations

import asyncio
import json
import logging

import websockets

from .relay import Relay

log = logging.getLogger("agent_presence.serve")


class WsConn:
    def __init__(self, ws, loop: asyncio.AbstractEventLoop) -> None:
        self._ws = ws
        self._loop = loop
        self.agent = ""
        self.human = ""
        self.room: str | None = None

    def send(self, payload: dict) -> None:
        # Fire-and-forget: a slow subscriber must never stall ingest.
        task = self._loop.create_task(self._safe_send(payload))
        # Hold a reference so the task isn't garbage collected mid-flight.
        _INFLIGHT.add(task)
        task.add_done_callback(_INFLIGHT.discard)

    async def _safe_send(self, payload: dict) -> None:
        try:
            await self._ws.send(json.dumps(payload))
        except Exception:
            log.debug("dropped send to closed connection", exc_info=True)


_INFLIGHT: set[asyncio.Task] = set()


async def _session(ws, relay: Relay) -> None:
    conn = WsConn(ws, asyncio.get_running_loop())
    try:
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                # Malformed input is dropped, never fatal. Fail open.
                continue
            if not isinstance(msg, dict):
                continue

            if msg.get("type") == "join":
                conn.agent = msg.get("agent", "")
                conn.human = msg.get("human", "")
                relay.join(msg["room"], conn)
                continue

            try:
                reply = relay.handle(conn, msg)
            except Exception:
                log.exception("handler error; connection preserved")
                continue

            if reply is not None:
                await ws.send(json.dumps(reply))
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        relay.leave(conn)


async def serve(host: str, port: int, relay: Relay) -> None:
    async with websockets.serve(lambda ws: _session(ws, relay), host, port):
        await asyncio.Future()
