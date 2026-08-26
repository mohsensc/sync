package decide

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/mohsensc/sync/go/internal/leases"
	"github.com/mohsensc/sync/go/internal/policy"
	"github.com/mohsensc/sync/go/internal/wire"
)

func deref(p *int64) int64 {
	if p == nil {
		return -1
	}
	return *p
}

func TestDecideRung0WhenNoConflict(t *testing.T) {
	c := leases.New()
	resp := Decide(Request{Verb: "edit", Path: "a.py", Agent: "sess1"}, c, policy.New(), 0, "", "")
	if resp.Rung != 0 || resp.Effect != "silent" {
		t.Fatalf("got %+v", resp)
	}
	if BlockedByLease(resp) {
		t.Fatal("rung 0 must never be reported as blocked")
	}
}

func TestDecideRung3OnConflict(t *testing.T) {
	c := leases.New()
	c.Upsert(leases.RegionKey("a.py", ""), leases.Lease{Agent: "other", Human: "sara", ExpiresAtMs: 90_000}, 0)

	resp := Decide(Request{Verb: "edit", Path: "a.py", Agent: "sess1"}, c, policy.New(), 0, "", "")
	if resp.Rung != 3 || resp.Effect != "deny" {
		t.Fatalf("got %+v", resp)
	}
	if resp.Holder != "other" || resp.Human != "sara" {
		t.Fatalf("got %+v", resp)
	}
	if !BlockedByLease(resp) {
		t.Fatal("rung 3 must be reported as blocked")
	}
}

func TestDecideNonEditNeverBlocks(t *testing.T) {
	c := leases.New()
	c.Upsert(leases.RegionKey("a.py", ""), leases.Lease{Agent: "other", ExpiresAtMs: 90_000}, 0)
	resp := Decide(Request{Verb: "read", Path: "a.py", Agent: "sess1"}, c, policy.New(), 0, "", "")
	if resp.Rung != 0 {
		t.Fatalf("got %+v", resp)
	}
}

func TestDecideUsesSelfAgentOverRequestAgent(t *testing.T) {
	// The lease is held by "room-agent" — the same id the request's own
	// hook-session "agent" field would collide with if self_agent were
	// ignored. See decide.hpp's note on why these are different namespaces.
	c := leases.New()
	c.Upsert(leases.RegionKey("a.py", ""), leases.Lease{Agent: "room-agent", ExpiresAtMs: 90_000}, 0)

	resp := Decide(Request{Verb: "edit", Path: "a.py", Agent: "room-agent"}, c, policy.New(), 0, "room-agent", "")
	if resp.Rung != 0 {
		t.Fatalf("self agent's own lease must not block itself: %+v", resp)
	}
}

func TestDecideOwnHandoverRidesOnRung0(t *testing.T) {
	c := leases.New()
	c.Upsert(leases.RegionKey("a.py", ""), leases.Lease{
		Agent: "me", ExpiresAtMs: 90_000, HasHandover: true, HandoverAtMs: 5_000, HandoverTo: "other", Waiting: 1,
	}, 0)
	resp := Decide(Request{Verb: "edit", Path: "a.py", Agent: "me"}, c, policy.New(), 0, "me", "")
	if resp.Rung != 0 {
		t.Fatalf("own handover must not block: %+v", resp)
	}
	if deref(resp.HandoverInMs) != 5_000 || resp.HandoverTo != "other" || resp.Waiting != 1 {
		t.Fatalf("got %+v", resp)
	}
}

func TestDecideLostRegionNoteRidesOnRung0(t *testing.T) {
	c := leases.New()
	c.NoteHandover("a.py", leases.HandoverNote{From: "me", To: "other", ToHuman: "sara", AtMs: 1_000})
	resp := Decide(Request{Verb: "edit", Path: "a.py", Agent: "me"}, c, policy.New(), 2_000, "me", "")
	if resp.Rung != 0 {
		t.Fatalf("got %+v", resp)
	}
	if resp.LostTo != "sara" || resp.LostToAgent != "other" || deref(resp.LostMsAgo) != 1_000 {
		t.Fatalf("got %+v", resp)
	}
}

