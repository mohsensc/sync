"""The tier a lease was taken at has to reach the room, not just the claimer.

The relay stamps `Claim.priority` and orders every contest by it, and the whole
daemon side of the product renders what the relay pushes. A lease body that
leaves the tier out means the C++ cache never learns it, so `ap-hook` can say
"nora is editing this" and can never say "and she outranks you" — which is the
one thing a blocked agent needs to know to stop retrying.

`_lease_entry` is the shared body of the `lease`, `leases` and `claim_result`
frames, so the tier belongs in it once rather than bolted onto whichever frame
somebody remembered.
"""

from __future__ import annotations

from agent_presence.clock import VirtualClock
from agent_presence.policy import StaticPolicy, build_policy, builtin_layer
from agent_presence.principals import Principal, Roster, hash_token
from agent_presence.relay import Relay

ROOM = "r1"
SARA_TOKEN = "sara-token"


class FakeConn:
    def __init__(self, agent, human, principal=None, token=None, unattended=False):
        self.agent, self.human, self.room = agent, human, None
        self.principal, self.token, self.unattended = principal, token, unattended
        self.sent: list[dict] = []

    def send(self, payload: dict) -> None:
        self.sent.append(payload)


def roster() -> Roster:
    return Roster(
        (Principal("sara", "Sara", 2, 3, hash_token(SARA_TOKEN)),),
        source="<test>",
        present=True,
    )


def relay(**kwargs) -> Relay:
    kwargs.setdefault("roster", roster())
    kwargs.setdefault("policy", StaticPolicy(build_policy([builtin_layer()])))
    return Relay(VirtualClock(0.0), **kwargs)


def region(path: str, symbol: str | None = "sym") -> dict:
    return {"path": path, "symbol": symbol, "lines": None}


def claim(rel, conn, path, symbol="sym", intent="work"):
    return rel.handle(
        conn, {"type": "claim", "region": region(path, symbol), "intent": intent}
    )


def leases_of(conn: FakeConn) -> list[dict]:
    """Every lease body this connection was sent, from any frame that carries
    one. All three shapes go through `_lease_entry`, so all three are here."""
    out = []
    for frame in conn.sent:
        if frame.get("type") == "leases":
            out.extend(frame["leases"])
        elif frame.get("type") == "lease" and frame.get("state") == "held":
            out.append(frame)
        elif frame.get("type") == "claim_result" and frame.get("granted"):
            out.append(frame)
    return out


def test_a_lease_fanout_frame_names_the_holders_tier():
    rel = relay()
    sara = FakeConn("a1", "Sara", principal="sara", token=SARA_TOKEN)
    watcher = FakeConn("a2", "dev")
    rel.join(ROOM, sara)
    rel.join(ROOM, watcher)

    assert claim(rel, sara, "src/pay.py")["granted"] is True

    held = [f for f in watcher.sent
            if f.get("type") == "lease" and f.get("state") == "held"]
    assert held, "the room was never told about the lease"
    assert held[-1]["priority"] == "elevated"


def test_the_join_snapshot_names_each_holders_tier():
    rel = relay()
    sara = FakeConn("a1", "Sara", principal="sara", token=SARA_TOKEN)
    rel.join(ROOM, sara)
    assert claim(rel, sara, "src/pay.py")["granted"] is True

    latecomer = FakeConn("a3", "dev")
    rel.join(ROOM, latecomer)

    snapshot = [f for f in latecomer.sent if f.get("type") == "leases"]
    assert snapshot, "a joiner was told nothing about what the relay holds"
    assert [entry["priority"] for entry in snapshot[-1]["leases"]] == ["elevated"]


def test_a_granted_claim_result_still_names_the_claimers_tier():
    rel = relay()
    sara = FakeConn("a1", "Sara", principal="sara", token=SARA_TOKEN,
                    unattended=True)
    rel.join(ROOM, sara)

    granted = claim(rel, sara, "src/pay.py")
    assert granted["granted"] is True
    assert granted["priority"] == "critical"  # unattended end of sara's band


def test_a_renewal_carries_the_tier_too():
    # Heartbeats republish the lease so the daemon's TTL keeps moving. A renewal
    # that dropped the tier would silently downgrade the holder in every cache
    # in the room ninety seconds into a session.
    rel = relay()
    sara = FakeConn("a1", "Sara", principal="sara", token=SARA_TOKEN)
    watcher = FakeConn("a2", "dev")
    rel.join(ROOM, sara)
    rel.join(ROOM, watcher)
    claim(rel, sara, "src/pay.py")

    rel._clock.advance(30)
    rel.handle(sara, {"type": "heartbeat", "region": region("src/pay.py")})

    renewals = [f for f in watcher.sent
                if f.get("type") == "lease" and f.get("state") == "held"]
    assert len(renewals) >= 2, "the renewal never reached the room"
    assert renewals[-1]["priority"] == "elevated"


def test_every_lease_body_on_the_wire_carries_a_tier():
    # The general form: whatever frame it rides on, a lease body names a tier.
    rel = relay()
    sara = FakeConn("a1", "Sara", principal="sara", token=SARA_TOKEN)
    watcher = FakeConn("a2", "dev")
    rel.join(ROOM, sara)
    rel.join(ROOM, watcher)
    claim(rel, sara, "src/pay.py")
    claim(rel, sara, "src/auth.py")
    rel.join(ROOM, FakeConn("a4", "late"))

    bodies = leases_of(sara) + leases_of(watcher)
    assert bodies, "the scenario produced no lease bodies at all"
    for body in bodies:
        assert "priority" in body, f"no tier on {body}"


def test_an_unrostered_holder_reads_as_normal_rather_than_absent():
    # The no-roster case is the common one and it must still name a tier, or
    # every reader needs a special case for "the field is missing".
    rel = relay(roster=Roster.inert())
    plain = FakeConn("a1", "dev")
    watcher = FakeConn("a2", "other")
    rel.join(ROOM, plain)
    rel.join(ROOM, watcher)
    claim(rel, plain, "src/pay.py")

    held = [f for f in watcher.sent
            if f.get("type") == "lease" and f.get("state") == "held"]
    assert held[-1]["priority"] == "normal"
