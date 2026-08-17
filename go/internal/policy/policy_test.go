package policy

import (
	"os"
	"path/filepath"
	"strings"
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

// -- per-path rules -----------------------------------------------------

func TestEffectForPathMatchingRuleWinsOverBlanketTable(t *testing.T) {
	dir := t.TempDir()
	p := writeCache(t, dir, "cache.json",
		`{"table":["silent","notify","context","notify","context"],`+
			`"rules":[{"match":"src/**","effects":["","","","deny",""],"layer":"repo"}]}`)

	c := New()
	c.Refresh(p, 0)

	if got := c.EffectForPath(3, "src/pay.py"); got != Deny {
		t.Fatalf("matching path: got %v, want deny", got)
	}
	if got := c.EffectForPath(3, "other/file.py"); got != Notify {
		t.Fatalf("non-matching path must fall back to the blanket table: got %v, want notify", got)
	}
}

// A path rule beating the blanket table also passes if EffectForPath
// treats "" (the wire's blanket marker) as matching nothing rather than
// everything — the fallback to `table[rung]` looks identical either way.
// This is the test that tells the two readings apart: a higher-authority
// blanket rule has to win outright over a lower-authority path rule, the
// same way python's `_resolve_at` takes "highest layer with anything to
// say" before it ever looks at specificity.
func TestEffectForPathAuthorityBeatsSpecificity(t *testing.T) {
	dir := t.TempDir()
	p := writeCache(t, dir, "cache.json",
		`{"table":["silent","notify","context","deny","context"],`+
			`"rules":[`+
			`{"match":"","effects":["","","","ask",""],"layer":"session"},`+
			`{"match":"src/**","effects":["","","","context",""],"layer":"repo"}`+
			`]}`)

	c := New()
	c.Refresh(p, 0)

	if got := c.EffectForPath(3, "src/pay.py"); got != Ask {
		t.Fatalf("session's blanket rule must win over repo's more specific one: got %v, want ask", got)
	}
	if got := c.EffectForPath(3, "unrelated.py"); got != Ask {
		t.Fatalf("session's blanket rule matches every path, not just src/**: got %v, want ask", got)
	}
}

// A rule that matches the path but says nothing for this rung must be
// skipped, not treated as a stop — the built-in blanket rule two entries
// later is what actually answers rung 3 here.
func TestEffectForPathSkipsRuleMissingThatRung(t *testing.T) {
	dir := t.TempDir()
	p := writeCache(t, dir, "cache.json",
		`{"table":["silent","notify","context","deny","context"],`+
			`"rules":[{"match":"src/**","effects":["","","notify","",""],"layer":"repo"}]}`)

	c := New()
	c.Refresh(p, 0)

	if got := c.EffectForPath(2, "src/pay.py"); got != Notify {
		t.Fatalf("rung 2: got %v, want the repo rule's notify", got)
	}
	if got := c.EffectForPath(3, "src/pay.py"); got != Deny {
		t.Fatalf("rung 3: repo's rule matches the path but not this rung, so this must fall through to the blanket table (deny), not silent: got %v", got)
	}
}

// The relay-pushed org floor is a blanket, applied to every path — a local
// rule loosening one rung for one path must not be able to duck under it.
func TestEffectForPathOrgFloorStillWins(t *testing.T) {
	dir := t.TempDir()
	p := writeCache(t, dir, "cache.json",
		`{"table":["silent","notify","context","deny","context"],`+
			`"rules":[{"match":"src/**","effects":["","","","silent",""],"layer":"user"}]}`)

	c := New()
	c.Refresh(p, 0)
	c.SetFloor(Table{Silent, Silent, Silent, Deny, Silent}, "org")

	if got := c.EffectForPath(3, "src/pay.py"); got != Deny {
		t.Fatalf("a rule may loosen the local effect, but the org floor still applies: got %v, want deny", got)
	}
}

// A [[floor.path]] entry from the compiled cache raises the floor only
// where its glob matches — unlike `rules`, every matching entry is folded
// in (max, not first-match), and the blanket org floor from SetFloor still
// applies everywhere else.
func TestEffectForPathFloorRuleAppliesOnlyWhereItMatches(t *testing.T) {
	dir := t.TempDir()
	p := writeCache(t, dir, "cache.json",
		`{"table":["silent","silent","silent","silent","silent"],`+
			`"floors":[{"match":"vendor/**","effects":["","","","deny",""],"layer":"repo"}]}`)

	c := New()
	c.Refresh(p, 0)
	c.SetFloor(Table{Silent, Silent, Silent, Notify, Silent}, "org")

	if got := c.EffectForPath(3, "vendor/pay.py"); got != Deny {
		t.Fatalf("vendor/** floor rule must raise this path to deny: got %v", got)
	}
	if got := c.EffectForPath(3, "other/pay.py"); got != Notify {
		t.Fatalf("a path the floor rule doesn't cover must stay at the blanket org floor: got %v, want notify", got)
	}
}

// Going forward, `rules` is the source of truth once it exists: a blanket
// rule entry wins over `table` for the rung it fills, and falls back to
// `table` only for a rung it leaves unset. A correctly generated cache
// never disagrees between the two (both come from the same compile), but
// nothing stops a hand-edited or stale one from doing so, and this pins
// which one wins when it happens.
func TestEffectForPathRulesBlanketBeatsTableWhereItFills(t *testing.T) {
	dir := t.TempDir()
	p := writeCache(t, dir, "cache.json",
		`{"table":["deny","deny","deny","deny","deny"],`+
			`"rules":[{"match":"","effects":["silent","","","",""],"layer":"session"}]}`)

	c := New()
	c.Refresh(p, 0)

	if got := c.EffectForPath(0, "anything"); got != Silent {
		t.Fatalf("rung 0: rules' blanket entry must beat table: got %v, want silent", got)
	}
	if got := c.EffectForPath(1, "anything"); got != Deny {
		t.Fatalf("rung 1: rules' blanket entry says nothing here, must fall back to table: got %v, want deny", got)
	}
}

func TestEffectForPathMalformedGlobIsDroppedAndDegrades(t *testing.T) {
	dir := t.TempDir()
	p := writeCache(t, dir, "cache.json",
		`{"table":["notify","notify","notify","notify","notify"],`+
			`"rules":[{"match":"src/[oops","effects":["","","","deny",""],"layer":"repo"}]}`)

	c := New()
	c.Refresh(p, 0)

	if !c.Degraded() {
		t.Fatal("an unclosed bracket in a glob must degrade, the same as a bad table word does")
	}
	if !strings.Contains(c.Problem(), "does not compile") {
		t.Fatalf("problem should name the bad glob: got %q", c.Problem())
	}
	// No matches() call can tell what the malformed glob meant to cover, so
	// the whole entry is unusable, not "matches everything" and not
	// "matches nothing that also silently applies": it must fall through
	// to the blanket table exactly as if the rule were never written.
	if got := c.EffectForPath(3, "src/pay.py"); got != Notify {
		t.Fatalf("got %v, want the blanket table's notify (rule dropped)", got)
	}
}

func TestEffectForPathUnknownRuleEffectNameKeepsThatRungAlone(t *testing.T) {
	dir := t.TempDir()
	p := writeCache(t, dir, "cache.json",
		`{"table":["notify","notify","notify","notify","notify"],`+
			`"rules":[{"match":"src/**","effects":["silent","","","LOUD",""],"layer":"repo"}]}`)

	c := New()
	c.Refresh(p, 0)

	if !c.Degraded() {
		t.Fatal("an unknown effect name in a rule must degrade, the same as a bad table word does")
	}
	if !strings.Contains(c.Problem(), "LOUD") {
		t.Fatalf("problem should name the bad word: got %q", c.Problem())
	}
	if got := c.EffectForPath(0, "src/pay.py"); got != Silent {
		t.Fatalf("rung 0 was a good word on the same rule and must still apply: got %v", got)
	}
	if got := c.EffectForPath(3, "src/pay.py"); got != Notify {
		t.Fatalf("rung 3's bad word must fall back to the blanket table, not go silent: got %v", got)
	}
}

// ExplainPath is EffectForPath with its reasoning kept: which layer's rule
// won, and — separately — which layer's floor rule won when the floor is
// what actually decided it.
func TestExplainPathReportsWinningLayerAndFloorLayer(t *testing.T) {
	dir := t.TempDir()
	p := writeCache(t, dir, "cache.json",
		`{"table":["silent","silent","silent","silent","silent"],`+
			`"floors":[{"match":"vendor/**","effects":["","","","deny",""],"layer":"repo"}]}`)

	c := New()
	c.Refresh(p, 0)
	c.SetFloor(Table{Silent, Silent, Silent, Notify, Silent}, "relay-org")

	matched := c.ExplainPath(3, "vendor/pay.py")
	if matched.Effect != Deny || !matched.FromFloor || matched.Layer != "repo" || matched.Source != p {
		t.Fatalf("got %+v", matched)
	}

	unmatched := c.ExplainPath(3, "other/pay.py")
	if unmatched.Effect != Notify || !unmatched.FromFloor || unmatched.Layer != "" || unmatched.Source != "relay-org" {
		t.Fatalf("a path the floor rule doesn't cover should fall back to the relay's floor and name it: got %+v", unmatched)
	}
}

// EffectFor(rung) is documented as EffectForPath(rung, "") and nothing
// else — this pins that a cache with a path-scoped rule doesn't change
// what the no-path callers see, since a glob anchored to a real prefix
// like src/** never matches the empty string.
func TestEffectForDelegatesToEmptyPath(t *testing.T) {
	dir := t.TempDir()
	p := writeCache(t, dir, "cache.json",
		`{"table":["silent","notify","context","deny","context"],`+
			`"rules":[{"match":"src/**","effects":["","","","ask",""],"layer":"repo"}]}`)

	c := New()
	c.Refresh(p, 0)

	if c.EffectFor(3) != c.EffectForPath(3, "") {
		t.Fatal("EffectFor must be exactly EffectForPath(rung, \"\")")
	}
	if c.EffectFor(3) != Deny {
		t.Fatalf("src/** does not match the empty path, so this must still be the blanket table's deny: got %v", c.EffectFor(3))
	}
}

// The other half of the same question: a rule genuinely written as a
// wire-level blanket (match:"", python's Rule.match is None) is not "no
// rule" — it matches every path including "", so it has to reach a
// no-path caller through EffectFor exactly the way it reaches every
// EffectForPath caller. This is the case review leftover #2 asked to see
// pinned: a bare blanket rules entry, queried through EffectFor.
func TestEffectForSeesWireBlanketRule(t *testing.T) {
	dir := t.TempDir()
	p := writeCache(t, dir, "cache.json",
		`{"table":["silent","notify","context","deny","context"],`+
			`"rules":[{"match":"","effects":["","","","ask",""],"layer":"repo"}]}`)

	c := New()
	c.Refresh(p, 0)

	if got := c.EffectFor(3); got != Ask {
		t.Fatalf("a wire-level blanket rule (match:\"\") must fire on the empty path too: got %v, want %v", got, Ask)
	}
}

// Pinned from python's own policy._compile_glob / Rule.matches, not
// reimplemented from a reading of the docstring — see the sibling script
// under the seamfix scratch dir if this table needs regenerating. A
// mismatch here means Go and python read the same [[path]] line as
// covering different files.
func TestCompileGlobAgreesWithPython(t *testing.T) {
	cases := []struct {
		pattern string
		path    string
		valid   bool
		match   bool
	}{
		{"src/*.py", "src/pay.py", true, true},
		{"src/*.py", "src/a/b.py", true, false},
		{"src/**", "src/a/b.py", true, true},
		{"src/**", "src/pay.py", true, true},
		{"src/**", "src", true, false},
		{"**/pay.py", "pay.py", true, true},
		{"**/pay.py", "a/b/pay.py", true, true},
		{"**/pay.py", "a/b/xpay.py", true, false},
		{"vendor/**", "vendor/pay.py", true, true},
		{"vendor/**", "vendor2/pay.py", true, false},
		{"*.py", "pay.py", true, true},
		{"*.py", "src/pay.py", true, false},
		{"a?c", "abc", true, true},
		{"a?c", "ac", true, false},
		{"a?c", "abbc", true, false},
		{"[abc].py", "a.py", true, true},
		{"[abc].py", "d.py", true, false},
		{"[!abc].py", "d.py", true, true},
		{"[!abc].py", "a.py", true, false},
		{"src/[a-z]*.py", "src/pay.py", true, true},
		{"src/[a-z]*.py", "src/PAY.py", true, false},
		{"a[.py", "a[.py", false, false},
		{"src/pay.py", "src/pay.py", true, true},
		{"src/pay.py", "src/PAY.py", true, false},
		{"a.b.c", "a.b.c", true, true},
		{"a.b.c", "aXbXc", true, false},
		{"**", "anything/at/all", true, true},
		{"**", "", true, true},
	}
	for _, tc := range cases {
		re := compileGlob(tc.pattern)
		if valid := re != nil; valid != tc.valid {
			t.Fatalf("compileGlob(%q): valid=%v, want %v", tc.pattern, valid, tc.valid)
		}
		if re == nil {
			continue
		}
		if got := re.MatchString(tc.path); got != tc.match {
			t.Fatalf("compileGlob(%q).MatchString(%q) = %v, want %v", tc.pattern, tc.path, got, tc.match)
		}
	}
}
