package relaysrv

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/mohsensc/sync/go/internal/metrics"
)

// Ported from python/tests/test_relay_policy.py's org-floor-and-effect
// wire tests — the line the whole design rests on: policy governs
// presentation, never the lease table.

func orgRelay(t *testing.T, contents string) (*Relay, string, *VirtualClock) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "org.toml")
	if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("AGENT_SYNC_ORG_POLICY", path)
	clock := NewVirtualClock(1000.0)
	return NewRelay(clock, InertRoster(), metrics.New()), path, clock
}

func claimRegion(rel *Relay, conn Conn, path string) Frame {
	return rel.Handle(conn, map[string]any{"type": "claim", "region": goldenRegion(path, ""), "intent": "x"})
}

// floorNames reads a `floor` field back off a frame that went through
// recorder.Send's JSON round trip: a plain []string on the way in decodes
// to []interface{} on the way out, same as any real websocket client sees.
func floorNames(v any) []string {
	list, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]string, len(list))
	for i, e := range list {
		out[i], _ = e.(string)
	}
	return out
}

func TestANotifyRungThreeStillRefusesTheClaim(t *testing.T) {
	rel, _, clock := orgRelay(t, "[effects]\nrung3 = \"notify\"\n")
	a := &recorder{agent: "a1", human: "sara"}
	b := &recorder{agent: "a2", human: "dev"}
	rel.Join("r1", a)
	rel.Join("r1", b)

	granted := claimRegion(rel, a, "src/pay.py")
	if granted["granted"] != true {
		t.Fatalf("expected a's claim granted, got %+v", granted)
	}
	clock.Advance(5)
	refused := claimRegion(rel, b, "src/pay.py")
	if refused["granted"] != false {
		t.Fatalf("policy must never affect the lease grant: got %+v", refused)
	}
	if refused["decision"] != "abort" {
		t.Fatalf("got decision %v, want abort", refused["decision"])
	}
	if refused["effect"] != "notify" {
		t.Fatalf("got effect %v, want notify", refused["effect"])
	}
	if got := rel.registry.HolderOf("r1", Region{Path: "src/pay.py"}, nil); got == nil || got.Agent != "a1" {
		t.Fatalf("lease table must still say a1 holds it, got %+v", got)
	}
}

func TestANotifyRungThreeAnswersAckInsteadOfNegotiate(t *testing.T) {
	rel, _, _ := orgRelay(t, "[effects]\nrung3 = \"notify\"\n")
	a := &recorder{agent: "a1", human: "sara"}
	b := &recorder{agent: "a2", human: "dev"}
	rel.Join("r1", a)
	rel.Join("r1", b)

	claimRegion(rel, a, "src/pay.py")
	rel.Handle(a, map[string]any{"type": "event", "verb": "edit", "region": goldenRegion("src/pay.py", "")})
	reply := rel.Handle(b, map[string]any{"type": "event", "verb": "edit", "region": goldenRegion("src/pay.py", "")})

	if reply["type"] != "ack" {
		t.Fatalf("got type %v, want ack", reply["type"])
	}
	if reply["rung"] != 3 {
		t.Fatalf("the rung is a fact and policy does not move it: got %v", reply["rung"])
	}
	if reply["effect"] != "notify" {
		t.Fatalf("got effect %v, want notify", reply["effect"])
	}
}

func TestADefaultRungThreeStillNegotiates(t *testing.T) {
	clock := NewVirtualClock(1000.0)
	rel := NewRelay(clock, InertRoster(), metrics.New())
	a := &recorder{agent: "a1", human: "sara"}
	b := &recorder{agent: "a2", human: "dev"}
	rel.Join("r1", a)
	rel.Join("r1", b)

	claimRegion(rel, a, "src/pay.py")
	rel.Handle(a, map[string]any{"type": "event", "verb": "edit", "region": goldenRegion("src/pay.py", "")})
	reply := rel.Handle(b, map[string]any{"type": "event", "verb": "edit", "region": goldenRegion("src/pay.py", "")})

	if reply["type"] != "negotiate" {
		t.Fatalf("got type %v, want negotiate", reply["type"])
	}
	if reply["effect"] != "deny" {
		t.Fatalf("got effect %v, want deny", reply["effect"])
	}
	if reply["effect_source"] != "builtin" {
		t.Fatalf("got effect_source %v, want builtin", reply["effect_source"])
	}
}

