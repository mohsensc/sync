package contend

import "testing"

func TestDrainReturnsEverythingAndClears(t *testing.T) {
	q := New()
	q.Note("a.py")
	q.Note("b.py")
	got := q.Drain()
	if len(got) != 2 {
		t.Fatalf("got %v", got)
	}
	if len(q.Drain()) != 0 {
		t.Fatal("drain must be empty after a drain")
	}
}

func TestNoteCollapsesRepeats(t *testing.T) {
	q := New()
	q.Note("a.py")
	q.Note("a.py")
	q.Note("a.py")
	if got := q.Drain(); len(got) != 1 {
		t.Fatalf("got %v, want one entry", got)
	}
}

func TestNoteIgnoresEmptyPath(t *testing.T) {
	q := New()
	q.Note("")
	if got := q.Drain(); len(got) != 0 {
		t.Fatalf("got %v", got)
	}
}

func TestNoteCapsAtMax(t *testing.T) {
	q := New()
	for i := 0; i < Max+10; i++ {
		q.Note(string(rune('a')) + string(rune(i)))
	}
	if got := len(q.Drain()); got > Max {
		t.Fatalf("got %d entries, want at most %d", got, Max)
	}
}

func TestDrainResetsDedupSoARepeatedPathCanBeNotedAgainNextRound(t *testing.T) {
	q := New()
	q.Note("a.py")
	q.Drain()
	q.Note("a.py")
	if got := q.Drain(); len(got) != 1 {
		t.Fatalf("got %v", got)
	}
}
