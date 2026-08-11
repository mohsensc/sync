"""#22: the relay terminates TLS. wss:// connects and behaves exactly like
ws:// once the handshake is done — the frame protocol in `_session` doesn't
know or care. What's worth pinning down here is the handshake itself: a
default client doesn't trust a self-signed dev cert, one that's told to does,
and plaintext ws:// is still what a zero-config `serve()` call gives you.

Certs are generated with the `openssl` CLI rather than a Python crypto
library — the same call docs/tls-dev-cert.md tells an operator to run, so
the test proves the documented recipe actually works. Skipped if openssl
isn't on PATH.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import shutil
import ssl
import subprocess

import pytest
import websockets

from agent_presence.clock import RealClock
from agent_presence.relay import Relay
from agent_presence.serve import build_tls_context, serve

pytestmark = pytest.mark.skipif(
    shutil.which("openssl") is None, reason="openssl CLI not on PATH"
)


@pytest.fixture(scope="module")
def dev_cert(tmp_path_factory):
    """One self-signed EC cert/key pair, the exact recipe docs/tls-dev-cert.md
    documents, shared by every test in this module."""
    d = tmp_path_factory.mktemp("tls")
    cert, key = d / "cert.pem", d / "key.pem"
    subprocess.run(
        [
            "openssl", "req", "-x509", "-newkey", "ec",
            "-pkeyopt", "ec_paramgen_curve:prime256v1",
            "-keyout", str(key), "-out", str(cert),
            "-days", "1", "-nodes",
            "-subj", "/CN=agent-presence-relay-test",
            "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
        ],
        check=True, capture_output=True,
    )
    return str(cert), str(key)


@pytest.fixture
async def tls_server(dev_cert):
    cert, key = dev_cert
    relay = Relay(RealClock())
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    ready: asyncio.Future = loop.create_future()

    def on_ready(srv) -> None:
        if not ready.done():
            ready.set_result(srv.sockets[0].getsockname()[1])

    task = asyncio.create_task(
        serve("127.0.0.1", 0, relay, stop=stop, on_ready=on_ready,
              ssl_context=build_tls_context(cert, key))
    )
    port = await asyncio.wait_for(ready, timeout=5)
    yield relay, f"wss://127.0.0.1:{port}", cert
    stop.set()
    with contextlib.suppress(asyncio.CancelledError):
        await asyncio.wait_for(task, timeout=5)


def _trusting_context(cafile: str) -> ssl.SSLContext:
    ctx = ssl.create_default_context(cafile=cafile)
    return ctx


async def test_wss_handshake_succeeds_when_the_client_trusts_the_cert(tls_server):
    _, url, cert = tls_server
    async with websockets.connect(url, ssl=_trusting_context(cert)) as ws:
        await ws.send(json.dumps({"type": "join", "room": "r",
                                  "agent": "a", "human": "h"}))
        raw = await asyncio.wait_for(ws.recv(), timeout=5)
        assert json.loads(raw)["type"] == "leases"


async def test_wss_handshake_fails_without_the_cert_trusted(tls_server):
    """The whole point: a default client — nothing told to trust this
    specific self-signed cert — must not complete the handshake. A relay
    presenting a cert nobody vouches for is exactly what verification exists
    to catch."""
    _, url, _cert = tls_server
    with pytest.raises((ssl.SSLCertVerificationError,
                        websockets.exceptions.WebSocketException, OSError)):
        async with websockets.connect(url, open_timeout=5):
            pass


async def test_two_clients_over_wss_see_each_other(tls_server):
    """The frame protocol behind the handshake is unchanged — same fan-out
    ws:// already gets, over an encrypted connection."""
    _, url, cert = tls_server
    ctx = _trusting_context(cert)
    async with websockets.connect(url, ssl=ctx) as a, \
            websockets.connect(url, ssl=ctx) as b:
        await a.send(json.dumps({"type": "join", "room": "r",
                                 "agent": "a1", "human": "sara"}))
        await asyncio.wait_for(a.recv(), timeout=5)  # leases snapshot
        await b.send(json.dumps({"type": "join", "room": "r",
                                 "agent": "a2", "human": "mo"}))
        await asyncio.wait_for(b.recv(), timeout=5)  # leases snapshot

        await a.send(json.dumps({"type": "event", "verb": "edit", "source": "hook",
                                 "region": {"path": "x.py", "symbol": None,
                                            "lines": None}}))
        raw = await asyncio.wait_for(b.recv(), timeout=5)
        msg = json.loads(raw)
        assert msg.get("agent") == "a1"


async def test_plaintext_ws_is_still_the_zero_config_default():
    """No ssl_context argument at all — the call every existing caller of
    `serve()` already makes — must still be plain ws://, not silently
    upgraded or broken by this change."""
    relay = Relay(RealClock())
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    ready: asyncio.Future = loop.create_future()

    def on_ready(srv) -> None:
        if not ready.done():
            ready.set_result(srv.sockets[0].getsockname()[1])

    task = asyncio.create_task(serve("127.0.0.1", 0, relay, stop=stop, on_ready=on_ready))
    port = await asyncio.wait_for(ready, timeout=5)
    try:
        async with websockets.connect(f"ws://127.0.0.1:{port}") as ws:
            await ws.send(json.dumps({"type": "join", "room": "r",
                                      "agent": "a", "human": "h"}))
            raw = await asyncio.wait_for(ws.recv(), timeout=5)
            assert json.loads(raw)["type"] == "leases"
    finally:
        stop.set()
        with contextlib.suppress(asyncio.CancelledError):
            await asyncio.wait_for(task, timeout=5)


def test_main_rejects_cert_without_key(tmp_path):
    from agent_presence.serve import main

    cert = tmp_path / "cert.pem"
    cert.write_text("not a real cert")
    with pytest.raises(SystemExit, match="--tls-cert and --tls-key"):
        main(["--tls-cert", str(cert)])


def test_main_rejects_key_without_cert(tmp_path):
    from agent_presence.serve import main

    key = tmp_path / "key.pem"
    key.write_text("not a real key")
    with pytest.raises(SystemExit, match="--tls-cert and --tls-key"):
        main(["--tls-key", str(key)])