func TestAPolicyCanRaiseALowerRungIntoANegotiation(t *testing.T) {
	rel, _, _ := orgRelay(t, "[effects]\nrung2 = \"deny\"\n")
	a := &recorder{agent: "a1", human: "sara"}
	b := &recorder{agent: "a2", human: "dev"}
	rel.Join("r1", a)
	rel.Join("r1", b)

	// a1 holds the whole file (symbol nil), so any symbol in it contends —
	// but the two agents edit different symbols, which is rung 2, not 3.
	rel.Handle(a, map[string]any{"type": "claim",
		"region": map[string]any{"path": "src/db.py", "symbol": nil, "lines": nil}, "intent": "x"})
	rel.Handle(a, map[string]any{"type": "event", "verb": "edit", "region": goldenRegion("src/db.py", "insert")})
	reply := rel.Handle(b, map[string]any{"type": "event", "verb": "edit", "region": goldenRegion("src/db.py", "query")})

	if reply["rung"] != 2 {
		t.Fatalf("got rung %v, want 2", reply["rung"])
	}
	if reply["effect"] != "deny" {
		t.Fatalf("got effect %v, want deny", reply["effect"])
	}
	if reply["type"] != "negotiate" {
		t.Fatalf("got type %v, want negotiate", reply["type"])
	}
}

func TestAPathRuleOnlyQuietensThePathsItNames(t *testing.T) {
	rel, _, _ := orgRelay(t, "[[path]]\nmatch = \"src/generated/**\"\nrung3 = \"notify\"\n")
	a := &recorder{agent: "a1", human: "sara"}
	b := &recorder{agent: "a2", human: "dev"}
	rel.Join("r1", a)
	rel.Join("r1", b)

	for _, path := range []string{"src/generated/api.py", "src/pay.py"} {
		claimRegion(rel, a, path)
		rel.Handle(a, map[string]any{"type": "event", "verb": "edit", "region": goldenRegion(path, "")})
	}
	quiet := rel.Handle(b, map[string]any{"type": "event", "verb": "edit", "region": goldenRegion("src/generated/api.py", "")})
	loud := rel.Handle(b, map[string]any{"type": "event", "verb": "edit", "region": goldenRegion("src/pay.py", "")})

	if quiet["type"] != "ack" || quiet["effect"] != "notify" {
		t.Fatalf("got %+v", quiet)
	}
	if loud["type"] != "negotiate" || loud["effect"] != "deny" {
		t.Fatalf("got %+v", loud)
	}
}

func TestAnUnattendedConnectionGetsAskPromotedToDeny(t *testing.T) {
	rel, _, _ := orgRelay(t, "[effects]\nrung3 = \"ask\"\n")
	watched := &recorder{agent: "a1", human: "sara"}
	alone := &fakeUnattendedConn{recorder: recorder{agent: "a2", human: "sara"}}
	rel.Join("r1", watched)
	rel.Join("r1", alone)

	claimRegion(rel, watched, "src/pay.py")
	rel.Handle(watched, map[string]any{"type": "event", "verb": "edit", "region": goldenRegion("src/pay.py", "")})
	reply := rel.Handle(alone, map[string]any{"type": "event", "verb": "edit", "region": goldenRegion("src/pay.py", "")})
	if reply["effect"] != "deny" {
		t.Fatalf("got effect %v, want deny", reply["effect"])
	}
}

type fakeUnattendedConn struct{ recorder }

func (f *fakeUnattendedConn) Unattended() bool { return true }

func TestARelayWithNoOrgPolicySendsNoPolicyFrame(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("AGENT_SYNC_ORG_POLICY", filepath.Join(dir, "nope.toml"))
	rel := NewRelay(NewVirtualClock(1000.0), InertRoster(), metrics.New())
	conn := &recorder{agent: "a1", human: "sara"}
	rel.Join("r1", conn)
	if len(conn.sent) != 1 || conn.sent[0]["type"] != "leases" {
		t.Fatalf("expected exactly one leases frame and nothing else, got %+v", conn.sent)
	}
}

func TestTheOrgFloorIsPushedOnJoinAfterTheLeaseSnapshot(t *testing.T) {
	rel, path, _ := orgRelay(t, "[floor]\nrung2 = \"context\"\n")
	conn := &recorder{agent: "a1", human: "sara"}
	rel.Join("r1", conn)

	if len(conn.sent) != 2 || conn.sent[0]["type"] != "leases" || conn.sent[1]["type"] != "policy" {
		t.Fatalf("expected [leases, policy] in order, got %+v", conn.sent)
	}
	frame := conn.sent[1]
	floor := floorNames(frame["floor"])
	if len(floor) != 5 || floor[2] != "context" {
		t.Fatalf("got floor %v, want rung2=context", frame["floor"])
	}
	if frame["source"] != "org:"+path {
		t.Fatalf("got source %v, want org:%s", frame["source"], path)
	}
	if frame["digest"] == "" || frame["digest"] == nil {
		t.Fatalf("expected a non-empty digest")
	}
}

