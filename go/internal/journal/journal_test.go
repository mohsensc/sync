package journal

import (
	"bufio"
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/mohsensc/sync/go/internal/metrics"
)

// counterValue reads back one no-label counter's current value straight
// from the registry's own Gatherer — the same forwarding path
// metrics.Registry.Gatherer's doc comment describes, used here instead of
// prometheus/client_golang/prometheus/testutil so this package's tests
// don't reach for a dependency go.mod hasn't already resolved.
func counterValue(t *testing.T, m *metrics.Registry, name string) float64 {
	t.Helper()
	families, err := m.Gatherer().Gather()
	if err != nil {
		t.Fatalf("gather: %v", err)
	}
	for _, fam := range families {
		if fam.GetName() != name {
			continue
		}
		for _, metric := range fam.GetMetric() {
			return metric.GetCounter().GetValue()
		}
	}
	return 0
}

func readLines(t *testing.T, path string) []Record {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		t.Fatal(err)
	}
	defer f.Close()
	var out []Record
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		var r Record
		if err := json.Unmarshal(sc.Bytes(), &r); err != nil {
			t.Fatalf("torn or invalid line: %q: %v", sc.Text(), err)
		}
		out = append(out, r)
	}
	return out
}

func waitFor(t *testing.T, timeout time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		if cond() {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("condition never became true")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestRecordWritesOnlyRungAboveZero(t *testing.T) {
	path := filepath.Join(t.TempDir(), "journal.jsonl")
	j := New(path, nil)
	defer j.Stop()

	j.Record(Record{Rung: 0, Path: "should-not-appear.py"})
	j.Record(Record{Rung: 3, Path: "a.py", Effect: "deny"})
	j.Record(Record{Rung: -1, Path: "should-not-appear-either.py"})

	waitFor(t, 2*time.Second, func() bool { return j.Written() == 1 })

	lines := readLines(t, path)
	if len(lines) != 1 || lines[0].Path != "a.py" {
		t.Fatalf("got %+v", lines)
	}
}

func TestRecordFieldsRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "journal.jsonl")
	j := New(path, nil)
	defer j.Stop()

	j.Record(Record{
		AtMs: 1234, Rung: 3, Effect: "deny", Path: "src/auth.py", Agent: "sess1",
		Holder: "other", Human: "sara", Intent: "refactor", Reason: "effect deny from org",
	})
	waitFor(t, 2*time.Second, func() bool { return j.Written() == 1 })

	lines := readLines(t, path)
	if len(lines) != 1 {
		t.Fatalf("got %d lines", len(lines))
	}
	got := lines[0]
	want := Record{
		AtMs: 1234, Rung: 3, Effect: "deny", Path: "src/auth.py", Agent: "sess1",
		Holder: "other", Human: "sara", Intent: "refactor", Reason: "effect deny from org",
	}
	if got != want {
		t.Fatalf("got %+v\nwant %+v", got, want)
	}
}

func TestTrimKeepsMostRecentAndRewritesFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "journal.jsonl")
	j := New(path, nil)
	defer j.Stop()

	total := MaxLines + 50
	for i := 0; i < total; i++ {
		j.Record(Record{Rung: 3, Path: "a.py", AtMs: int64(i)})
	}
	waitFor(t, 5*time.Second, func() bool { return j.Written() == uint64(total) })

	// The trim runs on a 100ms tick; give it a couple of ticks to fire
	// once written() has caught up.
	waitFor(t, 3*time.Second, func() bool {
		lines := readLines(t, path)
		return len(lines) <= KeepLines
	})

	lines := readLines(t, path)
	if len(lines) != KeepLines {
		t.Fatalf("got %d lines, want %d", len(lines), KeepLines)
	}
	// The kept lines are the most recent ones written.
	first := lines[0].AtMs
	last := lines[len(lines)-1].AtMs
	if last != int64(total-1) {
		t.Fatalf("last kept record has AtMs %d, want %d (the newest)", last, total-1)
	}
	if first != int64(total-KeepLines) {
		t.Fatalf("first kept record has AtMs %d, want %d", first, total-KeepLines)
	}
	if j.Scans() == 0 {
		t.Fatal("expected at least one trim scan")
	}
}

// TestNewOverExistingFileTrims is the case #110 shipped without: a fresh
// process's New() opens a path that already holds more than MaxLines
// records from a previous run. Without seeding the counter from what's
// already there, this process's own lines starts at 0 and would have to
// write MaxLines more records itself before ever trimming — exactly the
// restart-doesn't-trim bug.
func TestNewOverExistingFileTrims(t *testing.T) {
	path := filepath.Join(t.TempDir(), "journal.jsonl")

	var buf bytes.Buffer
	total := MaxLines + 50
	for i := 0; i < total; i++ {
		line, err := json.Marshal(Record{Rung: 3, Path: "a.py", AtMs: int64(i)})
		if err != nil {
			t.Fatal(err)
		}
		buf.Write(line)
		buf.WriteByte('\n')
	}
	if err := os.WriteFile(path, buf.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}

	j := New(path, nil)
	defer j.Stop()

	// No new records at all: seeding plus the existing file is the whole
	// trigger, nothing this process writes matters here.
	waitFor(t, 3*time.Second, func() bool {
		lines := readLines(t, path)
		return len(lines) <= KeepLines
	})

	lines := readLines(t, path)
	if len(lines) != KeepLines {
		t.Fatalf("got %d lines, want %d", len(lines), KeepLines)
	}
	last := lines[len(lines)-1].AtMs
	if last != int64(total-1) {
		t.Fatalf("last kept record has AtMs %d, want %d (the newest)", last, total-1)
	}
}

