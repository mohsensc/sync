package main

import "testing"

// envPort used to print and os.Exit(2) from inside the --port flag's
// default expression, which runs before flag.Parse. So a malformed
// AGENT_SYNC_PORT killed the process before the explicit --port that
// was there to override it was ever read.
func TestEnvPortReportsInsteadOfExiting(t *testing.T) {
	t.Setenv("AGENT_SYNC_PORT", "abc")
	n, set, err := envPort("AGENT_SYNC_PORT")
	if err == nil {
		t.Fatal("a non-integer port should be an error")
	}
	if !set {
		t.Fatal("the variable is set, even though its value is bad")
	}
	if n != 0 {
		t.Fatalf("no usable port should come back, got %d", n)
	}
}

func TestEnvPortUnsetIsNotAnError(t *testing.T) {
	t.Setenv("AGENT_SYNC_PORT", "")
	n, set, err := envPort("AGENT_SYNC_PORT")
	if err != nil || set || n != 0 {
		t.Fatalf("unset should be (0, false, nil), got (%d, %v, %v)", n, set, err)
	}
}

func TestEnvPortReadsAGoodValue(t *testing.T) {
	t.Setenv("AGENT_SYNC_PORT", "9123")
	n, set, err := envPort("AGENT_SYNC_PORT")
	if err != nil || !set || n != 9123 {
		t.Fatalf("got (%d, %v, %v), want (9123, true, nil)", n, set, err)
	}
}
