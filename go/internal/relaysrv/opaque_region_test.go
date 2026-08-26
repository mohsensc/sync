package relaysrv

import (
	"testing"

	"github.com/mohsensc/sync/go/internal/metrics"
)

// Opaque mode is meant to replace a path with its hash on the way out, not
// to lose it. onEvent asserted the redacted region as Frame, but
// applyOpaqueMap rebuilds every nested map as a bare map[string]any, so
// under AGENT_PRESENCE_OPAQUE the assertion failed silently and every touch
// was processed as a region with an empty path.

func TestOpaqueModeHashesTheRegionRatherThanBlankingIt(t *testing.T) {
	t.Setenv(OpaqueEnv, "1")

	clock := NewVirtualClock(1000.0)
	rel := NewRelay(clock, InertRoster(), metrics.New())
	conn := &recorder{agent: "a1", human: "H"}
	rel.Join("r1", conn)

	rel.Handle(conn, map[string]any{
		"type": "event", "verb": "edit",
		"region": goldenRegion("secret/path.go", "Foo"),
	})

	ri := rel.roomOf("r1")
	ri.mu.Lock()
	activity := append([]timedActivity(nil), ri.activity...)
	ri.mu.Unlock()

	if len(activity) != 1 {
		t.Fatalf("expected the touch to be recorded, got %d entries", len(activity))
	}
	got := activity[0].a.Region
	if got.Path == "" {
		t.Fatal("opaque mode blanked the region instead of hashing it")
	}
	if got.Path == "secret/path.go" {
		t.Fatal("opaque mode left the path in the clear")
	}
	if got.Symbol == nil || *got.Symbol == "Foo" {
		t.Fatalf("symbol should be hashed too, got %v", got.Symbol)
	}
}

// The same event in the clear still carries the real path — the tolerant
// read must not change what non-opaque mode does.
func TestClearModeStillCarriesTheRealRegion(t *testing.T) {
	clock := NewVirtualClock(1000.0)
	rel := NewRelay(clock, InertRoster(), metrics.New())
	conn := &recorder{agent: "a1", human: "H"}
	rel.Join("r1", conn)

	rel.Handle(conn, map[string]any{
		"type": "event", "verb": "edit",
		"region": goldenRegion("src/a.go", "Foo"),
	})

	ri := rel.roomOf("r1")
	ri.mu.Lock()
	activity := append([]timedActivity(nil), ri.activity...)
	ri.mu.Unlock()

	if len(activity) != 1 {
		t.Fatalf("expected the touch to be recorded, got %d entries", len(activity))
	}
	if got := activity[0].a.Region.Path; got != "src/a.go" {
		t.Fatalf("region path = %q, want src/a.go", got)
	}
}

// asFrame is the whole fix: both concrete types read the same way.
func TestAsFrameReadsBothConcreteTypes(t *testing.T) {
	if got := asFrame(Frame{"path": "a"}); got["path"] != "a" {
		t.Fatalf("Frame not read back: %+v", got)
	}
	if got := asFrame(map[string]any{"path": "a"}); got["path"] != "a" {
		t.Fatalf("map[string]any not read back: %+v", got)
	}
	if got := asFrame("not a frame"); got != nil {
		t.Fatalf("a non-frame should read as nil, got %+v", got)
	}
}
