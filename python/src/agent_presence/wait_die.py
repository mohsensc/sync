from __future__ import annotations

from typing import Literal

from .priority import PRIORITY_NORMAL
from .types import Claim

Decision = Literal["wait", "abort"]

OrderKey = tuple[int, float, str]


def order_key(priority: int, acquired_at: float, agent: str) -> OrderKey:
    """The single total order over agents. Smaller is more entitled.

    Priority is negated so that one ``<`` means both "higher tier" and, within
    a tier, "older". There is exactly one comparison in the whole system and
    this is it — every wait-or-die verdict, on every channel, is this tuple
    against that tuple.

    Three components, each totally ordered, agent id last. Agent ids are
    distinct, so ``key(x) == key(y)`` implies ``x == y``: the relation is
    irreflexive, antisymmetric and transitive, which makes it a strict total
    order, which has no cycles. That is why there is no cycle detection
    anywhere in this system, and why adding priority did not need any.
    """
    return (-priority, acquired_at, agent)


def resolve(
    requester_agent: str,
    requester_acquired_at: float,
    holder: Claim,
    requester_priority: int = PRIORITY_NORMAL,
) -> Decision:
    """Wait-die. The more entitled transaction waits, the less entitled dies.

    - Requester ranks above the holder -> ``wait``  (it is entitled to the resource)
    - Requester ranks below            -> ``abort`` (release everything, retry with backoff)

    Entitlement is ``order_key``: tier first, then age, then agent id. With
    every agent at ``PRIORITY_NORMAL`` — which is what happens with no roster —
    the tier component cancels and this is the plain age comparison it has
    always been.

    This is wait-die, not wound-wait, and that is deliberate. Wound-wait would
    have the older requester preempt the holder. Preemption here means taking a
    lease away from an agent that is already mid-edit, which destroys work in
    progress and breaks the fail-open principle the rest of the system is built
    on. Wait-die buys the same guarantee for free: it is equally deadlock-free
    and it never removes a lease from someone actively using it. Priority does
    not change that. A senior requester is told to ``wait`` rather than
    ``abort``, so it keeps its place — it is never handed something another
    agent is still holding.

    What ``wait`` does *not* mean is "wait indefinitely", and it used to. A
    holder renewing every 30 s reset its own expiry forever, so a senior
    requester told to wait waited for as long as the junior kept typing. The
    bound now lives in ``LeaseRegistry``: being told ``wait`` also caps the
    holder's renewals, so the verdict comes with a deadline attached
    (``AcquireResult.handover_at``) and the requester can be told when, not just
    that. Same for ``abort`` — the aborting agent's ask still caps the holder,
    on the longer fair-share grace, which is what stops a junior agent starving
    behind a senior one that never stops working.

    Exact ties break on agent id so the relation is never symmetric. Symmetry is
    exactly what would permit a wait-cycle, so this makes deadlock unreachable
    rather than merely unlikely — no cycle detection is needed anywhere.

    That argument only holds while both sides are ordered on the same quantity.
    ``requester_acquired_at`` is the requester agent's age and ``holder`` is
    ordered on ``holder.acquired_at``, so ``holder.acquired_at`` has to be the
    *holder agent's* age too, not the wall clock of that one lease. The same
    goes for tier: ``requester_priority`` is the requester agent's tier and
    ``holder.priority`` had better be the holder agent's, not whatever tier
    happened to be on the connection when that one lease was taken. See the
    note in ``LeaseRegistry.acquire``, which is what keeps both comparable.
    Order the two sides differently and this function will happily return
    "wait" in both directions.
    """
    mine = order_key(requester_priority, requester_acquired_at, requester_agent)
    theirs = order_key(holder.priority, holder.acquired_at, holder.agent)
    return "wait" if mine < theirs else "abort"