func TestDecideBlockedCarriesHandoverToMe(t *testing.T) {
	c := leases.New()
	c.Upsert(leases.RegionKey("a.py", ""), leases.Lease{
		Agent: "other", ExpiresAtMs: 90_000, HasHandover: true, HandoverAtMs: 5_000, HandoverTo: "me",
	}, 0)
	resp := Decide(Request{Verb: "edit", Path: "a.py", Agent: "me"}, c, policy.New(), 0, "me", "")
	if resp.Rung != 3 || !resp.HandoverToMe {
		t.Fatalf("got %+v", resp)
	}
}

func TestDecideRespectsPolicyFloor(t *testing.T) {
	pol := policy.New()
	pol.SetFloor(policy.Table{policy.Deny, policy.Deny, policy.Deny, policy.Deny, policy.Deny}, "org")
	resp := Decide(Request{Verb: "edit", Path: "a.py", Agent: "sess1"}, leases.New(), pol, 0, "", "")
	if resp.Effect != "deny" {
		t.Fatalf("org floor must win: got %+v", resp)
	}
}

func TestEventFrameEmptyOnMissingFields(t *testing.T) {
	if f := EventFrame(Request{Verb: "edit"}, ""); f != nil {
		t.Fatalf("expected nil for missing path, got %s", f)
	}
	if f := EventFrame(Request{Path: "a.py"}, ""); f != nil {
		t.Fatalf("expected nil for missing verb, got %s", f)
	}
}

func TestEventFrameShape(t *testing.T) {
	f := EventFrame(Request{Verb: "edit", Path: "a.py", Agent: "sess1", Human: "mohsen"}, "")
	got := string(f)
	want := `{"type":"event","source":"hook","verb":"edit","agent":"sess1","human":"mohsen","region":{"path":"a.py","symbol":null,"lines":null}}`
	if got != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
}

func TestParseRequestNeverErrors(t *testing.T) {
	// Garbage input decodes to a zero Request, never a crash — mirrors
	// json_field's forgiving behavior on the C++ side.
	r := ParseRequest([]byte("not json"))
	if r.Verb != "" || r.Path != "" {
		t.Fatalf("got %+v", r)
	}
}

// A handover that happened this exact millisecond must still put
// "lost_ms_ago":0 on the wire, not omit the field — decide.cpp's
// append_number is unconditional whenever append_lost runs, and hook.cpp
// reads a missing field as "the daemon didn't say" rather than "just now".
// A plain int64 with `omitempty` would drop a genuine zero the same way it
// drops an absent field; this pins that ExpiresInMs/HandoverInMs/LostMsAgo
// stay *int64 so the two cases can't collapse into each other.
func TestZeroLostMsAgoStillSerializes(t *testing.T) {
	c := leases.New()
	c.NoteHandover("a.py", leases.HandoverNote{From: "me", To: "other", AtMs: 1_000})
	resp := Decide(Request{Verb: "edit", Path: "a.py", Agent: "me"}, c, policy.New(), 1_000, "me", "")
	if resp.Rung != 0 {
		t.Fatalf("got %+v", resp)
	}
	if resp.LostMsAgo == nil || *resp.LostMsAgo != 0 {
		t.Fatalf("lost_ms_ago must be a present zero, not nil: %+v", resp)
	}
	out, err := json.Marshal(resp)
	if err != nil {
		t.Fatal(err)
	}
	if got := string(out); !strings.Contains(got, `"lost_ms_ago":0`) {
		t.Fatalf("lost_ms_ago:0 missing from the wire: %s", got)
	}
}

func TestAbsentExpiresInMsOmittedOnRung0(t *testing.T) {
	resp := Decide(Request{Verb: "edit", Path: "a.py", Agent: "me"}, leases.New(), policy.New(), 0, "me", "")
	if resp.ExpiresInMs != nil {
		t.Fatalf("rung 0 must never carry expires_in_ms: %+v", resp)
	}
	out, _ := json.Marshal(resp)
	if strings.Contains(string(out), `"expires_in_ms"`) {
		t.Fatalf("expires_in_ms must be absent, not present: %s", out)
	}
}

