from __future__ import annotations

from typing import Literal

from .types import Claim

Decision = Literal["wait", "abort"]


def resolve(
    requester_agent: str, requester_acquired_at: float, holder: Claim
) -> Decision:
    """Wait-die. The older transaction waits, the younger one dies.

    - Requester older than holder  -> ``wait``  (it is entitled to the resource)
    - Requester younger            -> ``abort`` (release everything, retry with backoff)

    This is wait-die, not wound-wait, and that is deliberate. Wound-wait would
    have the older requester preempt the holder. Preemption here means taking a
    lease away from an agent that is already mid-edit, which destroys work in
    progress and breaks the fail-open principle the rest of the system is built
    on. Wait-die buys the same guarantee for free: it is equally deadlock-free
    and it never removes a lease from someone actively using it.

    Exact ties break on agent id so the relation is never symmetric. Symmetry is
    exactly what would permit a wait-cycle, so this makes deadlock unreachable
    rather than merely unlikely — no cycle detection is needed anywhere.

    That argument only holds while both sides are ordered on the same quantity.
    ``requester_acquired_at`` is the requester agent's age and ``holder`` is
    ordered on ``holder.acquired_at``, so ``holder.acquired_at`` has to be the
    *holder agent's* age too, not the wall clock of that one lease. See the
    note in ``LeaseRegistry.acquire``, which is what keeps the two comparable.
    Order the two sides differently and this function will happily return
    "wait" in both directions.
    """
    if requester_acquired_at < holder.acquired_at:
        return "wait"
    if requester_acquired_at > holder.acquired_at:
        return "abort"
    return "wait" if requester_agent < holder.agent else "abort"
