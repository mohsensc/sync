from __future__ import annotations

import argparse
import asyncio
import hashlib
import logging
import os
import subprocess
import sys
import uuid

from .negotiation import MOVES, normalize_move
from .principals import LocalIdentity, local_identity
from .relay_client import (
    DEFAULT_RELAY_URL,
    RELAY_ENV,
    RelayConnection,
    RelayUnavailable,
    relay_url,
)
from .room_key import room_id_from_remote

log = logging.getLogger("agent_presence.mcp_server")


def _region_dict(path: str, symbol: str | None) -> dict:
    """A region in wire shape. Hashing for opaque mode happens relay-side, in
    `clean_region_dict` — the same place it happens for a hook's `event` frame
    and a daemon's `claim` frame — so this channel keys the lease table the
    same way theirs do without doing anything special here."""
    return {"path": path, "symbol": symbol, "lines": None}


def _claim_reply(reply: dict, agent: str) -> dict:
    """The wire's `claim_result` frame, reshaped into what this tool has
    always returned: seconds instead of milliseconds, `held_by_human` instead
    of the wire's `human`, and the move list spelled out — that list is a
    tool-surface convenience, not a lease fact, so the wire doesn't carry it."""
    if reply.get("granted"):
        result = {"granted": True}
        if reply.get("rung") == 4:
            result["rung"] = 4
            result["redundant"] = reply["redundant"]
        return result

    result = {
        "granted": False,
        "held_by": reply.get("held_by"),
        "held_by_human": reply.get("human"),
        "intent": reply.get("intent", ""),
        "decision": reply.get("decision", "abort"),
    }

    if reply.get("reserved"):
        # Not held, kept: a handover freed this region for somebody else a
        # moment ago. Short and self-clearing, so the answer is a number of
        # seconds rather than a negotiation.
        result["reserved"] = True
        result["moves"] = ["DEFER"]
        if "retry_in_ms" in reply:
            result["retry_in_s"] = reply["retry_in_ms"] / 1000.0
        return result

    result["moves"] = list(MOVES)
    if "handover_in_ms" in reply:
        result["handover_in_s"] = reply["handover_in_ms"] / 1000.0
        result["waiting"] = reply.get("waiting", 0)
        if reply.get("handover_to") == agent:
            # DEFER with a number on it. This is the region's queue, and this
            # agent is at the front of it.
            result["retry_in_s"] = result["handover_in_s"]
        else:
            result["handover_to"] = reply.get("handover_to")
    return result


class Tools:
    """The deliberate channel. Hooks report what an agent *did*; these tools
    let it declare what it *intends*, which hooks can never infer.

    Talks to the relay the same way any other client does: over a
    `RelayConnection`, never by touching a `Relay` object's tables directly.
    A claim made here is a claim the relay actually holds, and every other
    connection in the room hears about it the same way it hears about a claim
    made by a daemon or a scripted client.
    """

    def __init__(self, conn: RelayConnection, room: str, agent: str, human: str) -> None:
        self._conn = conn
        self._room = room
        self._agent = agent
        self._human = human

    # Read-only, because identity is decided once at construction for the same
    # reason the relay latches it at join: a tool that could rename itself
    # mid-session could release a teammate's leases.
    @property
    def room(self) -> str:
        return self._room

    @property
    def agent(self) -> str:
        return self._agent

    @property
    def human(self) -> str:
        return self._human

    async def who_else_is_here(self) -> list[dict]:
        try:
            return await self._conn.presence(exclude=self._agent)
        except RelayUnavailable:
            # Fail open: "no news of peers" is not the same claim as "nobody
            # is here", but a dead relay must not turn this tool into a hang.
            return []

    async def claim_work(self, path: str, symbol: str | None, intent: str) -> dict:
        region = _region_dict(path, symbol)
        try:
            reply = await self._conn.claim(region, intent)
        except RelayUnavailable as exc:
            # Fail closed here, deliberately: granting locally when the relay
            # cannot be told is exactly the bug this class exists to not have
            # anymore. An error the agent can see beats a claim nobody else
            # ever learns about.
            return {"granted": False, "error": str(exc)}
        return _claim_reply(reply, self._agent)

    async def release(self, path: str, symbol: str | None) -> dict:
        region = _region_dict(path, symbol)
        try:
            await self._conn.release(region)
        except RelayUnavailable as exc:
            return {"released": False, "error": str(exc)}
        return {"released": True}

    async def respond(
        self, path: str, symbol: str | None, move: str, reason: str = ""
    ) -> dict:
        canonical = normalize_move(move)
        if canonical is None:
            # Checked locally rather than round-tripped: an invented move is
            # never valid no matter what the relay says, and this keeps the
            # tool surface total — respond never throws — without a network
            # call to learn something already known.
            return {
                "granted": False,
                "error": f"unknown move: {move}",
                "valid_moves": list(MOVES),
            }
        region = _region_dict(path, symbol)
        try:
            reply = await self._conn.move(region, canonical, reason)
        except RelayUnavailable as exc:
            return {"granted": False, "error": str(exc)}
        result = {
            "granted": bool(reply.get("granted")),
            "action": reply.get("action", ""),
            # PROCEED is the only move `Negotiator.apply` ever logs as an
            # override, so the action name alone is enough to reconstruct the
            # flag the wire's `move_result` frame doesn't carry.
            "override": reply.get("action") == "proceed",
        }
        if "error" in reply:
            result["error"] = reply["error"]
        return result


