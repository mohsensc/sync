"""An agent id is not a credential, and it used to be one.

`LeaseRegistry.priority_of` is keyed on the agent id alone, and has to be: it is
half of the order key that makes the wait-for relation a strict total order, and
scoping it per room or per connection reintroduces the asymmetry a wait-cycle
needs (see wait_die.py and leases.priority_of). So `acquire` reads an agent's
tier off that agent's live claims.

Which made the agent id the credential. The relay broadcasts it on every
presence frame and hands it out in the join snapshot, and presenced's default is
`presenced@<hostname>`, overridable with one env var. A client with no principal,
no token and no roster entry could declare a rostered principal's agent id, pick
up that principal's `critical` in a room the principal had never been in, beat
strictly older normal-tier agents in wait-die, force them to abort — which drops
their live leases — and keep the tier after the real principal disconnected, by
then laundering it out of its own claims.

Reproduced over a real websocket in the cycle-2 review. Closed here by binding
the id: while any connection holds an agent id, that id has one grant.
"""

from __future__ import annotations

from agent_presence.clock import VirtualClock
from agent_presence.principals import Principal, Roster, hash_token
from agent_presence.priority import PRIORITY_NAMES
from agent_presence.relay import Relay
from agent_presence.types import Region

TOKEN = "sara-real-token"
AGENT = "presenced@sara-mbp"        # on every presence frame the room sees

CRITICAL = PRIORITY_NAMES["critical"]
NORMAL = PRIORITY_NAMES["normal"]


class FakeConn:
    def __init__(self, agent, human, principal=None, token=None,
                 unattended=False):
        self.agent, self.human, self.room = agent, human, None
        self.principal, self.token, self.unattended = principal, token, unattended
        self.sent: list[dict] = []

    def send(self, payload: dict) -> None:
        self.sent.append(payload)

    def refusal(self) -> dict | None:
        for frame in self.sent:
            if frame.get("type") == "join_refused":
                return frame
        return None


def roster() -> Roster:
    return Roster(
        (Principal(id="sara", display="Sara", attended=CRITICAL,
                   unattended=CRITICAL, token_sha256=hash_token(TOKEN)),),
        present=True, source="<test>",
    )


def relay() -> Relay:
    return Relay(VirtualClock(0.0), roster=roster())


def region(path: str) -> dict:
    return {"path": path, "symbol": "fn", "lines": None}


def claim(rel: Relay, conn: FakeConn, path: str) -> dict:
    return rel.handle(conn, {"type": "claim", "region": region(path),
                             "intent": "work"})


# -- the escalation itself ---------------------------------------------------


def test_reusing_a_principals_agent_id_in_another_room_is_refused():
    rel = relay()
    sara = FakeConn(AGENT, "sara", principal="sara", token=TOKEN)
    assert rel.join("alpha", sara)
    assert claim(rel, sara, "alpha/only.py")["priority"] == "critical"

    # No principal, no token, no roster entry. Only the agent id, learned off a
    # presence frame, and a different room.
    mallory = FakeConn(AGENT, "mallory")
    assert not rel.join("beta", mallory)
    assert mallory.room is None
    assert claim(rel, mallory, "beta/elsewhere.py") is None


def test_the_same_room_variant_is_refused_too():
    # No second room is needed: the join snapshot carries `agent` directly.
    rel = relay()
    sara = FakeConn(AGENT, "sara", principal="sara", token=TOKEN)
    rel.join("alpha", sara)

    mallory = FakeConn(AGENT, "mallory")
    assert not rel.join("alpha", mallory)


def test_an_older_normal_agent_is_not_forced_to_abort_by_a_squatter():
    # The consequence that made this high severity: the escalated attacker beat
    # a strictly older normal-tier agent and the abort destroyed its live lease.
    rel = relay()
    sara = FakeConn(AGENT, "sara", principal="sara", token=TOKEN)
    rel.join("alpha", sara)
    claim(rel, sara, "alpha/only.py")

    bob = FakeConn("presenced@bob-mbp", "bob")
    rel.join("beta", bob)
    assert claim(rel, bob, "beta/shared.py")["granted"]

    mallory = FakeConn(AGENT, "mallory")
    rel.join("beta", mallory)                    # refused

    assert [c.agent for c in rel.registry.active_claims("beta")] == [bob.agent]


def test_the_refusal_says_what_to_do_about_it():
    rel = relay()
    sara = FakeConn(AGENT, "sara", principal="sara", token=TOKEN)
    rel.join("alpha", sara)

    mallory = FakeConn(AGENT, "mallory")
    rel.join("beta", mallory)

    refused = mallory.refusal()
    assert refused is not None, "a refused join must not be silent"
    assert refused["reason"] == "agent-id-taken"
    assert refused["room"] == "beta"
    # Actionable: it names the knob, not just the problem.
    assert "AGENT_PRESENCE_AGENT" in refused["detail"]


