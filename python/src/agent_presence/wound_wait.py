from __future__ import annotations

from typing import Literal

from .types import Claim

Decision = Literal["wait", "abort"]


def resolve(requester_agent: str, requester_acquired_at: float, holder: Claim) -> Decision:
    """Wound-wait. The older transaction always wins.

    - Requester older than holder  -> ``wait``  (it is entitled to the resource)
    - Requester younger            -> ``abort`` (release everything, retry with backoff)

    Exact ties break on agent id so the relation is never symmetric. Symmetry is
    exactly what would permit a wait-cycle, so this makes deadlock unreachable
    rather than merely unlikely — no cycle detection is needed anywhere.
    """
    if requester_acquired_at < holder.acquired_at:
        return "wait"
    if requester_acquired_at > holder.acquired_at:
        return "abort"
    return "wait" if requester_agent < holder.agent else "abort"
