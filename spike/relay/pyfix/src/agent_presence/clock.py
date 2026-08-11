from __future__ import annotations

import time
from typing import Protocol


class Clock(Protocol):
    def now(self) -> float:
        """Seconds since epoch."""
        ...


class RealClock:
    def now(self) -> float:
        return time.time()


class VirtualClock:
    """Test clock. Every time-dependent behaviour in the system reads through
    a Clock so the whole protocol is testable without real waiting."""

    def __init__(self, epoch: float = 0.0) -> None:
        self._t = epoch

    def now(self) -> float:
        return self._t

    def advance(self, seconds: float) -> None:
        if seconds < 0:
            raise ValueError("VirtualClock cannot move backwards")
        self._t += seconds