def tool_descriptors() -> list[dict]:
    """The four tools as plain dicts, so the schema is testable without mcp."""
    return [
        {
            "name": "who_else_is_here",
            "description": "List other agents currently active in this repo.",
            "input_schema": {"type": "object", "properties": {}},
        },
        {
            "name": "claim_work",
            "description": "Declare intent to modify a region before editing it.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "symbol": {"type": "string"},
                    "intent": {"type": "string"},
                },
                "required": ["path", "intent"],
            },
        },
        {
            "name": "release",
            "description": "Release a previously claimed region.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "symbol": {"type": "string"},
                },
                "required": ["path"],
            },
        },
        {
            "name": "respond",
            "description": (
                "Reply to a contested claim with DEFER, SPLIT, HANDOFF or PROCEED."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "symbol": {"type": "string"},
                    "move": {"type": "string"},
                    "reason": {"type": "string"},
                },
                "required": ["path", "move"],
            },
        },
    ]


async def dispatch(tools: Tools, name: str, arguments: dict) -> dict | list:
    """Route a tool call to the matching method. Raises KeyError on an
    unknown tool name. Tool calls themselves never raise: an invented
    negotiation move comes back as a refusal carrying the valid moves."""
    if name == "who_else_is_here":
        return await tools.who_else_is_here()
    if name == "claim_work":
        return await tools.claim_work(
            arguments["path"], arguments.get("symbol"), arguments["intent"]
        )
    if name == "release":
        return await tools.release(arguments["path"], arguments.get("symbol"))
    if name == "respond":
        return await tools.respond(
            arguments["path"],
            arguments.get("symbol"),
            arguments["move"],
            arguments.get("reason", ""),
        )
    raise KeyError(f"unknown tool: {name!r}")


def build_server(tools: Tools):
    """Register the four tools with an MCP server.

    mcp is imported lazily: the domain logic above must stay usable (and
    testable) on a machine that never installed the SDK.
    """
    import json

    from mcp.server import Server
    from mcp.types import CallToolResult, ListToolsResult, TextContent, Tool

    tool_list = [Tool(**d) for d in tool_descriptors()]

    async def on_list_tools(ctx, params=None) -> ListToolsResult:
        return ListToolsResult(tools=tool_list)

    async def on_call_tool(ctx, params) -> CallToolResult:
        result = await dispatch(tools, params.name, params.arguments or {})
        return CallToolResult(
            content=[TextContent(type="text", text=json.dumps(result))]
        )

    return Server(
        "agent-presence",
        on_list_tools=on_list_tools,
        on_call_tool=on_call_tool,
    )


# -- identity ---------------------------------------------------------------
#
# Three things have to be decided before a Tools exists: which room, which
# agent, which human. All three are derived, never configured, because the
# whole point of keying off the git remote is that cloning the repo is the
# setup. Every one of them has an env override so a test (or a second agent on
# one machine) can pin it.

AGENT_ENV = "AGENT_PRESENCE_AGENT"
HUMAN_ENV = "AGENT_PRESENCE_HUMAN"
ROOM_ENV = "AGENT_PRESENCE_ROOM"


