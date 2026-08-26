package coalesce

import "testing"

func TestAdmitFirstOccurrence(t *testing.T) {
	c := New(1000, 200)
	if !c.Admit(Ev{Verb: "edit", Path: "a.py", Agent: "x"}, 0) {
		t.Fatal("first sighting must be admitted")
	}
}

func TestAdmitSuppressesRepeatWithinWindow(t *testing.T) {
	c := New(1000, 200)
	c.Admit(Ev{Verb: "edit", Path: "a.py", Agent: "x"}, 0)
	if c.Admit(Ev{Verb: "edit", Path: "a.py", Agent: "x"}, 500) {
		t.Fatal("a repeat inside the window must be suppressed")
	}
}

func TestAdmitAllowsAgainAfterWindow(t *testing.T) {
	c := New(1000, 200)
	c.Admit(Ev{Verb: "edit", Path: "a.py", Agent: "x"}, 0)
	if !c.Admit(Ev{Verb: "edit", Path: "a.py", Agent: "x"}, 1000) {
		t.Fatal("must admit again once the window has fully elapsed")
	}
}

func TestAdmitCapsPerWindow(t *testing.T) {
	c := New(1000, 2)
	if !c.Admit(Ev{Path: "a.py", Verb: "edit", Agent: "x"}, 0) {
		t.Fatal("1st must be admitted")
	}
	if !c.Admit(Ev{Path: "b.py", Verb: "edit", Agent: "x"}, 0) {
		t.Fatal("2nd must be admitted")
	}
	if c.Admit(Ev{Path: "c.py", Verb: "edit", Agent: "x"}, 0) {
		t.Fatal("3rd must be dropped: over the per-window cap")
	}
	if c.Dropped() != 1 {
		t.Fatalf("got %d dropped", c.Dropped())
	}
}

func TestAdmitDistinctKeysDoNotSuppressEachOther(t *testing.T) {
	c := New(1000, 200)
	c.Admit(Ev{Path: "a.py", Verb: "edit", Agent: "x"}, 0)
	if !c.Admit(Ev{Path: "a.py", Verb: "read", Agent: "x"}, 0) {
		t.Fatal("a different verb on the same path is a different key")
	}
	if !c.Admit(Ev{Path: "a.py", Verb: "edit", Agent: "y"}, 0) {
		t.Fatal("a different agent on the same path is a different key")
	}
}

// nowMs is wall clock, so it can step backwards — NTP, a VM resync, a
// laptop waking up. The window-roll and per-key checks were both plain
// subtractions, so after a backward step neither could ever be true again
// until real time caught up, and every tracked key stayed suppressed.
// daemon's drainContend discards a frame Admit refuses (the path is
// already off its bounded queue by then), so this ate contend frames.
func TestBackwardClockStepStillRollsTheWindow(t *testing.T) {
	c := New(1000, 100)
	e := Ev{Verb: "edit", Path: "src/a.go", Agent: "a1"}

	if !c.Admit(e, 10_000) {
		t.Fatal("first admit should pass")
	}
	if c.Admit(e, 10_500) {
		t.Fatal("a repeat inside the window should be suppressed")
	}

	// The clock jumps back an hour.
	const stepped = 10_000 - 3_600_000
	if !c.Admit(e, stepped) {
		t.Fatal("after a backward step the window should roll, not stay shut forever")
	}
	// And normal suppression still works on the new side of the step.
	if c.Admit(e, stepped+500) {
		t.Fatal("a repeat inside the rolled window should still be suppressed")
	}
	if !c.Admit(e, stepped+1500) {
		t.Fatal("the next window should admit again")
	}
}

// The per-window cap must also reset across a backward step, or the
// counter stays saturated and drops everything.
func TestBackwardClockStepResetsThePerWindowCap(t *testing.T) {
	c := New(1000, 2)
	for i, path := range []string{"a.go", "b.go"} {
		if !c.Admit(Ev{Verb: "edit", Path: path, Agent: "a1"}, 10_000+int64(i)) {
			t.Fatalf("admit %d should pass, under the cap", i)
		}
	}
	if c.Admit(Ev{Verb: "edit", Path: "c.go", Agent: "a1"}, 10_002) {
		t.Fatal("third in the window should hit the cap")
	}

	const stepped = 10_000 - 3_600_000
	if !c.Admit(Ev{Verb: "edit", Path: "c.go", Agent: "a1"}, stepped) {
		t.Fatal("a backward step should roll the window and reset the cap")
	}
}
