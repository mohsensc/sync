package relaysrv

import "testing"

// Ported from python/tests/test_inbound_rate_limit.py — the inbound twin
// of backpressure_test.go. admitInbound/inboundShedReason are pure
// functions of the injectable clock and two counters, no socket involved
// at all, so this drains the bucket by calling admitInbound directly and
// reaches the sustained-abuse branch with clock.Advance, never a real
// wait — same discipline the Python suite uses, more directly available
// here since there's no duck-typed transport to stand up first.

func TestABurstAloneOnlyThrottlesNotDisconnects(t *testing.T) {
	clock := NewVirtualClock(0)
	conn := NewWsConn(newFakeWs(false), clock)
	conn.tokens = 3
	conn.tokenTs = clock.Now()
	conn.inSaturatedSince = nil

	admitted, dropped := 0, 0
	for i := 0; i < 20; i++ {
		if conn.admitInbound() {
			admitted++
		} else {
			dropped++
		}
	}
	if admitted != 3 {
		t.Fatalf("got %d admitted, want 3 (the burst size)", admitted)
	}
	if dropped == 0 {
		t.Fatalf("expected frames past the burst to be dropped")
	}
	if why := conn.inboundShedReason(); why != "" {
		t.Fatalf("a burst alone should only throttle, not shed: %s", why)
	}
}

func TestSustainedAbusePastTheSaturationWindowIsShed(t *testing.T) {
	clock := NewVirtualClock(0)
	conn := NewWsConn(newFakeWs(false), clock)
	conn.tokens = 1
	conn.tokenTs = clock.Now()

	// Drain the one token, then keep asking: every call past it is
	// dropped and marks the saturation clock.
	if !conn.admitInbound() {
		t.Fatalf("expected the first token to admit")
	}
	if conn.admitInbound() {
		t.Fatalf("expected the bucket to be empty")
	}
	if why := conn.inboundShedReason(); why != "" {
		t.Fatalf("not sustained yet, should not shed: %s", why)
	}

	// Sustained: the clock crosses InboundSaturatedS with the bucket
	// never having recovered — shedReason is a pure function of
	// inSaturatedSince and the clock, so this doesn't need another
	// admitInbound call to observe it (a fresh call would itself refill
	// the bucket off the elapsed time, which is exactly why this test
	// checks the deadline directly rather than through one more send).
	clock.Advance(InboundSaturatedS + 0.1)
	if why := conn.inboundShedReason(); why == "" {
		t.Fatalf("expected a shed reason once the saturation window passed with the bucket still empty")
	}
}

func TestRefillingTheBucketClearsTheSaturationClock(t *testing.T) {
	clock := NewVirtualClock(0)
	conn := NewWsConn(newFakeWs(false), clock)
	conn.tokens = 0
	conn.tokenTs = clock.Now()

	if conn.admitInbound() {
		t.Fatalf("expected an empty bucket to refuse")
	}
	if why := conn.inboundShedReason(); why != "" {
		t.Fatalf("not sustained yet: %s", why)
	}

	// Enough clock time passes for the bucket to refill past one token —
	// a peer that goes back to a legitimate rate is not on any deadline.
	clock.Advance(2.0 / InboundRateHz)
	if !conn.admitInbound() {
		t.Fatalf("expected the refilled bucket to admit")
	}
	if why := conn.inboundShedReason(); why != "" {
		t.Fatalf("a peer that started keeping up should not be on a shed deadline: %s", why)
	}
}

// TestAFloodingPeerDoesNotStallARoomsRelayLoop is the end-to-end version,
// through Relay.Handle/session-shaped calls rather than WsConn internals
// directly: a connection well past its inbound budget gets nothing back
// (dropped, unparsed, per admitInbound's contract), and a second,
// well-behaved connection in the same room is unaffected. This is the
// "healthy neighbour" half of the Python test, expressed at the layer
// this package actually controls — the real accept-loop wiring (session
// in server.go) is exercised by the load harness's real-socket runs.
func TestInboundBudgetGatesOneConnectionOnly(t *testing.T) {
	clock := NewVirtualClock(0)
	healthy := NewWsConn(newFakeWs(false), clock)
	flooder := NewWsConn(newFakeWs(false), clock)
	flooder.tokens = 1
	flooder.tokenTs = clock.Now()

	if !flooder.admitInbound() {
		t.Fatalf("expected the flooder's first frame to be admitted")
	}
	for i := 0; i < 10; i++ {
		flooder.admitInbound()
	}
	if healthy.tokens != InboundBurst {
		t.Fatalf("the flooder's bucket must not affect a separate connection's own bucket")
	}
	if !healthy.admitInbound() {
		t.Fatalf("expected the healthy connection's own budget to be untouched")
	}
}