func TestEditingTheOrgFileRepublishesTheFloorToTheWholeRoom(t *testing.T) {
	rel, path, clock := orgRelay(t, "[floor]\nrung2 = \"notify\"\n")
	a := &recorder{agent: "a1", human: "sara"}
	b := &recorder{agent: "a2", human: "dev"}
	rel.Join("r1", a)
	rel.Join("r1", b)
	a.sent, b.sent = nil, nil

	if err := os.WriteFile(path, []byte("[floor]\nrung2 = \"deny\"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	clock.Advance(2.0)
	rel.Handle(a, map[string]any{"type": "heartbeat", "region": goldenRegion("src/x.py", "")})

	for name, conn := range map[string]*recorder{"a": a, "b": b} {
		var pushed []Frame
		for _, f := range conn.sent {
			if f["type"] == "policy" {
				pushed = append(pushed, f)
			}
		}
		if len(pushed) != 1 {
			t.Fatalf("%s: got %d policy frames, want 1: %+v", name, len(pushed), conn.sent)
		}
		floor := floorNames(pushed[0]["floor"])
		if floor[2] != "deny" {
			t.Fatalf("%s: got floor %v, want rung2=deny", name, floor)
		}
	}
}

func TestAnUnchangedOrgFileIsNotRepublished(t *testing.T) {
	rel, _, clock := orgRelay(t, "[floor]\nrung2 = \"notify\"\n")
	conn := &recorder{agent: "a1", human: "sara"}
	rel.Join("r1", conn)
	conn.sent = nil

	for i := 0; i < 5; i++ {
		clock.Advance(2.0)
		rel.Handle(conn, map[string]any{"type": "heartbeat", "region": goldenRegion("src/x.py", "")})
	}
	for _, f := range conn.sent {
		if f["type"] == "policy" {
			t.Fatalf("expected no republish for an unchanged file, got %+v", conn.sent)
		}
	}
}

func TestABlanketOnlyOrgFloorPutsNothingExtraOnTheWire(t *testing.T) {
	rel, _, _ := orgRelay(t, "[floor]\nrung2 = \"context\"\n")
	conn := &recorder{agent: "a1", human: "sara"}
	rel.Join("r1", conn)
	frame := conn.sent[len(conn.sent)-1]
	if _, ok := frame["floors"]; ok {
		t.Fatalf("expected no `floors` key for a blanket-only org floor, got %+v", frame)
	}
}

// TestDeletingTheOrgFileRelaxesAlreadyJoinedDaemons is issue #2 of the
// system-seams audit: deleting the org policy file made policyFrame return
// nil, so publishPolicyChange latched the new (relaxed) digest and then had
// nothing to broadcast — every daemon already holding the old, stricter
// floor stayed on it forever with no error anywhere. The fix has
// policyFrame fall back to the compiled-in builtin floor instead of nil, so
// a real transition (something that was configured going away) always has
// something to put on the wire.
func TestDeletingTheOrgFileRelaxesAlreadyJoinedDaemons(t *testing.T) {
	rel, path, clock := orgRelay(t, "[floor]\nrung3 = \"deny\"\n")
	conn := &recorder{agent: "a1", human: "sara"}
	rel.Join("r1", conn)
	conn.sent = nil

	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	clock.Advance(2.0)
	rel.Handle(conn, map[string]any{"type": "heartbeat", "region": goldenRegion("src/x.py", "")})

	var pushed []Frame
	for _, f := range conn.sent {
		if f["type"] == "policy" {
			pushed = append(pushed, f)
		}
	}
	if len(pushed) != 1 {
		t.Fatalf("expected exactly one relaxed policy frame once the org file disappeared, got %d: %+v", len(pushed), conn.sent)
	}
	floor := floorNames(pushed[0]["floor"])
	if floor[3] != "notify" {
		t.Fatalf("floor should drop back to the compiled-in default (rung3=notify), got %v", floor)
	}
	if pushed[0]["source"] != "builtin" {
		t.Fatalf("got source %v, want builtin", pushed[0]["source"])
	}
}

func TestAPathScopedOrgFloorIsOnTheFrame(t *testing.T) {
	rel, _, _ := orgRelay(t, "[[floor.path]]\nmatch = \"src/pay.py\"\nrung3 = \"deny\"\n")
	conn := &recorder{agent: "a1", human: "sara"}
	rel.Join("r1", conn)
	frame := conn.sent[len(conn.sent)-1]
	floors, ok := frame["floors"].([]any)
	if !ok || len(floors) != 1 {
		t.Fatalf("expected one floors entry, got %+v", frame["floors"])
	}
	entry, ok := floors[0].(map[string]any)
	if !ok || entry["match"] != "src/pay.py" {
		t.Fatalf("got match %v, want src/pay.py", entry["match"])
	}
}
