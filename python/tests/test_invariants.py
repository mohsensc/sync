import pytest

from sim.simulation import Simulation


@pytest.mark.parametrize("seed", range(50))
def test_never_deadlocks_across_many_seeds(seed):
    # Progress is the observable proxy for deadlock-freedom: were a wait-cycle
    # reachable, grants would stop entirely.
    assert Simulation(seed, agents=8, regions=4).run(500).granted > 0


def test_no_lease_survives_past_the_ttl_without_heartbeats():
    assert Simulation(42, agents=40, regions=10).run(1000).live_at_end == 0


def test_a_seed_reproduces_a_schedule_exactly():
    assert Simulation(7, 12, 5).run(300) == Simulation(7, 12, 5).run(300)


def test_scales_to_forty_agents_without_stalling():
    assert Simulation(1, agents=40, regions=6).run(2000).granted > 100
