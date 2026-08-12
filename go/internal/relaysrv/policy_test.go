package relaysrv

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Ported from python/tests/test_policy.py — the org-floor-relevant subset.
// The relay only ever loads builtin+org (policy.py's RELAY_INCLUDE), but
// the layer machinery itself is general, so these build arbitrary layer
// stacks the same way test_policy.py's `layers()` helper does, to pin
// down the same behavior the Python source documents.

const anyPath = "src/app.py"

func testLayers(t *testing.T, specs ...[2]string) Policy {
	t.Helper()
	layers := []policyLayer{builtinLayer()}
	for _, spec := range specs {
		name, text := spec[0], spec[1]
		layers = append(layers, parseLayer(text, layerName(name), "<"+name+">"))
	}
	return buildPolicy(layers, 0)
}

func TestAnEmptyStackResolvesToBuiltinOnEveryRung(t *testing.T) {
	policy := buildPolicy([]policyLayer{builtinLayer()}, 0)
	for rung := 0; rung < 5; rung++ {
		got := policy.Resolve(rung, anyPath, false).Effect
		if got != builtinTable[rung] {
			t.Errorf("rung %d: got %s, want %s", rung, got, builtinTable[rung])
		}
	}
	if policy.Degraded {
		t.Fatalf("expected not degraded")
	}
}

func TestAPathRuleBeatsTheBlanketRule(t *testing.T) {
	policy := testLayers(t, [2]string{"user", `
[effects]
rung2 = "deny"

[[path]]
match = "src/generated/**"
rung2 = "silent"
`})
	if got := policy.Resolve(2, "src/generated/api.py", false).Effect; got != EffectSilent {
		t.Errorf("got %s, want silent", got)
	}
	if got := policy.Resolve(2, "src/app.py", false).Effect; got != EffectDeny {
		t.Errorf("got %s, want deny", got)
	}
}

func TestTheLongestLiteralPrefixWins(t *testing.T) {
	policy := testLayers(t, [2]string{"user", `
[[path]]
match = "src/**"
rung2 = "ask"

[[path]]
match = "src/payments/**"
rung2 = "deny"
`})
	if got := policy.Resolve(2, "src/payments/charge.py", false).Effect; got != EffectDeny {
		t.Errorf("got %s, want deny", got)
	}
	if got := policy.Resolve(2, "src/other/x.py", false).Effect; got != EffectAsk {
		t.Errorf("got %s, want ask", got)
	}
}

func TestFileOrderIsNotWhatDecidesBetweenDifferentSpecificities(t *testing.T) {
	policy := testLayers(t, [2]string{"user", `
[[path]]
match = "src/payments/**"
rung2 = "deny"

[[path]]
match = "src/**"
rung2 = "silent"
`})
	if got := policy.Resolve(2, "src/payments/charge.py", false).Effect; got != EffectDeny {
		t.Errorf("got %s, want deny", got)
	}
}

func TestAnExactSpecificityTieTakesTheLaterRuleAndWarns(t *testing.T) {
	policy := testLayers(t, [2]string{"user", `
[[path]]
match = "src/**"
rung2 = "ask"

[[path]]
match = "src/*"
rung2 = "deny"
`})
	res := policy.Resolve(2, "src/app.py", false)
	if res.Effect != EffectDeny {
		t.Errorf("got %s, want deny", res.Effect)
	}
	found := false
	for _, p := range res.Problems {
		if strings.Contains(p, "equally specific") {
			found = true
		}
	}
	if !found {
		t.Errorf("expected a tie warning, got %v", res.Problems)
	}
}

func TestAStarDoesNotCrossADirectorySeparator(t *testing.T) {
	policy := testLayers(t, [2]string{"user", "[[path]]\nmatch = \"src/*.py\"\nrung2 = \"deny\"\n"})
	if got := policy.Resolve(2, "src/app.py", false).Effect; got != EffectDeny {
		t.Errorf("got %s, want deny", got)
	}
	if got := policy.Resolve(2, "src/deep/app.py", false).Effect; got != builtinTable[2] {
		t.Errorf("got %s, want builtin %s", got, builtinTable[2])
	}
}

func TestADoubleStarDoes(t *testing.T) {
	policy := testLayers(t, [2]string{"user", "[[path]]\nmatch = \"src/**\"\nrung2 = \"deny\"\n"})
	if got := policy.Resolve(2, "src/deep/app.py", false).Effect; got != EffectDeny {
		t.Errorf("got %s, want deny", got)
	}
}

func TestALeadingDoubleStarAlsoMatchesTheBareName(t *testing.T) {
	policy := testLayers(t, [2]string{"user", "[[path]]\nmatch = \"**/conftest.py\"\nrung2 = \"deny\"\n"})
	if got := policy.Resolve(2, "conftest.py", false).Effect; got != EffectDeny {
		t.Errorf("got %s, want deny", got)
	}
	if got := policy.Resolve(2, "a/b/conftest.py", false).Effect; got != EffectDeny {
		t.Errorf("got %s, want deny", got)
	}
}

