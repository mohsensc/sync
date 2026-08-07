from agent_presence.ladder import Activity, classify, interrupts_at
from agent_presence.types import AgentEvent, Region

FILE = "src/auth.py"


def ev(verb, symbol):
    return AgentEvent(
        room="r1", human="dev", agent="a2", kind="touch", source="hook",
        verb=verb, region=Region(path=FILE, symbol=symbol, lines=None),
    )


def other(verb, symbol, intent=""):
    return Activity(
        agent="a1", human="sara", verb=verb,
        region=Region(path=FILE, symbol=symbol, lines=None), intent=intent,
    )


def test_rung_0_both_reading():
    assert classify(ev("read", "sign_in"), [other("read", "sign_in")]) == 0


def test_rung_1_other_edits_while_this_one_reads():
    assert classify(ev("read", "sign_in"), [other("edit", "sign_in")]) == 1


def test_rung_2_both_edit_same_file_different_symbols():
    assert classify(ev("edit", "sign_out"), [other("edit", "sign_in")]) == 2


def test_rung_3_both_edit_the_same_symbol():
    assert classify(ev("edit", "sign_in"), [other("edit", "sign_in")]) == 3


def test_rung_0_when_alone():
    assert classify(ev("edit", "sign_in"), []) == 0


def test_activity_in_other_files_is_ignored():
    elsewhere = Activity(
        agent="a1", human="sara", verb="edit",
        region=Region(path="src/db.py", symbol="query", lines=None), intent="",
    )
    assert classify(ev("edit", "sign_in"), [elsewhere]) == 0


def test_an_agent_never_collides_with_itself():
    mine = Activity(
        agent="a2", human="dev", verb="edit",
        region=Region(path=FILE, symbol="sign_in", lines=None), intent="",
    )
    assert classify(ev("edit", "sign_in"), [mine]) == 0


def test_highest_rung_wins_across_many_others():
    others = [other("read", "sign_in"), other("edit", "sign_in")]
    assert classify(ev("edit", "sign_in"), others) == 3


def test_rungs_0_through_2_never_interrupt():
    assert [interrupts_at(r) for r in range(5)] == [False, False, False, True, True]
