package policy

import (
	"os"
	"path/filepath"
	"testing"
)

func writeCache(t *testing.T, dir, name, content string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestRefreshAppliesTable(t *testing.T) {
	dir := t.TempDir()
	p := writeCache(t, dir, "cache.json", `{"table":["silent","ask","deny","deny","context"]}`)

	c := New()
	if !c.Refresh(p, 0) {
		t.Fatal("expected table to change on first load")
	}
	if c.EffectFor(1) != Ask {
		t.Fatalf("got %v", c.EffectFor(1))
	}
	if c.EffectFor(2) != Deny {
		t.Fatalf("got %v", c.EffectFor(2))
	}
}

func TestRefreshThrottlesByRecheckWindow(t *testing.T) {
	dir := t.TempDir()
	// Deliberately not equal to Builtin, so the first load is observable
	// as a real change rather than a no-op that happens to match the
	// compiled-in default.
	p := writeCache(t, dir, "cache.json", `{"table":["silent","ask","context","deny","context"]}`)

	c := New()
	if !c.Refresh(p, 0) {
		t.Fatal("expected first refresh to load")
	}
	// Rewrite the file, but ask again inside the recheck window: must not
	// re-read.
	writeCache(t, dir, "cache.json", `{"table":["deny","deny","deny","deny","deny"]}`)
	if c.Refresh(p, 50) {
		t.Fatal("refresh inside the recheck window must not reparse")
	}
	if c.EffectFor(0) != Silent {
		t.Fatalf("table changed despite the recheck gate: %v", c.EffectFor(0))
	}
}

func TestRefreshMissingFileIsNotAFault(t *testing.T) {
	c := New()
	if c.Refresh(filepath.Join(t.TempDir(), "missing.json"), 0) {
		t.Fatal("a file that never existed must not report a change")
	}
	if c.Degraded() {
		t.Fatal("no cache yet is not a degradation; Builtin is the documented default")
	}
	if c.EffectFor(3) != Deny {
		t.Fatalf("got %v, want Builtin's rung 3 (deny)", c.EffectFor(3))
	}
}

func TestRefreshFileDisappearingKeepsLastTableAndDegrades(t *testing.T) {
	dir := t.TempDir()
	p := writeCache(t, dir, "cache.json", `{"table":["silent","ask","deny","deny","context"]}`)

	c := New()
	c.Refresh(p, 0)
	os.Remove(p)
	c.Refresh(p, 200)

	if c.EffectFor(1) != Ask {
		t.Fatal("a vanished cache must keep the last good table, never fall back to Builtin")
	}
	if !c.Degraded() {
		t.Fatal("a vanished cache must say so")
	}
}

func TestRefreshUnknownEffectNameKeepsThatRungAlone(t *testing.T) {
	dir := t.TempDir()
	p := writeCache(t, dir, "cache.json", `{"table":["silent","loud","deny","deny","context"]}`)

	c := New()
	c.Refresh(p, 0)
	// rung1 unknown -> stays at whatever `next` (a copy of the previous
	// local table, i.e. Builtin) already had there.
	if c.EffectFor(1) != Builtin[1] {
		t.Fatalf("got %v, want unknown rung to keep its previous value %v", c.EffectFor(1), Builtin[1])
	}
	if c.EffectFor(2) != Deny {
		t.Fatal("a bad word at one rung must not drop the other four")
	}
	if !c.Degraded() {
		t.Fatal("an unknown effect name must be reported")
	}
}

func TestRefreshOversizeFileIsRejected(t *testing.T) {
	dir := t.TempDir()
	big := make([]byte, maxBytes+1)
	for i := range big {
		big[i] = ' '
	}
	p := writeCache(t, dir, "cache.json", string(big))

	c := New()
	if c.Refresh(p, 0) {
		t.Fatal("an oversize file must never be treated as a real change")
	}
	if !c.Degraded() {
		t.Fatal("an oversize file must degrade, not silently keep Builtin with no explanation")
	}
}

func TestEffectForOutOfRangeIsSilent(t *testing.T) {
	c := New()
	if c.EffectFor(-1) != Silent || c.EffectFor(5) != Silent {
		t.Fatal("an out-of-range rung must answer silent, never panic")
	}
}

func TestSetFloorClampsToBuiltinFloor(t *testing.T) {
	dir := t.TempDir()
	// A local table that would otherwise let rung 3 go silent, to isolate
	// the floor's own clamp from the fact that Builtin's rung 3 is already
	// Deny and would mask it.
	p := writeCache(t, dir, "cache.json", `{"table":["silent","silent","silent","silent","silent"]}`)

	c := New()
	c.Refresh(p, 0)
	// Attempt to lower rung 3 (BuiltinFloor is Notify there) to Silent.
	c.SetFloor(Table{Silent, Silent, Silent, Silent, Silent}, "malicious")
	if c.EffectFor(3) != Notify {
		t.Fatalf("a floor may never be set quieter than BuiltinFloor: got %v", c.EffectFor(3))
	}
}

func TestExplainReportsFloorVsLocal(t *testing.T) {
	dir := t.TempDir()
	p := writeCache(t, dir, "cache.json", `{"table":["silent","silent","silent","silent","silent"]}`)

	c := New()
	c.Refresh(p, 0)
	c.SetFloor(Table{Silent, Silent, Silent, Deny, Silent}, "org")

	origin := c.Explain(3)
	if !origin.FromFloor || origin.Source != "org" || origin.Effect != Deny {
		t.Fatalf("got %+v", origin)
	}

	origin0 := c.Explain(0)
	if origin0.FromFloor || origin0.Source != p {
		t.Fatalf("got %+v", origin0)
	}
}

func TestDegradedFlagFromCacheFileIsSurfaced(t *testing.T) {
	dir := t.TempDir()
	p := writeCache(t, dir, "cache.json",
		`{"table":["silent","notify","context","deny","context"],"degraded":true,"problem":"bad toml"}`)

	c := New()
	c.Refresh(p, 0)
	if !c.Degraded() {
		t.Fatal("expected degraded")
	}
	if c.Problem() != "bad toml" {
		t.Fatalf("got %q", c.Problem())
	}
}

func TestLouder(t *testing.T) {
	if Louder(Silent, Deny) != Deny || Louder(Ask, Notify) != Ask {
		t.Fatal("Louder must return the max of the two")
	}
}

func TestParseEffectRoundTrip(t *testing.T) {
	for _, e := range []Effect{Silent, Notify, Context, Ask, Deny} {
		got, ok := ParseEffect(e.String())
		if !ok || got != e {
			t.Fatalf("round trip failed for %v", e)
		}
	}
	if _, ok := ParseEffect("loud"); ok {
		t.Fatal("unknown name must not parse")
	}
}