func TestObserverModeCapsTheLayerAtNotify(t *testing.T) {
	policy := testLayers(t, [2]string{"user", "mode = \"observer\"\n[effects]\nrung3 = \"deny\"\n"})
	res := policy.Resolve(3, anyPath, false)
	if res.Effect != EffectNotify {
		t.Errorf("got %s, want notify", res.Effect)
	}
	if res.Ceiling == nil || *res.Ceiling != EffectNotify {
		t.Errorf("expected ceiling notify, got %v", res.Ceiling)
	}
}

func TestAFloorBeatsTheObserverCeiling(t *testing.T) {
	policy := testLayers(t,
		[2]string{"org", "[floor]\nrung3 = \"ask\"\n"},
		[2]string{"user", "mode = \"observer\"\n[effects]\nrung3 = \"deny\"\n"},
	)
	res := policy.Resolve(3, anyPath, false)
	if res.Effect != EffectAsk {
		t.Errorf("effect: got %s, want ask", res.Effect)
	}
	if res.Ceiling == nil || *res.Ceiling != EffectNotify {
		t.Errorf("ceiling: got %v, want notify", res.Ceiling)
	}
	if res.Floor != EffectAsk {
		t.Errorf("floor: got %s, want ask", res.Floor)
	}
	if res.FloorLayer != "org" {
		t.Errorf("floor_layer: got %s, want org", res.FloorLayer)
	}
}

func TestARepoFloorCanRaiseAnOrgFloorButNotLowerIt(t *testing.T) {
	policy := testLayers(t,
		[2]string{"org", "[floor]\nrung2 = \"context\"\n"},
		[2]string{"repo", "[floor]\nrung2 = \"silent\"\n"},
		[2]string{"user", "[effects]\nrung2 = \"silent\"\n"},
	)
	if got := policy.Resolve(2, anyPath, false).Effect; got != EffectContext {
		t.Errorf("got %s, want context (a lower floor cannot lower a higher one)", got)
	}

	raised := testLayers(t,
		[2]string{"org", "[floor]\nrung2 = \"context\"\n"},
		[2]string{"repo", "[floor]\nrung2 = \"deny\"\n"},
		[2]string{"user", "[effects]\nrung2 = \"silent\"\n"},
	)
	res := raised.Resolve(2, anyPath, false)
	if res.Effect != EffectDeny {
		t.Errorf("got %s, want deny", res.Effect)
	}
	if res.FloorLayer != "repo" {
		t.Errorf("got floor_layer %s, want repo", res.FloorLayer)
	}
}

func TestAFloorCanBeScopedToAPath(t *testing.T) {
	policy := testLayers(t,
		[2]string{"repo", `
[floor]
rung3 = "notify"

[[floor.path]]
match = "src/payments/**"
rung3 = "deny"
`},
		[2]string{"user", "[effects]\nrung3 = \"silent\"\n"},
	)
	if got := policy.Resolve(3, "src/payments/charge.py", false).Effect; got != EffectDeny {
		t.Errorf("got %s, want deny", got)
	}
	if got := policy.Resolve(3, "src/app.py", false).Effect; got != EffectNotify {
		t.Errorf("got %s, want notify", got)
	}
}

func TestAFloorOutsideOrgAndRepoParsesWarnsAndIsIgnored(t *testing.T) {
	for _, where := range []string{"user", "session"} {
		layer := parseLayer("[floor]\nrung3 = \"deny\"\n", layerName(where), "<x>")
		found := false
		for _, p := range layer.problems {
			if strings.Contains(p, "floor") {
				found = true
			}
		}
		if !found {
			t.Errorf("%s: expected a floor-ignored problem, got %v", where, layer.problems)
		}
		policy := testLayers(t, [2]string{where, "[floor]\nrung3 = \"deny\"\n[effects]\nrung3 = \"silent\"\n"})
		if got := policy.Resolve(3, anyPath, false).Effect; got != builtinFloor[3] {
			t.Errorf("%s: got %s, want builtin floor %s", where, got, builtinFloor[3])
		}
	}
}

func TestAskBecomesDenyWhenNobodyIsWatching(t *testing.T) {
	policy := testLayers(t, [2]string{"user", "[effects]\nrung3 = \"ask\"\n"})
	if got := policy.Resolve(3, anyPath, false).Effect; got != EffectAsk {
		t.Errorf("attended: got %s, want ask", got)
	}
	res := policy.Resolve(3, anyPath, true)
	if res.Effect != EffectDeny {
		t.Errorf("unattended: got %s, want deny", res.Effect)
	}
	if !res.UnattendedPromoted {
		t.Errorf("expected UnattendedPromoted")
	}
}