// --- rung 2: same file, disjoint symbols --------------------------------

// TestDecideRung2WhenBothSymbolsAreKnownAndDisjoint is the issue's own
// repro, done right: "me" has already declared its own scope on
// "sign_out" through MCP (a claim_work claim, which is a lease exactly
// like any other in this cache) before the hook asks about an edit to the
// file. "other" holds "sign_in". Neither the request nor the hook ever
// says which symbol this specific edit touches, so this claim is the only
// evidence there is.
func TestDecideRung2WhenBothSymbolsAreKnownAndDisjoint(t *testing.T) {
	c := leases.New()
	c.Upsert(leases.RegionKey("auth.py", "sign_out"),
		leases.Lease{Agent: "me", Symbol: "sign_out", ExpiresAtMs: 90_000}, 0)
	c.Upsert(leases.RegionKey("auth.py", "sign_in"),
		leases.Lease{Agent: "other", Human: "sara", Intent: "move session handling to JWT",
			Symbol: "sign_in", ExpiresAtMs: 90_000}, 0)

	resp := Decide(Request{Verb: "edit", Path: "auth.py", Agent: "me"}, c, policy.New(), 0, "me", "")
	if resp.Rung != 2 || resp.Effect != "context" {
		t.Fatalf("got %+v", resp)
	}
	if resp.Holder != "other" || resp.Human != "sara" || resp.Intent != "move session handling to JWT" {
		t.Fatalf("got %+v", resp)
	}
	if resp.Decision != "" {
		t.Fatalf("rung 2 must never carry the legacy ask decision: %+v", resp)
	}
	if BlockedByLease(resp) {
		t.Fatal("rung 2 must never be reported as blocked — nothing here waits on a handover")
	}
}

// TestDecideStaysRung3WithoutMyOwnClaim is the precedence case: the same
// file, the same "other" holder on "sign_in", but "me" never declared a
// symbol of its own. There is no evidence this edit is disjoint from
// theirs, so rung 2 must not fire on a guess — the neighbour, rung 3,
// wins. This is the scenario the issue's literal repro describes if read
// as "B just edits the file", and it is deliberately still rung 3: a rung
// that fires on the wrong evidence is worse than one that never fires.
func TestDecideStaysRung3WithoutMyOwnClaim(t *testing.T) {
	c := leases.New()
	c.Upsert(leases.RegionKey("auth.py", "sign_in"),
		leases.Lease{Agent: "other", Human: "sara", Symbol: "sign_in", ExpiresAtMs: 90_000}, 0)

	resp := Decide(Request{Verb: "edit", Path: "auth.py", Agent: "me"}, c, policy.New(), 0, "me", "")
	if resp.Rung != 3 || resp.Effect != "deny" {
		t.Fatalf("got %+v, want rung 3 (no evidence of a disjoint symbol)", resp)
	}
	if !BlockedByLease(resp) {
		t.Fatal("rung 3 must be reported as blocked")
	}
}

// TestDecideRung3WinsOverRung2AmongSeveralHolders: two other agents hold
// leases on the same file, one disjoint from "me" and one on the same
// symbol. The real conflict must win — a rung 2 answer here would tell
// "me" it is safe to proceed while a genuine same-symbol collision sits
// right next to it.
func TestDecideRung3WinsOverRung2AmongSeveralHolders(t *testing.T) {
	c := leases.New()
	c.Upsert(leases.RegionKey("auth.py", "sign_out"),
		leases.Lease{Agent: "me", Symbol: "sign_out", ExpiresAtMs: 90_000}, 0)
	c.Upsert(leases.RegionKey("auth.py", "sign_in"),
		leases.Lease{Agent: "other-a", Symbol: "sign_in", ExpiresAtMs: 90_000}, 0)
	c.Upsert(leases.RegionKey("auth.py", "sign_out")+"#2",
		leases.Lease{Agent: "other-b", Symbol: "sign_out", ExpiresAtMs: 90_000}, 0)

	resp := Decide(Request{Verb: "edit", Path: "auth.py", Agent: "me"}, c, policy.New(), 0, "me", "")
	if resp.Rung != 3 {
		t.Fatalf("got %+v, want rung 3 to win over the disjoint rung-2 holder", resp)
	}
}

