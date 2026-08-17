package relaysrv

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/mohsensc/sync/go/internal/metrics"
)

// recorder is the Go twin of golden_scenario.py's Recorder: a Conn that
// keeps everything the relay pushes at it, for the exact same two-agent
// contention scenario, driven by the same VirtualClock schedule. See
// docs/relay-parity.md and python/tests/helpers/golden_scenario.py — this
// is the parity oracle that script gives the Python relay, ported so both
// relays answer the identical call sequence and their frames can be diffed
// directly instead of only by inspection.
type recorder struct {
	agent, human, room string
	sent               []Frame
}

func (r *recorder) Agent() string     { return r.agent }
func (r *recorder) SetAgent(a string) { r.agent = a }
func (r *recorder) Human() string     { return r.human }
func (r *recorder) SetHuman(h string) { r.human = h }
func (r *recorder) Room() string      { return r.room }
func (r *recorder) SetRoom(rm string) { r.room = rm }
func (r *recorder) Principal() string { return "" }
func (r *recorder) Token() string     { return "" }
func (r *recorder) Unattended() bool  { return false }

// Send decodes the wire bytes Relay.Broadcast/PublishTo hand it back into
// a Frame, so this stays a faithful stand-in for a real connection (which
// only ever sees bytes) while keeping the test assertions below able to
// index into it like everything else here does.
func (r *recorder) Send(b []byte) {
	var f Frame
	if err := json.Unmarshal(b, &f); err != nil {
		panic(err)
	}
	r.sent = append(r.sent, f)
}

func goldenRegion(path string, symbol string) map[string]any {
	return map[string]any{"path": path, "symbol": symbol, "lines": nil}
}

// runGolden replays python's golden_scenario.run() move for move against
// the Go relay and returns the same shape: replies (in order), and what
// each of the two recorders received.
func runGolden() map[string]any {
	clock := NewVirtualClock(1000.0)
	relay := NewRelay(clock, InertRoster(), metrics.New())
	a := &recorder{agent: "a1", human: "sara"}
	b := &recorder{agent: "a2", human: "dev"}

	var replies []Frame

	relay.Join("golden", a)
	clock.Advance(1.0)
	relay.Join("golden", b)

	replies = append(replies, relay.Handle(a, map[string]any{
		"type": "claim", "region": goldenRegion("src/auth.py", "sym"), "intent": "refactor",
	}))
	clock.Advance(1.0)
	replies = append(replies, relay.Handle(b, map[string]any{
		"type": "claim", "region": goldenRegion("src/auth.py", "sym"), "intent": "rename",
	}))

	replies = append(replies, relay.Handle(b, map[string]any{
		"type": "event", "verb": "read", "region": goldenRegion("src/db.py", "query"),
	}))
	replies = append(replies, relay.Handle(a, map[string]any{
		"type": "event", "verb": "edit", "region": goldenRegion("src/db.py", "insert"),
	}))
	replies = append(replies, relay.Handle(b, map[string]any{
		"type": "event", "verb": "edit", "region": goldenRegion("src/db.py", "query"),
	}))
	replies = append(replies, relay.Handle(a, map[string]any{
		"type": "claim", "region": goldenRegion("src/pay.py", "charge"), "intent": "fix rounding",
	}))
	replies = append(replies, relay.Handle(a, map[string]any{
		"type": "event", "verb": "edit", "region": goldenRegion("src/pay.py", "charge"),
	}))
	replies = append(replies, relay.Handle(b, map[string]any{
		"type": "event", "verb": "edit", "region": goldenRegion("src/pay.py", "charge"),
	}))

	replies = append(replies, relay.Handle(a, map[string]any{
		"type": "release", "region": goldenRegion("src/auth.py", "sym"),
	}))

	var kept []Frame
	for _, r := range replies {
		if r != nil {
			kept = append(kept, r)
		}
	}
	return map[string]any{
		"replies":     kept,
		"a1_received": a.sent,
		"a2_received": b.sent,
	}
}

// TestGoldenScenarioMatchesPython asserts the same frame shapes the
// docs/relay-parity.md write-up confirmed by diffing this scenario's
// output against python/tests/helpers/golden_scenario.py directly, back
// when both relays existed: zero differences. The org policy floor is
// ported now (policy.go), so `effect`/`effect_source` are on every frame
// that carries them here too — this scenario runs with no org policy file
// configured, so those resolve to the builtin table on both sides and
// there is nothing left to normalize away. That diff was run by hand once
// against a live checkout of `main`; this is the pinned regression
// version of it, so a change to the ladder, wait-die or handover logic
// that would have moved that diff fails a test instead of needing a
// human to re-run it.
func TestGoldenScenarioMatchesPython(t *testing.T) {
	out := runGolden()

	replies := out["replies"].([]Frame)
	if len(replies) != 8 {
		t.Fatalf("expected 8 replies (claim, claim, ack, ack, ack, claim, ack, negotiate), got %d: %+v", len(replies), replies)
	}
	wantTypes := []string{
		"claim_result", "claim_result", "ack", "ack", "ack",
		"claim_result", "ack", "negotiate",
	}
	for i, want := range wantTypes {
		if got := replies[i]["type"]; got != want {
			t.Errorf("replies[%d].type = %v, want %v", i, got, want)
		}
	}
	// The two rung-0-3 boundary cases the region-parsing bug (see
	// docs/relay-parity.md) got wrong: a first, uncontested touch of a path
	// is rung 0, and a same-path-different-symbol write against a prior
	// write on that path is rung 2, not 3.
	if got := replies[3]["rung"]; got != 0 {
		t.Errorf("replies[3] (a's first touch of db.py) rung = %v, want 0", got)
	}
	if got := replies[4]["rung"]; got != 2 {
		t.Errorf("replies[4] (b edits db.py:query against a's db.py:insert) rung = %v, want 2", got)
	}
	if got := replies[6]["rung"]; got != 0 {
		t.Errorf("replies[6] (a's first touch of pay.py) rung = %v, want 0", got)
	}
	if !replies[0]["granted"].(bool) {
		t.Errorf("replies[0] (a's claim on auth.py) should be granted")
	}
	if replies[1]["granted"].(bool) {
		t.Errorf("replies[1] (b's claim on a's auth.py) should be refused")
	}
	if got := replies[1]["decision"]; got != "abort" {
		t.Errorf("replies[1].decision = %v, want abort (b is younger)", got)
	}
	if got := replies[7]["decision"]; got != "abort" {
		t.Errorf("replies[7] (b's negotiate brief on pay.py) decision = %v, want abort", got)
	}

	// Optional: dump to disk for a manual diff against a live Python
	// checkout's golden_scenario.py output (see docs/relay-parity.md).
	// Not written by default — this is a regression test, not a fixture
	// generator, so a normal `go test` run leaves no file behind to go
	// stale.
	if path := os.Getenv("GOLDEN_DUMP_PATH"); path != "" {
		b, err := json.MarshalIndent(out, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
}