func TestNothingElseIsPromotedByBeingUnattended(t *testing.T) {
	for _, effect := range []Effect{EffectSilent, EffectNotify, EffectContext, EffectDeny} {
		policy := testLayers(t, [2]string{"user", "[effects]\nrung2 = \"" + string(effect) + "\"\n"})
		attended := policy.Resolve(2, anyPath, false).Effect
		unattended := policy.Resolve(2, anyPath, true).Effect
		if attended != unattended {
			t.Errorf("%s: attended=%s unattended=%s, expected equal", effect, attended, unattended)
		}
	}
}

func TestTheDigestMovesWhenARuleChangesAndNotOtherwise(t *testing.T) {
	one := testLayers(t, [2]string{"user", "[effects]\nrung3 = \"ask\"\n"})
	same := testLayers(t, [2]string{"user", "[effects]\nrung3 = \"ask\"\n"})
	other := testLayers(t, [2]string{"user", "[effects]\nrung3 = \"deny\"\n"})
	if one.Digest != same.Digest {
		t.Errorf("expected identical policies to have identical digests")
	}
	if one.Digest == other.Digest {
		t.Errorf("expected a changed rule to change the digest")
	}
}

func TestAnExactFilenameGlobBeatsADirectoryGlob(t *testing.T) {
	policy := testLayers(t, [2]string{"user", `
[[path]]
match = "**/pay.py"
rung3 = "deny"

[[path]]
match = "vendor/**"
rung3 = "silent"
`})
	if got := policy.Resolve(3, "vendor/pay.py", false).Effect; got != EffectDeny {
		t.Errorf("got %s, want deny — a pinned filename must beat a directory glob regardless of file order", got)
	}
}

func TestAnOpaquePathCannotMatchAGlobSoTheStrictestRuleStands(t *testing.T) {
	policy := testLayers(t, [2]string{"user", `
[[path]]
match = "src/**"
rung2 = "silent"

[[path]]
match = "docs/**"
rung2 = "deny"
`})
	hashed := "de56cd6b6439220c"
	res := policy.Resolve(2, hashed, false)
	if res.Effect != EffectDeny {
		t.Errorf("got %s, want deny (the strictest rule that could apply)", res.Effect)
	}
	found := false
	for _, p := range res.Problems {
		if strings.Contains(p, "opaque") {
			found = true
		}
	}
	if !found {
		t.Errorf("expected an opaque-path problem, got %v", res.Problems)
	}
}

func TestAnOpaquePathStillGetsTheBlanketAnswerWhenNoRuleIsLouder(t *testing.T) {
	policy := testLayers(t, [2]string{"repo", `
[[path]]
match = "docs/**"
rung2 = "silent"
`})
	if got := policy.Resolve(2, "de56cd6b6439220c", false).Effect; got != builtinTable[2] {
		t.Errorf("got %s, want builtin %s", got, builtinTable[2])
	}
}

func TestAnOrgFloorSurvivesBothShapes(t *testing.T) {
	policy := testLayers(t, [2]string{"org", `
[[floor.path]]
match = "src/pay.py"
rung3 = "deny"
`})
	if got := policy.floorTable("src/pay.py").names()[3]; got != "deny" {
		t.Errorf("relative: got %s, want deny", got)
	}
	if got := policy.floorTable("/Users/sara/work/myrepo/src/pay.py").names()[3]; got != "deny" {
		t.Errorf("absolute: got %s, want deny", got)
	}
	if got := policy.floorTable("de56cd6b6439220c").names()[3]; got != "deny" {
		t.Errorf("opaque: got %s, want deny", got)
	}
	if got := policy.floorTable("/Users/sara/work/myrepo/src/api.py").names()[3]; got != string(builtinFloor[3]) {
		t.Errorf("untouched file: got %s, want builtin floor %s", got, builtinFloor[3])
	}
}

