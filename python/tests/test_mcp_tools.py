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


@pytest.fixture(autouse=True)
def _opaque_off(monkeypatch):
    monkeypatch.delenv("AGENT_PRESENCE_OPAQUE", raising=False)


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


def test_respond_refuses_an_invented_move_without_raising(setup):
    _, tools = setup
    result = tools.respond("src/db.py", "query", "ARGUE")
    assert result["granted"] is False
    assert result["valid_moves"] == ["DEFER", "SPLIT", "HANDOFF", "PROCEED"]


def test_proceed_is_always_granted_and_flagged_as_an_override(setup):
    relay, tools = setup
    from agent_presence.types import Region
    relay.registry.acquire("r1", "sara", "a1",
                           Region(path="src/db.py", symbol="query", lines=None), "x")
    result = tools.respond("src/db.py", "query", "PROCEED", reason="unrelated")
    assert result["granted"]
    assert result["override"]


def test_the_invented_move_is_named_in_the_error(setup):
    _, tools = setup
    assert tools.respond("src/db.py", "query", "ARGUE")["error"] == (
        "unknown move: ARGUE"
    )


def test_respond_accepts_moves_case_insensitively(setup):
    relay, tools = setup
    from agent_presence.types import Region
    relay.registry.acquire("r1", "sara", "a1",
                           Region(path="src/db.py", symbol="query", lines=None), "x")
    result = tools.respond("src/db.py", "query", "  proceed  ", reason="unrelated")
    assert result["granted"]
    assert result["action"] == "proceed"
    assert "error" not in result


def test_respond_keeps_the_tool_surface_total_for_every_junk_move(setup):
    _, tools = setup
    for junk in ["", "   ", "ARGUE", "defer!", "PROCEE"]:
        result = tools.respond("src/db.py", "query", junk)
        assert result["granted"] is False
        assert result["valid_moves"] == ["DEFER", "SPLIT", "HANDOFF", "PROCEED"]


def test_dispatch_returns_the_refusal_instead_of_raising_on_a_bad_move(setup):
    _, tools = setup
    result = dispatch(tools, "respond", {
        "path": "src/db.py", "symbol": "query", "move": "ARGUE",
    })
    assert result["granted"] is False
    assert result["valid_moves"] == ["DEFER", "SPLIT", "HANDOFF", "PROCEED"]


def test_opaque_mode_keys_tool_claims_the_way_hook_events_are_keyed(setup, monkeypatch):
    monkeypatch.setenv("AGENT_PRESENCE_OPAQUE", "1")
    from agent_presence.redact import opaque_region
    from agent_presence.types import Region

    relay, tools = setup
    scope = opaque_region(Region(path="src/db.py", symbol="query", lines=None))
    relay.registry.acquire("r1", "sara", "a1", scope, "rewriting query")
    # Same file, so the tool channel must land on the same lease the hook
    # channel took, hashed or not.
    result = tools.claim_work("src/db.py", "query", "add index")
    assert not result["granted"]
    assert result["held_by"] == "a1"


def test_opaque_mode_releases_the_hashed_scope(setup, monkeypatch):
    monkeypatch.setenv("AGENT_PRESENCE_OPAQUE", "1")
    from agent_presence.redact import opaque_region
    from agent_presence.types import Region

    relay, tools = setup
    tools.claim_work("src/db.py", "query", "add index")
    tools.release("src/db.py", "query")
    scope = opaque_region(Region(path="src/db.py", symbol="query", lines=None))
    assert relay.registry.holder_of("r1", scope) is None


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


# -- the tool channel is on the same roster as the wire channel --------------


def _roster():
    from agent_presence.principals import Principal, Roster, hash_token
    from agent_presence.priority import PRIORITY_NAMES

    return Roster(
        (Principal(id="sara", display="Sara",
                   attended=PRIORITY_NAMES["critical"],
                   unattended=PRIORITY_NAMES["critical"],
                   token_sha256=hash_token("s3cret")),),
        present=True, source="<test>",
    )


