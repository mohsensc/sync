from __future__ import annotations

from .negotiation import MOVES, Negotiator
from .redact import opaque_region_if_enabled
from .relay import Relay
from .types import Region


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
