package relaysrv

import (
	"testing"
	"time"

	"github.com/mohsensc/sync/go/internal/metrics"
)

// TestOnStatsFoldsAHugeDeltaWithoutSpinning is the denial of service this
// used to be.
//
// The fold applied a daemon's counter delta by calling Inc() in a loop, and
// the loop bound came off the wire. A daemon reporting a large cumulative
// total — a bug, a restart miscount, or a client that joined a room and lied —
// held the relay's goroutine until it had counted that far. Nothing else in
// the room got served in the meantime.
//
// The bound is the subject here, not the value: this test fails by timing
// out, so the deadline stays far below what any loop of this size could
// finish in.
func TestOnStatsFoldsAHugeDeltaWithoutSpinning(t *testing.T) {
	relay := NewRelay(NewVirtualClock(0), InertRoster(), metrics.New())
	conn := newFakeConn("daemon-1", "alice")

	huge := float64(uint64(1) << 62)
	done := make(chan struct{})
	go func() {
		defer close(done)
		relay.onStats(conn, map[string]any{
			"type":                 "stats",
			"reconnects":           huge,
			"journal_writes":       huge,
			"journal_trims":        huge,
			"coalesce_admitted":    huge,
			"coalesce_dropped":     huge,
			"region_keys_relative": huge,
			"region_keys_absolute": huge,
		})
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("onStats did not return — a number off the wire is still bounding a loop")
	}
}

// TestOnStatsAppliesTheDeltaNotTheTotal keeps the Add rewrite honest: folding
// with Add instead of a loop must still fold a *delta*, or a daemon reporting
// the same cumulative total every 30 seconds would ramp every counter forever.
func TestOnStatsAppliesTheDeltaNotTheTotal(t *testing.T) {
	reg := metrics.New()
	relay := NewRelay(NewVirtualClock(0), InertRoster(), reg)
	conn := newFakeConn("daemon-1", "alice")

	report := func(n float64) {
		relay.onStats(conn, map[string]any{
			"type": "stats", "journal_writes": n,
		})
	}
	report(10)
	report(10) // the same total again: nothing new happened
	report(25)

	got := counterValue(t, reg, "ap_journal_writes_total")
	if got != 25 {
		t.Fatalf("ap_journal_writes_total = %v, want 25 (the latest total, folded as deltas)", got)
	}
}

// fakeConn is the smallest thing satisfying Conn: onStats only ever reads
// an identity off it and keys its per-connection baseline by it.
type fakeConn struct {
	agent, human, room string
}

func newFakeConn(agent, human string) *fakeConn {
	return &fakeConn{agent: agent, human: human}
}

func (c *fakeConn) Agent() string     { return c.agent }
func (c *fakeConn) SetAgent(v string) { c.agent = v }
func (c *fakeConn) Human() string     { return c.human }
func (c *fakeConn) SetHuman(v string) { c.human = v }
func (c *fakeConn) Room() string      { return c.room }
func (c *fakeConn) SetRoom(v string)  { c.room = v }
func (c *fakeConn) Principal() string { return "" }
func (c *fakeConn) Token() string     { return "" }
func (c *fakeConn) Unattended() bool  { return false }
func (c *fakeConn) Send([]byte)       {}