// TestDecideRung2RespectsPolicyEscalation: acceptance criterion 4 — a rung
// policy raises to ask or deny has to be honoured at every rung, not only
// at 3. Raising rung 2's floor to deny must actually block, and the
// resulting response must carry enough (holder, expiry) for hook.cpp's
// existing effect-driven rendering to say something coherent about it.
func TestDecideRung2RespectsPolicyEscalation(t *testing.T) {
	c := leases.New()
	c.Upsert(leases.RegionKey("auth.py", "sign_out"),
		leases.Lease{Agent: "me", Symbol: "sign_out", ExpiresAtMs: 90_000}, 0)
	c.Upsert(leases.RegionKey("auth.py", "sign_in"),
		leases.Lease{Agent: "other", Symbol: "sign_in", ExpiresAtMs: 90_000}, 0)

	pol := policy.New()
	pol.SetFloor(policy.Table{policy.Silent, policy.Silent, policy.Deny, policy.Silent, policy.Silent}, "org")

	resp := Decide(Request{Verb: "edit", Path: "auth.py", Agent: "me"}, c, policy.New(), 0, "me", "")
	if resp.Rung != 2 || resp.Effect != "context" {
		t.Fatalf("sanity check on the unescalated policy failed: %+v", resp)
	}

	resp = Decide(Request{Verb: "edit", Path: "auth.py", Agent: "me"}, c, pol, 0, "me", "")
	if resp.Rung != 2 || resp.Effect != "deny" {
		t.Fatalf("an org floor raising rung 2 to deny must be honoured: got %+v", resp)
	}
	if resp.ExpiresInMs == nil {
		t.Fatalf("an escalated rung 2 still needs expires_in_ms for the hook's blocked message: %+v", resp)
	}
}

// --- item 4: both handover target fields, not just handover_to ------------

func TestDecideBlockedCarriesFullHandoverTarget(t *testing.T) {
	c := leases.New()
	c.Upsert(leases.RegionKey("a.py", ""), leases.Lease{
		Agent: "other", ExpiresAtMs: 90_000, HasHandover: true, HandoverAtMs: 5_000,
		HandoverTo: "them", HandoverToHuman: "sara", HandoverToPriority: "elevated",
	}, 0)
	resp := Decide(Request{Verb: "edit", Path: "a.py", Agent: "me"}, c, policy.New(), 0, "me", "")
	if resp.HandoverToHuman != "sara" || resp.HandoverToPriority != "elevated" {
		t.Fatalf("got %+v, want handover_to_human and handover_to_priority carried through same as handover_to", resp)
	}
}

// --- item 2: a lease held by my own session, or by this daemon's own relay
// identity, must never read as a conflict against me ------------------------

func TestDecideOwnSessionLeaseNotBlocked(t *testing.T) {
	// The bug report verbatim: claim_work claims under the session id,
	// Decide used to check only the daemon's own relay identity, and the
	// same session that just claimed the region got denied editing it.
	c := leases.New()
	c.Upsert(leases.RegionKey("a.py", ""), leases.Lease{Agent: "sess-alice-1", ExpiresAtMs: 90_000}, 0)
	resp := Decide(Request{Verb: "edit", Path: "a.py", Agent: "sess-alice-1"}, c, policy.New(), 0, "presenced@host", "")
	if resp.Rung != 0 {
		t.Fatalf("a lease held under my own session id must not block me: got %+v", resp)
	}
}

func TestDecideOwnRelayIdentityLeaseNotBlocked(t *testing.T) {
	c := leases.New()
	c.Upsert(leases.RegionKey("a.py", ""), leases.Lease{Agent: "presenced@host", ExpiresAtMs: 90_000}, 0)
	resp := Decide(Request{Verb: "edit", Path: "a.py", Agent: "sess-alice-1"}, c, policy.New(), 0, "presenced@host", "")
	if resp.Rung != 0 {
		t.Fatalf("a lease held under this daemon's own relay identity must not block it either: got %+v", resp)
	}
}

