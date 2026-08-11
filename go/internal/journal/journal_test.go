package journal

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

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
	j := New(path)
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
	j := New(path)
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
	j := New(path)
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

func TestStopClosesCleanly(t *testing.T) {
	path := filepath.Join(t.TempDir(), "journal.jsonl")
	j := New(path)
	j.Record(Record{Rung: 3, Path: "a.py"})
	waitFor(t, 2*time.Second, func() bool { return j.Written() == 1 })
	j.Stop() // must return, not hang
}

func TestEmptyPathNeverWrites(t *testing.T) {
	j := New("")
	defer j.Stop()
	j.Record(Record{Rung: 3, Path: "a.py"})
	time.Sleep(50 * time.Millisecond)
	if j.Written() != 0 {
		t.Fatal("an empty path must never write")
	}
}
