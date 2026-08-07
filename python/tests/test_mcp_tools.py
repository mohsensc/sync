import json

import pytest

from agent_presence.clock import VirtualClock
from agent_presence.mcp_server import Tools, build_server, dispatch, tool_descriptors
from agent_presence.relay import Relay


class FakeConn:
    def __init__(self, agent, human):
        self.agent, self.human, self.room, self.sent = agent, human, None, []

    def send(self, payload):
        self.sent.append(payload)


@pytest.fixture
def setup():
    relay = Relay(VirtualClock(1000.0))
    a1 = FakeConn("a1", "sara")
    relay.join("r1", a1)
    return relay, Tools(relay, "r1", "a2", "dev")


def test_who_else_is_here_is_empty_when_alone(setup):
    _, tools = setup
    assert tools.who_else_is_here() == []


def test_who_else_is_here_reports_other_agents(setup):
    relay, tools = setup
    relay.handle(relay._members["r1"][0], {
        "type": "event", "verb": "edit", "source": "hook",
        "region": {"path": "src/auth.py", "symbol": "sign_in", "lines": None},
    })
    peers = tools.who_else_is_here()
    assert peers[0]["human"] == "sara"
    assert peers[0]["path"] == "src/auth.py"


def test_claim_work_grants_an_uncontested_region(setup):
    _, tools = setup
    assert tools.claim_work("src/db.py", "query", "add index")["granted"]


def test_claim_work_is_refused_and_names_the_holder(setup):
    relay, tools = setup
    relay.registry.acquire("r1", "sara", "a1",
                           __import__("agent_presence.types", fromlist=["Region"])
                           .Region(path="src/db.py", symbol="query", lines=None),
                           "rewriting query")
    result = tools.claim_work("src/db.py", "query", "add index")
    assert not result["granted"]
    assert result["held_by"] == "a1"
    assert result["intent"] == "rewriting query"


def test_release_frees_the_region_for_others(setup):
    relay, tools = setup
    tools.claim_work("src/db.py", "query", "add index")
    tools.release("src/db.py", "query")
    assert relay.registry.holder_of("r1", __import__(
        "agent_presence.types", fromlist=["Region"]
    ).Region(path="src/db.py", symbol="query", lines=None)) is None


def test_respond_rejects_an_invented_move(setup):
    _, tools = setup
    with pytest.raises(ValueError):
        tools.respond("src/db.py", "query", "ARGUE")


def test_proceed_is_always_granted_and_flagged_as_an_override(setup):
    relay, tools = setup
    from agent_presence.types import Region
    relay.registry.acquire("r1", "sara", "a1",
                           Region(path="src/db.py", symbol="query", lines=None), "x")
    result = tools.respond("src/db.py", "query", "PROCEED", reason="unrelated")
    assert result["granted"]
    assert result["override"]


def test_exactly_four_tools_are_exposed():
    assert [d["name"] for d in tool_descriptors()] == [
        "who_else_is_here", "claim_work", "release", "respond",
    ]


def test_dispatch_routes_to_the_named_tool(setup):
    _, tools = setup
    assert dispatch(tools, "claim_work", {
        "path": "src/db.py", "symbol": "query", "intent": "add index",
    })["granted"]


def test_dispatch_rejects_an_unknown_tool(setup):
    _, tools = setup
    with pytest.raises(KeyError):
        dispatch(tools, "delete_everything", {})


async def test_the_mcp_server_lists_and_calls_the_four_tools(setup):
    from mcp.types import CallToolRequestParams

    _, tools = setup
    server = build_server(tools)

    listed = await server.get_request_handler("tools/list").handler(None, None)
    assert [t.name for t in listed.tools] == [
        "who_else_is_here", "claim_work", "release", "respond",
    ]

    call = server.get_request_handler("tools/call").handler
    result = await call(None, CallToolRequestParams(
        name="claim_work",
        arguments={"path": "src/db.py", "symbol": "query", "intent": "add index"},
    ))
    assert json.loads(result.content[0].text) == {"granted": True}