func TestDecideThirdPartyLeaseStillBlocks(t *testing.T) {
	// The fix widens "mine" to two identities; it must not widen it to
	// everyone. A lease held by neither still has to deny.
	c := leases.New()
	c.Upsert(leases.RegionKey("a.py", ""), leases.Lease{Agent: "sess-bob-1", ExpiresAtMs: 90_000}, 0)
	resp := Decide(Request{Verb: "edit", Path: "a.py", Agent: "sess-alice-1"}, c, policy.New(), 0, "presenced@host", "")
	if resp.Rung != 3 || resp.Holder != "sess-bob-1" {
		t.Fatalf("a genuine third party's lease must still block: got %+v", resp)
	}
}

// --- review leftover #1: truncateUTF8 at the exact byte boundary, not just
// somewhere in a long string -------------------------------------------------
//
// The adversarial-lease test below only proves the Response as a whole
// survives; it doesn't pin truncateUTF8 itself against the one input that
// actually exercises its trimming loop — a multi-byte rune whose bytes
// straddle max. A plain s[:max] passes every case here that a naive test
// would think to write; only a cut mid-rune tells the two apart.
func TestTruncateUTF8(t *testing.T) {
	emoji := "\U0001F600" // 4 bytes: F0 9F 98 80
	han := "中"            // 3 bytes: E4 B8 AD
	eacute := "é"         // 2 bytes: C3 A9

	cases := []struct {
		name string
		s    string
		max  int
		want string
	}{
		{"under max, returned unchanged", "hi", 10, "hi"},
		{"exactly max, returned unchanged", "hello", 5, "hello"},
		{"pure ASCII, cut falls mid-string", "hello world", 5, "hello"},
		{"max is zero", "hello", 0, ""},

		// The cut lands exactly on a rune boundary — nothing to trim, and
		// the loop's ValidString check must not shave a byte it didn't
		// need to.
		{"cut exactly after a 3-byte rune", "ab" + han + "cd", 2 + len(han), "ab" + han},
		{"cut exactly after a 4-byte rune", "abc" + emoji + "de", 3 + len(emoji), "abc" + emoji},

		// The cut lands inside the rune — every possible split point of a
		// 4-byte rune, and the same for 3- and 2-byte runes. All of these
		// must drop the whole rune, not a mangled prefix of it.
		{"cut 1 byte into a 4-byte rune", "abc" + emoji + "de", 3 + 1, "abc"},
		{"cut 2 bytes into a 4-byte rune", "abc" + emoji + "de", 3 + 2, "abc"},
		{"cut 3 bytes into a 4-byte rune", "abc" + emoji + "de", 3 + 3, "abc"},
		{"cut 1 byte into a 3-byte rune", "ab" + han + "cd", 2 + 1, "ab"},
		{"cut 2 bytes into a 3-byte rune", "ab" + han + "cd", 2 + 2, "ab"},
		{"cut 1 byte into a 2-byte rune", "a" + eacute + "bc", 1 + 1, "a"},

		// The same split points again, this time at the two byte budgets
		// boundResponse actually uses, so a regression in either constant
		// is caught here and not just in the end-to-end Decide test.
		{"straddles maxNameBytes (64)", strings.Repeat("x", 62) + emoji + "tail", maxNameBytes, strings.Repeat("x", 62)},
		{"straddles maxIntentBytes (300)", strings.Repeat("z", 298) + emoji + "tail", maxIntentBytes, strings.Repeat("z", 298)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := truncateUTF8(tc.s, tc.max)
			if got != tc.want {
				t.Fatalf("truncateUTF8(%q, %d) = %q, want %q", tc.s, tc.max, got, tc.want)
			}
			if !utf8.ValidString(got) {
				t.Fatalf("truncateUTF8(%q, %d) = %q is not valid UTF-8", tc.s, tc.max, got)
			}
			if len(got) > tc.max {
				t.Fatalf("truncateUTF8(%q, %d) = %q is %d bytes, exceeds max %d", tc.s, tc.max, got, len(got), tc.max)
			}
		})
	}
}