def test_a_squatter_cannot_lock_a_principal_out_of_its_own_id():
    # The other direction. If first-come won outright, anyone who could reach
    # the port could deny a rostered principal its own agent id by connecting
    # first. The authenticated principal takes it and the squatter is dropped.
    rel = relay()
    squatter = FakeConn(AGENT, "nobody")
    assert rel.join("beta", squatter)
    assert claim(rel, squatter, "beta/x.py")["granted"]

    sara = FakeConn(AGENT, "sara", principal="sara", token=TOKEN)
    assert rel.join("beta", sara)
    assert squatter.room is None
    # And nothing it laundered survives to be inherited.
    assert rel.registry.active_claims("beta") == []
    assert claim(rel, sara, "beta/y.py")["priority"] == "critical"


def test_two_different_principals_on_one_id_is_refused_not_guessed_at():
    rel = Relay(VirtualClock(0.0), roster=Roster(
        (
            Principal(id="sara", display="Sara", attended=CRITICAL,
                      unattended=CRITICAL, token_sha256=hash_token(TOKEN)),
            Principal(id="kim", display="Kim", attended=CRITICAL,
                      unattended=CRITICAL, token_sha256=hash_token("kim-tok")),
        ),
        present=True, source="<test>",
    ))
    sara = FakeConn(AGENT, "sara", principal="sara", token=TOKEN)
    kim = FakeConn(AGENT, "kim", principal="kim", token="kim-tok")

    assert rel.join("alpha", sara)
    assert not rel.join("alpha", kim)
    assert kim.refusal()["reason"] == "agent-id-taken"


# -- what the binding must not break -----------------------------------------


def test_two_checkouts_on_one_laptop_still_share_an_agent_id():
    # The documented ordinary case: presenced names itself presenced@<hostname>,
    # so two rooms on one machine share an id. Same grant, so both are admitted.
    rel = relay()
    first = FakeConn("presenced@laptop", "sara", principal="sara", token=TOKEN)
    second = FakeConn("presenced@laptop", "sara", principal="sara", token=TOKEN)
    assert rel.join("repo-a", first)
    assert rel.join("repo-b", second)
    assert first.room == "repo-a" and second.room == "repo-b"


def test_two_unauthenticated_connections_may_share_an_id():
    rel = relay()
    a = FakeConn("presenced@laptop", "sara")
    b = FakeConn("presenced@laptop", "sara")
    assert rel.join("repo-a", a)
    assert rel.join("repo-b", b)


def test_the_same_principal_at_two_supervision_levels_is_refused():
    # attended and unattended can be different tiers, and two live connections
    # at two tiers under one id is the same asymmetry by another route.
    rel = Relay(VirtualClock(0.0), roster=Roster(
        (Principal(id="sara", display="Sara", attended=CRITICAL,
                   unattended=NORMAL, token_sha256=hash_token(TOKEN)),),
        present=True, source="<test>",
    ))
    watched = FakeConn(AGENT, "sara", principal="sara", token=TOKEN)
    alone = FakeConn(AGENT, "sara", principal="sara", token=TOKEN,
                     unattended=True)
    assert rel.join("alpha", watched)
    assert not rel.join("beta", alone)


def test_the_id_is_free_again_once_its_holder_hangs_up():
    rel = relay()
    sara = FakeConn(AGENT, "sara", principal="sara", token=TOKEN)
    rel.join("alpha", sara)
    claim(rel, sara, "alpha/only.py")
    rel.leave(sara)

    mallory = FakeConn(AGENT, "mallory")
    assert rel.join("beta", mallory)
    # And it inherits nothing: sara's leases went with her connection, so
    # priority_of has no live claim to read a tier off.
    assert claim(rel, mallory, "beta/elsewhere.py")["priority"] == "normal"


def test_a_connection_can_still_move_rooms():
    rel = relay()
    sara = FakeConn(AGENT, "sara", principal="sara", token=TOKEN)
    assert rel.join("alpha", sara)
    assert rel.join("beta", sara)
    assert sara.room == "beta"


# -- the negative controls the review ran ------------------------------------


def test_a_forged_priority_in_the_body_is_still_ignored():
    rel = relay()
    conn = FakeConn("a1", "dev")
    rel.join("r1", conn)
    reply = rel.handle(conn, {"type": "claim", "region": region("src/a.py"),
                              "intent": "work", "priority": "critical"})
    assert reply["priority"] == "normal"


