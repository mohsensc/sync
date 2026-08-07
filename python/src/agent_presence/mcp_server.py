from __future__ import annotations

import argparse
import asyncio
import hashlib
import logging
import os
import subprocess
import sys
import uuid

from .clock import RealClock
from .negotiation import MOVES, Negotiator
from .redact import opaque_region_if_enabled
from .relay import Relay
from .room_key import room_id_from_remote
from .types import Region

log = logging.getLogger("agent_presence.mcp_server")


def _scope(path: str, symbol: str | None) -> Region:
    """Regions from the tool channel have to key the same way regions from the
    hook channel do, or opaque mode would split the lease table in two."""
    return opaque_region_if_enabled(Region(path=path, symbol=symbol, lines=None))


class Tools:
    """The deliberate channel. Hooks report what an agent *did*; these tools
    let it declare what it *intends*, which hooks can never infer."""

    def __init__(self, relay: Relay, room: str, agent: str, human: str) -> None:
        self._relay = relay
        self._room = room
        self._agent = agent
        self._human = human
        self._negotiator = Negotiator(relay.registry, relay._clock)

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

    def who_else_is_here(self) -> list[dict]:
        return [
            {
                "human": a.human,
                "agent": a.agent,
                "verb": a.verb,
                "path": a.region.path,
                "symbol": a.region.symbol,
                "intent": a.intent,
            }
            for a in self._relay.presence(self._room)
            if a.agent != self._agent
        ]

    def claim_work(self, path: str, symbol: str | None, intent: str) -> dict:
        region = _scope(path, symbol)
        result = self._relay.registry.acquire(
            self._room, self._human, self._agent, region, intent
        )
        if result.ok:
            return {"granted": True}

        # Same wait-die handling the wire path does, for the same reason: a
        # refusal with no instruction leaves both agents retrying at each other,
        # and the loser's leases have to actually go or the wait-for cycle
        # survives. Two channels ordering claims differently would be a cycle
        # the relay cannot see.
        if result.decision == "abort":
            self._relay.registry.release_all(self._agent)

        return {
            "granted": False,
            "held_by": result.held_by.agent,
            "held_by_human": result.held_by.human,
            "intent": result.held_by.intent,
            "decision": result.decision,
            "moves": ["DEFER", "SPLIT", "HANDOFF", "PROCEED"],
        }

    def release(self, path: str, symbol: str | None) -> dict:
        self._relay.registry.release(self._room, self._agent, _scope(path, symbol))
        return {"released": True}

    def respond(
        self, path: str, symbol: str | None, move: str, reason: str = ""
    ) -> dict:
        region = _scope(path, symbol)
        outcome = self._negotiator.apply(self._room, self._agent, region, move, reason)
        error = getattr(outcome, "error", None)
        if outcome.action == "invalid_move":
            # Hand the valid options back in the result. That is more
            # actionable than an exception string, and it keeps the MCP
            # surface total: respond never throws. Same fail-open principle
            # the rest of this system runs on.
            return {
                "granted": False,
                "error": f"unknown move: {move}",
                "valid_moves": list(MOVES),
            }
        result = {
            "granted": outcome.granted,
            "action": outcome.action,
            "override": outcome.logged_override,
        }
        if error:
            result["error"] = error
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


def dispatch(tools: Tools, name: str, arguments: dict) -> dict | list:
    """Route a tool call to the matching method. Raises KeyError on an
    unknown tool name. Tool calls themselves never raise: an invented
    negotiation move comes back as a refusal carrying the valid moves."""
    if name == "who_else_is_here":
        return tools.who_else_is_here()
    if name == "claim_work":
        return tools.claim_work(
            arguments["path"], arguments.get("symbol"), arguments["intent"]
        )
    if name == "release":
        return tools.release(arguments["path"], arguments.get("symbol"))
    if name == "respond":
        return tools.respond(
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
        result = dispatch(tools, params.name, params.arguments or {})
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


def build_tools(cwd: str | None = None, relay: Relay | None = None) -> Tools:
    """Assemble the tool surface for this working directory."""
    return Tools(
        relay if relay is not None else Relay(RealClock()),
        room_for(cwd),
        agent_id(),
        human_id(cwd),
    )


# -- stdio transport --------------------------------------------------------


async def run_stdio(tools: Tools) -> None:
    """Serve MCP over stdin/stdout until the client closes the stream.

    This is the shape Claude Code launches: one process per session, the
    protocol on stdout, nothing else allowed on stdout.
    """
    from mcp.server.stdio import stdio_server

    server = build_server(tools)
    async with stdio_server() as (read_stream, write_stream):
        await server.run(
            read_stream, write_stream, server.create_initialization_options()
        )


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
                       (args.human, HUMAN_ENV)):
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