// --- item 3: an adversarial lease can never make a Response reach the
// hook's 8192-byte reply cap -------------------------------------------------

func TestDecideResponseBoundedForAdversarialLease(t *testing.T) {
	// Not just "some multi-byte content somewhere in a long string" — a
	// 4-byte rune placed so the cut itself lands inside it. 62 ASCII bytes
	// put the emoji's first byte at index 62; maxNameBytes=64 then slices
	// after its 2nd byte (indices 62-63 kept, 64-65 dropped), which is
	// exactly the split a naive s[:max] gets wrong. A control character
	// and a 3-byte rune ride along after, past the cut, so this also still
	// covers "adversarial content exists elsewhere in the string".
	adversarial := strings.Repeat("x", 62) + "\U0001F600" + "\x01中" + strings.Repeat("y", 500)
	// Same idea at maxIntentBytes=300: 298 ASCII bytes put a second 4-byte
	// rune's first byte at index 298, so the 300-byte cut keeps 2 of its 4
	// bytes.
	adversarialIntent := strings.Repeat("z", 298) + "\U0001F601" + strings.Repeat("z", 8700)

	c := leases.New()
	c.Upsert(leases.RegionKey("a.py", ""), leases.Lease{
		Agent: adversarial, Human: adversarial, Intent: adversarialIntent,
		Priority: adversarial, ExpiresAtMs: 90_000,
		HasHandover: true, HandoverAtMs: 5_000,
		HandoverTo: adversarial, HandoverToHuman: adversarial, HandoverToPriority: adversarial,
	}, 0)
	c.NoteHandover("a.py", leases.HandoverNote{From: "me", To: adversarial, ToHuman: adversarial, ToPriority: adversarial, AtMs: 0})

	resp := Decide(Request{Verb: "edit", Path: "a.py", Agent: "me"}, c, policy.New(), 0, "", "")
	if resp.Rung != 3 {
		t.Fatalf("bounding must not change the rung: got %+v", resp)
	}

	for name, v := range map[string]string{
		"Holder": resp.Holder, "Human": resp.Human, "Intent": resp.Intent,
		"HolderPriority": resp.HolderPriority, "HandoverTo": resp.HandoverTo,
		"HandoverToHuman": resp.HandoverToHuman, "HandoverToPriority": resp.HandoverToPriority,
		"LostTo": resp.LostTo, "LostToAgent": resp.LostToAgent, "LostToPriority": resp.LostToPriority,
	} {
		if !utf8.ValidString(v) {
			t.Errorf("field %s is not valid UTF-8 after truncation: %q", name, v)
		}
	}

	out, err := json.Marshal(resp)
	if err != nil {
		t.Fatal(err)
	}
	if len(out) >= 8192 {
		t.Fatalf("response marshals to %d bytes, must stay well under the hook's 8192-byte reply cap: %s", len(out), out)
	}
}

// --- item 1: two checkouts of one repo must produce one region key, and a
// conflict found across them -------------------------------------------------

func TestDecideAndEventFrameUnifyTwoCheckoutsOfOneRepo(t *testing.T) {
	// The audit's own repro: carol and dan each have their own clone of
	// the same repo, at different absolute paths, and both edit
	// src/orders.py.
	carolRoot := "/Users/carol/work/repo"
	danRoot := "/Users/dan/dev/repo"

	// Carol's hook line becomes an outbound event, normalized against her
	// own root — this is what actually goes out on the wire and what a
	// lease gets filed under.
	frame := EventFrame(Request{Verb: "edit", Path: carolRoot + "/src/orders.py", Agent: "carol-sess"}, carolRoot)
	var ev wire.Event
	if err := json.Unmarshal(frame, &ev); err != nil {
		t.Fatalf("unmarshal event frame: %v", err)
	}
	if ev.Region.Path != "src/orders.py" {
		t.Fatalf("got region path %q, want the repo-relative form", ev.Region.Path)
	}

	c := leases.New()
	c.Upsert(leases.RegionKey(ev.Region.Path, ""), leases.Lease{Agent: "carol-sess", ExpiresAtMs: 90_000}, 0)

	// Dan edits "the same" file by his own absolute path, in his own
	// checkout. Decide has to normalize against his root before the
	// lookup finds carol's lease — an unnormalized query would sail past
	// it and answer rung 0, which was exactly the bug.
	resp := Decide(Request{Verb: "edit", Path: danRoot + "/src/orders.py", Agent: "dan-sess"}, c, policy.New(), 0, "", danRoot)
	if resp.Rung != 3 || resp.Holder != "carol-sess" {
		t.Fatalf("two checkouts of one repo did not collide: got %+v", resp)
	}
}

