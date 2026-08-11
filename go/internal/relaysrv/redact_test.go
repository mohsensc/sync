package relaysrv

import "testing"

// TestRedactEventHashesRegionExactlyOnceUnderOpaqueMode guards the fix for
// a real bug the fix for the "opaque toggle read twice" cleanup could have
// reintroduced: RedactEvent now builds its own region dict *unhashed*
// (regionPayloadUnmarked) and relies on the single trailing
// applyOpaqueMap pass to hash it. If that dict were ever marked opaque
// before hashing — the mistake regionPayloadUnmarked's doc comment warns
// about — the blanket pass would see the mark, skip it, and a cleartext
// path would reach the wire under opaque mode. This is exactly the class
// of bug docs/relay-parity.md calls the most dangerous line in the diff.
func TestRedactEventHashesRegionExactlyOnceUnderOpaqueMode(t *testing.T) {
	t.Setenv(OpaqueEnv, "1")

	msg := map[string]any{
		"type": "event", "verb": "edit", "source": "hook",
		"region": map[string]any{"path": "src/auth.py", "symbol": "sign_in", "lines": nil},
	}
	out := RedactEvent(msg)

	region, ok := out["region"].(map[string]any)
	if !ok {
		t.Fatalf("expected a region map, got %#v", out["region"])
	}
	if region["path"] == "src/auth.py" {
		t.Fatalf("cleartext path reached the redacted event under opaque mode: %#v", region)
	}
	if region[OpaqueMark] != true {
		t.Fatalf("expected the region to end up marked opaque, got %#v", region)
	}
	// The hash itself: same input, same output, and it's what OpaqueRegion
	// alone would have produced — confirms this went through the hash
	// exactly once, not zero times (leak) or twice (a different, doubly
	// hashed value would still fail an equality check against a single
	// hash, so this also catches a double-hash regression).
	want := hashHex("src/auth.py")
	if region["path"] != want {
		t.Fatalf("region path = %v, want single-hashed %v", region["path"], want)
	}
}

func TestRedactEventLeavesRegionInCleartextWhenOpaqueIsOff(t *testing.T) {
	msg := map[string]any{
		"type": "event", "verb": "edit", "source": "hook",
		"region": map[string]any{"path": "src/auth.py", "symbol": "sign_in", "lines": nil},
	}
	out := RedactEvent(msg)
	// Opaque mode is off, so RedactEvent never runs the trailing
	// applyOpaqueMap pass that would convert this to a plain
	// map[string]any — it stays the Frame regionPayloadUnmarked built.
	// Same type-assertion subtlety as the bug this file's other test
	// guards against, this time in the test rather than the relay.
	region, ok := out["region"].(Frame)
	if !ok {
		t.Fatalf("expected a region Frame, got %#v", out["region"])
	}
	if region["path"] != "src/auth.py" {
		t.Fatalf("region path = %v, want cleartext src/auth.py (opaque mode is off)", region["path"])
	}
	if _, marked := region[OpaqueMark]; marked {
		t.Fatalf("region should carry no opaque mark when opaque mode is off, got %#v", region)
	}
}
