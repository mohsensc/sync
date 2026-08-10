"""The journal format, as the daemon actually writes it.

journal.py is the reader and cpp/daemon/journal.cpp is the writer, and they are
in different languages with no shared schema between them. The line below is a
verbatim copy of one `presenced` produced during the full-chain run, so this
fails the moment either side renames a field or changes a type — which is the
only way the two can drift without anybody noticing, `ap why` having been
carefully written to tolerate everything it does not understand.

Regenerate it by running the chain and copying a line out of
$XDG_RUNTIME_DIR/agent-presence.decisions.jsonl. Do not hand-edit it into
agreement.
"""

from __future__ import annotations

from agent_presence.journal import parse_record, read_journal

# One line, exactly as cpp/daemon/journal.cpp emitted it.
FROM_THE_DAEMON = (
    '{"at_ms":1786242072528,"rung":3,"effect":"deny",'
    '"path":"/tmp/shop/src/pay.py","agent":"sess-mira",'
    '"holder":"sess-sara","human":"sara","intent":"hotfixing the outage",'
    '"reason":"effect deny from the builtin table; '
    'the holder took it at critical"}'
)


def test_every_field_the_daemon_writes_is_a_field_the_reader_keeps():
    record = parse_record(FROM_THE_DAEMON)
    assert record is not None
    assert record.at_ms == 1786242072528
    assert record.rung == 3
    assert record.effect == "deny"
    assert record.path == "/tmp/shop/src/pay.py"
    assert record.agent == "sess-mira"
    assert record.holder == "sess-sara"
    assert record.human == "sara"
    assert record.intent == "hotfixing the outage"
    assert record.reason.startswith("effect deny from the builtin table")
    assert "critical" in record.reason


def test_the_reader_round_trips_what_the_writer_produced(tmp_path):
    path = tmp_path / "agent-presence.decisions.jsonl"
    path.write_text(FROM_THE_DAEMON + "\n")
    records = read_journal(path)
    assert len(records) == 1
    assert records[0].as_dict()["reason"]


def test_a_record_with_no_reason_is_still_readable():
    # The writer only omits it if something went very wrong, but `ap why`
    # printing a traceback because a field was missing would be worse than the
    # missing field.
    thin = '{"at_ms":1,"rung":3,"effect":"deny","path":"/x.py"}'
    record = parse_record(thin)
    assert record is not None
    assert record.reason == ""
    assert record.holder == ""
