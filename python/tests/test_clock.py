import pytest

from agent_presence.clock import VirtualClock


def test_time_only_moves_when_advanced():
    c = VirtualClock(1000.0)
    assert c.now() == 1000.0
    assert c.now() == 1000.0
    c.advance(0.5)
    assert c.now() == 1000.5


def test_time_cannot_run_backwards():
    c = VirtualClock()
    with pytest.raises(ValueError):
        c.advance(-1)
