package negotiation

import "testing"

func TestNormalizeAcceptsCaseAndWhitespace(t *testing.T) {
	for _, in := range []string{"split", "Split", " SPLIT ", "SPLIT"} {
		if got := Normalize(in); got != "SPLIT" {
			t.Errorf("Normalize(%q) = %q, want SPLIT", in, got)
		}
	}
}

func TestNormalizeRejectsJunk(t *testing.T) {
	for _, in := range []string{"", "   ", "ARGUE", "defer!", "PROCEE"} {
		if got := Normalize(in); got != "" {
			t.Errorf("Normalize(%q) = %q, want \"\"", in, got)
		}
	}
}

func TestMovesOrder(t *testing.T) {
	want := []string{"DEFER", "SPLIT", "HANDOFF", "PROCEED"}
	if len(Moves) != len(want) {
		t.Fatalf("got %v, want %v", Moves, want)
	}
	for i, m := range want {
		if Moves[i] != m {
			t.Fatalf("got %v, want %v", Moves, want)
		}
	}
}