def test_a_principal_with_no_token_is_still_normal():
    rel = relay()
    conn = FakeConn("a1", "sara", principal="sara")
    rel.join("r1", conn)
    assert claim(rel, conn, "src/a.py")["priority"] == "normal"


def test_a_principal_with_the_wrong_token_is_still_normal():
    rel = relay()
    conn = FakeConn("a1", "sara", principal="sara", token="not-it")
    rel.join("r1", conn)
    assert claim(rel, conn, "src/a.py")["priority"] == "normal"


def test_the_lease_table_still_latches_one_tier_per_agent():
    # The invariant the binding exists to make safe, restated at this level: a
    # grant is per connection, and the tier on an agent's claims is what orders
    # the contest, so those two must be the same thing.
    rel = relay()
    sara = FakeConn(AGENT, "sara", principal="sara", token=TOKEN)
    rel.join("alpha", sara)
    claim(rel, sara, "alpha/one.py")
    claim(rel, sara, "alpha/two.py")

    tiers = {c.priority for c in rel.registry.active_claims("alpha")}
    assert tiers == {CRITICAL}
    assert rel.registry.priority_of(AGENT) == rel.priority_of(sara)


def test_a_squatter_that_already_held_a_region_loses_it_to_the_principal():
    rel = relay()
    squatter = FakeConn(AGENT, "nobody")
    rel.join("beta", squatter)
    claim(rel, squatter, "beta/pay.py")
    contested = Region(path="beta/pay.py", symbol="fn", lines=None)
    assert rel.registry.holder_of("beta", contested) is not None

    sara = FakeConn(AGENT, "sara", principal="sara", token=TOKEN)
    rel.join("beta", sara)
    assert rel.registry.holder_of("beta", contested) is None


# -- the half that outlives the socket ---------------------------------------
#
# Binding an id to one grant covers the ids somebody is holding. A claim can
# outlive the connection that took it: `leave` releases the leases of the room
# the connection was in when it hung up, and a connection that moved rooms
# leaves the first room's leases to age out over a TTL. For that TTL the id is
# unheld and its claims still carry `critical`, and `acquire` reads an agent's
# tier off that agent's live claims.


def strand_saras_claims(rel: Relay) -> None:
    """Sara claims in alpha, moves her connection to beta, then hangs up.

    One daemon switching repos does this. `leave` releases beta, alpha's lease
    is left holding a critical stamp with nobody behind it.
    """
    sara = FakeConn(AGENT, "sara", principal="sara", token=TOKEN)
    assert rel.join("alpha", sara)
    assert claim(rel, sara, "alpha/only.py")["priority"] == "critical"
    assert rel.join("beta", sara)
    rel.leave(sara)
    assert rel.registry.priority_of(AGENT) == CRITICAL, "no stranded claim left"


def test_a_squatter_cannot_inherit_a_tier_from_a_stranded_claim():
    rel = relay()
    strand_saras_claims(rel)

    # No principal, no token, no roster entry, and now no live connection to
    # collide with either — the whole of the attack is knowing the id.
    mallory = FakeConn(AGENT, "mallory")
    assert rel.join("gamma", mallory)
    assert claim(rel, mallory, "gamma/anything.py")["priority"] == "normal"
    assert rel.registry.priority_of(AGENT) == NORMAL


def test_the_stranded_claims_go_rather_than_linger_at_the_old_tier():
    rel = relay()
    strand_saras_claims(rel)

    mallory = FakeConn(AGENT, "mallory")
    rel.join("gamma", mallory)
    assert rel.registry.active_claims("alpha") == [], (
        "a claim nobody holds, at a tier nobody was granted, is what the "
        "squatter was reading the tier off"
    )


def test_a_reconnect_at_the_same_tier_keeps_its_leases():
    # The case worth protecting: a dropped socket, a fresh one, same principal,
    # same tier. Nothing was laundered and nothing should be dropped.
    rel = relay()
    strand_saras_claims(rel)

    again = FakeConn(AGENT, "sara", principal="sara", token=TOKEN)
    assert rel.join("gamma", again)
    assert [c.agent for c in rel.registry.active_claims("alpha")] == [AGENT]
    assert rel.registry.priority_of(AGENT) == CRITICAL


def test_a_teammate_sharing_the_id_keeps_its_leases():
    # Two checkouts on one laptop under the default presenced@<hostname>. One
    # of them holding the id means the claims under it are live work, not
    # leftovers, whichever room they are in.
    rel = relay()
    first = FakeConn(AGENT, "sara", principal="sara", token=TOKEN)
    rel.join("alpha", first)
    claim(rel, first, "alpha/only.py")

    second = FakeConn(AGENT, "sara", principal="sara", token=TOKEN)
    assert rel.join("beta", second)
    assert [c.agent for c in rel.registry.active_claims("alpha")] == [AGENT]