// --- review leftover #2: EffectForPath actually reaches the decision path,
// not just EffectFor -------------------------------------------------------
//
// policy.EffectForPath exists so a `[[path]]` rule can override the rung's
// blanket effect. Decide had the path in hand at both call sites that
// answer a real request (the conflict branch, and ambientResponse) and was
// discarding it in favor of the path-less EffectFor, so a per-path rule
// compiled into the cache could never fire on an actual decision — the
// defect EffectForPath's own doc comment says it exists to fix, one layer
// up, silently still open.

// pathScopedCache compiles a cache with one repo-layer rule on src/** —
// every test below needs that same glob, only the effects it fills differ.
func pathScopedCache(t *testing.T, effects string) *policy.Cache {
	t.Helper()
	dir := t.TempDir()
	p := filepath.Join(dir, "cache.json")
	content := `{"table":["silent","notify","context","deny","context"],` +
		`"rules":[{"match":"src/**","effects":` + effects + `,"layer":"repo"}]}`
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	c := policy.New()
	c.Refresh(p, 0)
	return c
}

func TestDecideConflictBranchHonorsPathRule(t *testing.T) {
	// Blanket rung-3 effect is deny (Builtin). A repo-layer rule softens
	// src/** to ask. Only a query against the real path can see it.
	pol := pathScopedCache(t, `["","","","ask",""]`)

	c := leases.New()
	c.Upsert(leases.RegionKey("src/pay.py", ""), leases.Lease{Agent: "other", ExpiresAtMs: 90_000}, 0)

	resp := Decide(Request{Verb: "edit", Path: "src/pay.py", Agent: "me"}, c, pol, 0, "", "")
	if resp.Rung != 3 {
		t.Fatalf("bounding must not change the rung: got %+v", resp)
	}
	if resp.Effect != "ask" {
		t.Fatalf("got effect %q, want the src/** rule's \"ask\" — EffectForPath never saw the real path", resp.Effect)
	}
}

func TestDecideConflictBranchPathRuleDoesNotLeakToUnmatchedPath(t *testing.T) {
	// The same rule must not fire for a path it doesn't cover — otherwise
	// the fix above could pass by accident (EffectFor(rung) with no path
	// ever consulted, always answering the blanket deny either way).
	pol := pathScopedCache(t, `["","","","ask",""]`)

	c := leases.New()
	c.Upsert(leases.RegionKey("docs/readme.md", ""), leases.Lease{Agent: "other", ExpiresAtMs: 90_000}, 0)

	resp := Decide(Request{Verb: "edit", Path: "docs/readme.md", Agent: "me"}, c, pol, 0, "", "")
	if resp.Effect != "deny" {
		t.Fatalf("got effect %q, want the blanket table's deny for a path src/** does not cover", resp.Effect)
	}
}

func TestDecideAmbientBranchHonorsPathRule(t *testing.T) {
	// Same wiring bug, the no-conflict path: rung 0 goes through
	// ambientResponse, which also had path in hand and wasn't using it.
	pol := pathScopedCache(t, `["notify","","","",""]`)

	resp := Decide(Request{Verb: "edit", Path: "src/pay.py", Agent: "me"}, leases.New(), pol, 0, "", "")
	if resp.Rung != 0 {
		t.Fatalf("no lease held, must be rung 0: got %+v", resp)
	}
	if resp.Effect != "notify" {
		t.Fatalf("got effect %q, want the src/** rule's \"notify\" — ambientResponse's EffectForPath never saw the real path", resp.Effect)
	}
}
