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