// TestRestartAccumulationStaysBounded is issue #110's own repro, run to a
// bound instead of just observed: many short-lived Journals writing to the
// same path in turn, the way a restart-heavy daemon does. Each process's
// own write count never nears MaxLines, so only seeding-from-file keeps the
// file from growing without limit across the run.
func TestRestartAccumulationStaysBounded(t *testing.T) {
	path := filepath.Join(t.TempDir(), "journal.jsonl")

	const restarts = 12
	const perRestart = 500 // matches wave4-findings' repro: 12 x 500 = 6000, well past MaxLines
	for i := 0; i < restarts; i++ {
		j := New(path, nil)
		for k := 0; k < perRestart; k++ {
			j.Record(Record{Rung: 3, Path: "a.py", AtMs: int64(i*perRestart + k)})
		}
		waitFor(t, 3*time.Second, func() bool { return j.Written() == uint64(perRestart) })
		// Give the 100ms trim tick a chance to run before this process
		// exits — a restart this short-lived is exactly the case seeding
		// exists for, but the trim itself still only happens on a tick.
		time.Sleep(150 * time.Millisecond)
		j.Stop()
	}

	lines := readLines(t, path)
	if len(lines) > MaxLines {
		t.Fatalf("file has %d lines after %d restarts, want <= %d (unbounded growth across restarts)", len(lines), restarts, MaxLines)
	}
	last := lines[len(lines)-1].AtMs
	if want := int64(restarts*perRestart - 1); last != want {
		t.Fatalf("last kept record has AtMs %d, want %d (the newest)", last, want)
	}
}

func TestStopClosesCleanly(t *testing.T) {
	path := filepath.Join(t.TempDir(), "journal.jsonl")
	j := New(path, nil)
	j.Record(Record{Rung: 3, Path: "a.py"})
	waitFor(t, 2*time.Second, func() bool { return j.Written() == 1 })
	j.Stop() // must return, not hang
}

// TestStopDrainsBufferedRecords is #115: run()'s select gives j.stop and
// j.recs equal priority, so Stop() could return with records Record() had
// already accepted still sitting unwritten in the channel. Built by hand
// rather than through New so every record is queued before the owning
// goroutine's first select — the same race the bug needs, forced instead of
// hoped for — and Stop is called immediately after starting it, before the
// goroutine has any chance to drain on its own.
func TestStopDrainsBufferedRecords(t *testing.T) {
	path := filepath.Join(t.TempDir(), "journal.jsonl")

	j := &Journal{
		path: path,
		recs: make(chan Record, 4096),
		stop: make(chan struct{}),
		done: make(chan struct{}),
	}

	const n = 50
	for i := 0; i < n; i++ {
		j.recs <- Record{Rung: 3, Path: "a.py", AtMs: int64(i)}
	}

	go j.run()
	j.Stop()

	lines := readLines(t, path)
	if len(lines) != n {
		t.Fatalf("got %d lines after Stop, want %d (buffered records dropped on stop)", len(lines), n)
	}
	for i, r := range lines {
		if r.AtMs != int64(i) {
			t.Fatalf("record %d has AtMs %d, want %d (drain order)", i, r.AtMs, i)
		}
	}
}

func TestEmptyPathNeverWrites(t *testing.T) {
	j := New("", nil)
	defer j.Stop()
	j.Record(Record{Rung: 3, Path: "a.py"})
	time.Sleep(50 * time.Millisecond)
	if j.Written() != 0 {
		t.Fatal("an empty path must never write")
	}
}

// TestWritesAndTrimsReachTheRegistry is the wiring check for
// ap_journal_writes_total and ap_journal_trims_total: not just that the
// journal's own counters move (TestTrimKeepsMostRecentAndRewritesFile
// already covers that), but that a caller-supplied Registry sees the same
// events. Passing nil elsewhere in this file is what proves the nil case
// costs nothing; this one proves the non-nil case actually reports.
func TestWritesAndTrimsReachTheRegistry(t *testing.T) {
	path := filepath.Join(t.TempDir(), "journal.jsonl")
	m := metrics.New()
	j := New(path, m)
	defer j.Stop()

	total := MaxLines + 50
	for i := 0; i < total; i++ {
		j.Record(Record{Rung: 3, Path: "a.py", AtMs: int64(i)})
	}
	waitFor(t, 5*time.Second, func() bool { return j.Written() == uint64(total) })
	if got := counterValue(t, m, "ap_journal_writes_total"); got != float64(total) {
		t.Fatalf("ap_journal_writes_total = %v, want %d", got, total)
	}

	// The write burst above is what TestTrimKeepsMostRecentAndRewritesFile
	// uses to force a trim; wait for this registry to see the same thing
	// rather than re-deriving the trigger.
	waitFor(t, 5*time.Second, func() bool { return counterValue(t, m, "ap_journal_trims_total") > 0 })
}