def test_claim_work_claims_at_the_tier_the_roster_granted():
    # It used to stamp `normal` whatever the roster said, so an exec who put
    # themselves at critical and installed a token won contention through the
    # hook and lost it through the tools, in the same session.
    from agent_presence.principals import LocalIdentity
    from agent_presence.priority import PRIORITY_NAMES, name_of
    from agent_presence.types import Region

    relay = Relay(VirtualClock(1000.0), roster=_roster())
    tools = Tools(relay, "r1", "presenced@exec", "sara",
                  identity=LocalIdentity("sara", "s3cret", unattended=True))
    assert tools.priority == PRIORITY_NAMES["critical"]

    tools.claim_work("src/pay.py", "charge", "hotfix")
    claim = relay.registry.holder_of(
        "r1", Region(path="src/pay.py", symbol="charge", lines=None)
    )
    assert name_of(claim.priority) == "critical"


def test_a_tool_session_with_no_token_is_still_normal():
    from agent_presence.principals import LocalIdentity
    from agent_presence.priority import PRIORITY_NORMAL

    relay = Relay(VirtualClock(1000.0), roster=_roster())
    tools = Tools(relay, "r1", "a2", "dev",
                  identity=LocalIdentity("sara", "", unattended=False))
    assert tools.priority == PRIORITY_NORMAL


def test_a_tool_session_cannot_re_rate_itself_mid_session():
    from agent_presence.principals import LocalIdentity
    from agent_presence.priority import PRIORITY_NAMES

    relay = Relay(VirtualClock(1000.0), roster=_roster())
    tools = Tools(relay, "r1", "a2", "sara",
                  identity=LocalIdentity("sara", "s3cret", unattended=False))
    before = tools.priority
    # No setter exists, and the grant is a frozen dataclass latched at
    # construction. Same rule the relay applies to a join frame.
    with pytest.raises(AttributeError):
        tools.priority = PRIORITY_NAMES["background"]
    assert tools.priority == before


def test_claim_work_refused_by_a_reservation_says_when_to_come_back():
    from agent_presence.leases import HANDOVER_GRACE_S, HEARTBEAT_S
    from agent_presence.priority import PRIORITY_NAMES
    from agent_presence.types import Region

    clock = VirtualClock(1000.0)
    relay = Relay(clock)
    scope = Region(path="src/pay.py", symbol="charge", lines=None)
    tools = Tools(relay, "r1", "a2", "dev")

    # a2 holds it, a1 asks and is queued, a2's deadline fires.
    tools.claim_work("src/pay.py", "charge", "work")
    relay.registry.acquire("r1", "sara", "a1", scope, "hotfix",
                           priority=PRIORITY_NAMES["critical"])
    deadline = 1000.0 + HANDOVER_GRACE_S + 0.5
    while clock.now() < deadline:
        clock.advance(min(HEARTBEAT_S, deadline - clock.now()))
        relay.registry.heartbeat("r1", "a2", scope)

    answer = tools.claim_work("src/pay.py", "charge", "work")
    assert answer["granted"] is False
    assert answer["reserved"] is True
    assert answer["held_by"] == "a1"
    assert answer["retry_in_s"] > 0
    assert answer["moves"] == ["DEFER"]


def test_claim_work_refused_by_a_holder_says_when_the_region_frees_up():
    from agent_presence.priority import PRIORITY_NAMES
    from agent_presence.types import Region

    relay = Relay(VirtualClock(1000.0))
    scope = Region(path="src/pay.py", symbol="charge", lines=None)
    relay.registry.acquire("r1", "dev", "a1", scope, "long refactor")

    tools = Tools(relay, "r1", "a2", "sara")
    answer = tools.claim_work("src/pay.py", "charge", "hotfix")
    assert answer["granted"] is False
    assert answer["held_by"] == "a1"
    assert answer["intent"] == "long refactor"
    # The number that turns DEFER from a shrug into an instruction.
    assert answer["handover_in_s"] > 0
    assert answer["retry_in_s"] == answer["handover_in_s"]
    assert answer["waiting"] == 1