func TestARelayStackIsBuiltinPlusOrgOnly(t *testing.T) {
	dir := t.TempDir()
	org := filepath.Join(dir, "org.toml")
	if err := os.WriteFile(org, []byte("[floor]\nrung2 = \"context\"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("AGENT_PRESENCE_ORG_POLICY", org)

	pf := NewPolicyFileForRelay(NewVirtualClock(0))
	policy := pf.Current()

	names := map[layerName]bool{}
	for _, l := range policy.Layers {
		names[l.name] = true
	}
	if len(names) != 2 || !names["builtin"] || !names["org"] {
		t.Errorf("expected exactly builtin+org, got %v", names)
	}
	if got := policy.floorTable(anyPath)[2]; got != EffectContext {
		t.Errorf("got %s, want context", got)
	}
}

func TestEditingTheOrgFileTakesEffectWithoutARestart(t *testing.T) {
	dir := t.TempDir()
	org := filepath.Join(dir, "org.toml")
	if err := os.WriteFile(org, []byte("[effects]\nrung3 = \"ask\"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("AGENT_PRESENCE_ORG_POLICY", org)

	clock := NewVirtualClock(0)
	pf := NewPolicyFileForRelay(clock)
	if got := pf.Current().Resolve(3, anyPath, false).Effect; got != EffectAsk {
		t.Fatalf("got %s, want ask", got)
	}

	if err := os.WriteFile(org, []byte("[effects]\nrung3 = \"context\"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	clock.Advance(2.0)
	if got := pf.Current().Resolve(3, anyPath, false).Effect; got != EffectContext {
		t.Fatalf("got %s, want context after the edit", got)
	}
}

func TestOrgFileNotRestattedOnEveryCall(t *testing.T) {
	dir := t.TempDir()
	org := filepath.Join(dir, "org.toml")
	if err := os.WriteFile(org, []byte("[effects]\nrung3 = \"ask\"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("AGENT_PRESENCE_ORG_POLICY", org)

	clock := NewVirtualClock(0)
	pf := NewPolicyFileForRelay(clock)
	first := pf.Current()

	if err := os.WriteFile(org, []byte("[effects]\nrung3 = \"context\"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// Inside the recheck window: the edit is real but nothing has looked yet.
	second := pf.Current()
	if second.Digest != first.Digest {
		t.Fatalf("expected the cached policy inside the recheck window, got a different digest")
	}
}

func TestOrgFileThatStopsParsingKeepsTheLastGoodTable(t *testing.T) {
	dir := t.TempDir()
	org := filepath.Join(dir, "org.toml")
	if err := os.WriteFile(org, []byte("[effects]\nrung3 = \"ask\"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("AGENT_PRESENCE_ORG_POLICY", org)

	clock := NewVirtualClock(0)
	pf := NewPolicyFileForRelay(clock)
	if got := pf.Current().Resolve(3, anyPath, false).Effect; got != EffectAsk {
		t.Fatalf("got %s, want ask", got)
	}

	if err := os.WriteFile(org, []byte("this is not [ toml"), 0o644); err != nil {
		t.Fatal(err)
	}
	clock.Advance(2.0)
	broken := pf.Current()
	if got := broken.Resolve(3, anyPath, false).Effect; got != EffectAsk {
		t.Fatalf("protection was silently dropped: got %s, want ask (the last good table)", got)
	}
	if !broken.Degraded {
		t.Fatalf("expected degraded=true")
	}
	if len(broken.Problems) == 0 {
		t.Fatalf("a degradation with nothing to say is not loud")
	}
}

func TestOrgFileThatStartsBrokenFallsBackToBuiltinAndSaysSo(t *testing.T) {
	dir := t.TempDir()
	org := filepath.Join(dir, "org.toml")
	if err := os.WriteFile(org, []byte("this is not [ toml"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("AGENT_PRESENCE_ORG_POLICY", org)

	pf := NewPolicyFileForRelay(NewVirtualClock(0))
	policy := pf.Current()
	if got := policy.Resolve(3, anyPath, false).Effect; got != builtinTable[3] {
		t.Fatalf("got %s, want builtin %s", got, builtinTable[3])
	}
	if !policy.Degraded {
		t.Fatalf("expected degraded=true")
	}
}

func TestOrgFileDeletedFallsBackWithoutPretendingItIsFine(t *testing.T) {
	dir := t.TempDir()
	org := filepath.Join(dir, "org.toml")
	if err := os.WriteFile(org, []byte("[effects]\nrung3 = \"context\"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("AGENT_PRESENCE_ORG_POLICY", org)

	clock := NewVirtualClock(0)
	pf := NewPolicyFileForRelay(clock)
	if got := pf.Current().Resolve(3, anyPath, false).Effect; got != EffectContext {
		t.Fatalf("got %s, want context", got)
	}

	if err := os.Remove(org); err != nil {
		t.Fatal(err)
	}
	clock.Advance(2.0)
	policy := pf.Current()
	if got := policy.Resolve(3, anyPath, false).Effect; got != builtinTable[3] {
		t.Fatalf("got %s, want builtin %s", got, builtinTable[3])
	}
	if policy.Degraded {
		t.Fatalf("an absent file is the documented default, not a degradation")
	}
}

func TestNoOrgFileMeansNoPolicyFrame(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("AGENT_PRESENCE_ORG_POLICY", filepath.Join(dir, "does-not-exist.toml"))
	relay := NewRelay(NewVirtualClock(0), InertRoster())
	if frame := relay.policyFrame(); frame != nil {
		t.Fatalf("expected no policy frame with no org file, got %+v", frame)
	}
}