def _git(cwd: str, *args: str) -> str | None:
    """A git query that can't fail loudly. No repo, no git, no remote — all the
    same answer, and the caller falls back to local-only mode."""
    try:
        out = subprocess.run(
            ("git", *args),
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode != 0:
        return None
    value = out.stdout.strip()
    return value or None


def repo_root(cwd: str | None = None) -> str:
    cwd = os.path.abspath(cwd or os.getcwd())
    return _git(cwd, "rev-parse", "--show-toplevel") or cwd


def git_remote(cwd: str | None = None) -> str | None:
    """The remote this repo pushes to, if there is one."""
    cwd = os.path.abspath(cwd or os.getcwd())
    remote = _git(cwd, "remote", "get-url", "origin")
    if remote:
        return remote
    # No origin doesn't mean no remote. Take the first one there is, in git's
    # own order, so two clones of the same fork still land in one room.
    names = _git(cwd, "remote")
    if not names:
        return None
    return _git(cwd, "remote", "get-url", names.splitlines()[0].strip())


def room_for(cwd: str | None = None) -> str:
    """Room id for a working directory.

    A repo with a remote hashes the remote, which is what makes two clones on
    two machines agree with no configuration. A repo without one falls back to
    hashing its own absolute path: local-only mode, where the room is real but
    nobody else can ever be in it.
    """
    override = os.environ.get(ROOM_ENV, "").strip()
    if override:
        return override
    remote = git_remote(cwd)
    if remote:
        return room_id_from_remote(remote)
    root = repo_root(cwd)
    return "local-" + hashlib.sha256(root.encode()).hexdigest()[:16]


def agent_id() -> str:
    """One MCP server process is one agent session, so a per-process id is
    correct by construction. Claude Code's session id is preferred when it's in
    the environment, because then the hook channel and this channel agree on
    who's talking."""
    for env in (AGENT_ENV, "CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID"):
        value = os.environ.get(env, "").strip()
        if value:
            return value
    return "sess_" + uuid.uuid4().hex[:12]


def human_id(cwd: str | None = None) -> str:
    """The person, from `git config user.email`.

    Only the local part travels. The domain is the employer and it's the same
    for everyone in the room, so it identifies nobody and it's one more thing
    to leak. Falls back to $USER, then to "someone" — a nameless character in
    the world beats no character at all.
    """
    override = os.environ.get(HUMAN_ENV, "").strip()
    if override:
        return override
    email = _git(os.path.abspath(cwd or os.getcwd()), "config", "user.email")
    if email:
        return email.split("@", 1)[0]
    return os.environ.get("USER", "").strip() or "someone"


def build_tools(
    cwd: str | None = None, *,
    conn: RelayConnection | None = None,
    url: str | None = None,
    identity: LocalIdentity | None = None,
) -> Tools:
    """Assemble the tool surface for this working directory.

    `conn` is the seam a test uses to hand `Tools` a connection pointed at an
    in-process relay on an ephemeral port. Without one, a real
    `RelayConnection` is built against `url` (default: `relay_url()`, i.e.
    `$AGENT_PRESENCE_RELAY` or `ws://127.0.0.1:8799`) — it doesn't dial out
    until the first tool call, so building `Tools` never blocks on a relay
    that isn't running yet.
    """
    room, agent, human = room_for(cwd), agent_id(), human_id(cwd)
    if conn is None:
        who = local_identity() if identity is None else identity
        conn = RelayConnection(
            url if url is not None else relay_url(), room, agent, human,
            principal=who.principal, token=who.token, unattended=who.unattended,
        )
    return Tools(conn, room, agent, human)


# -- stdio transport --------------------------------------------------------


async def run_stdio(tools: Tools) -> None:
    """Serve MCP over stdin/stdout until the client closes the stream.

    This is the shape Claude Code launches: one process per session, the
    protocol on stdout, nothing else allowed on stdout.
    """
    from mcp.server.stdio import stdio_server

    server = build_server(tools)
    try:
        async with stdio_server() as (read_stream, write_stream):
            await server.run(
                read_stream, write_stream, server.create_initialization_options()
            )
    finally:
        # The client hanging up is the common way this coroutine ends, and a
        # relay connection outliving the session it was joined for is a leak
        # on the relay's side too — it holds the room open until the TTL.
        await tools._conn.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="agent-presence-mcp",
        description="Serve the agent-presence MCP tools over stdio.",
    )
    parser.add_argument(
        "-C", "--cwd", default=None,
        help="repo to derive room and human from (default: current directory)",
    )
    parser.add_argument(
        "--room", default=None,
        help=f"override the derived room id (env {ROOM_ENV})",
    )
    parser.add_argument(
        "--agent", default=None,
        help=f"override the session id (env {AGENT_ENV})",
    )
    parser.add_argument(
        "--human", default=None,
        help=f"override the name from git config user.email (env {HUMAN_ENV})",
    )
    parser.add_argument(
        "--relay", default=None,
        help=f"relay url to connect to (env {RELAY_ENV}, default {DEFAULT_RELAY_URL})",
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

    # stderr only. stdout is the transport — one stray print there and the
    # client sees a protocol error instead of a tool list.
    logging.basicConfig(
        stream=sys.stderr,
        level=level,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    # Flags win over env, env wins over what git says. Setting the env var is
    # how the flag reaches the derivation helpers, which is also how a nested
    # call sees the same answer.
    for value, env in ((args.room, ROOM_ENV), (args.agent, AGENT_ENV),
                       (args.human, HUMAN_ENV), (args.relay, RELAY_ENV)):
        if value:
            os.environ[env] = value

    tools = build_tools(args.cwd)
    log.info(
        "serving mcp over stdio: room=%s agent=%s human=%s",
        tools.room, tools.agent, tools.human,
    )
    try:
        asyncio.run(run_stdio(tools))
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
