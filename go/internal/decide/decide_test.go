package decide

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/mohsensc/sync/go/internal/leases"
	"github.com/mohsensc/sync/go/internal/policy"
)

func deref(p *int64) int64 {
	if p == nil {
		return -1
	}
	return *p
}

func TestDecideRung0WhenNoConflict(t *testing.T) {
	c := leases.New()
	resp := Decide(Request{Verb: "edit", Path: "a.py", Agent: "sess1"}, c, policy.New(), 0, "")
	if resp.Rung != 0 || resp.Effect != "silent" {
		t.Fatalf("got %+v", resp)
	}
	if BlockedByLease(resp) {
		t.Fatal("rung 0 must never be reported as blocked")
	}
}

func TestDecideRung3OnConflict(t *testing.T) {
	c := leases.New()
	c.Upsert(leases.RegionKey("a.py", ""), leases.Lease{Agent: "other", Human: "sara", ExpiresAtMs: 90_000})

	resp := Decide(Request{Verb: "edit", Path: "a.py", Agent: "sess1"}, c, policy.New(), 0, "")
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
	c.Upsert(leases.RegionKey("a.py", ""), leases.Lease{Agent: "other", ExpiresAtMs: 90_000})
	resp := Decide(Request{Verb: "read", Path: "a.py", Agent: "sess1"}, c, policy.New(), 0, "")
	if resp.Rung != 0 {
		t.Fatalf("got %+v", resp)
	}
}

func TestDecideUsesSelfAgentOverRequestAgent(t *testing.T) {
	// The lease is held by "room-agent" — the same id the request's own
	// hook-session "agent" field would collide with if self_agent were
	// ignored. See decide.hpp's note on why these are different namespaces.
	c := leases.New()
	c.Upsert(leases.RegionKey("a.py", ""), leases.Lease{Agent: "room-agent", ExpiresAtMs: 90_000})

	resp := Decide(Request{Verb: "edit", Path: "a.py", Agent: "room-agent"}, c, policy.New(), 0, "room-agent")
	if resp.Rung != 0 {
		t.Fatalf("self agent's own lease must not block itself: %+v", resp)
	}
}

func TestDecideOwnHandoverRidesOnRung0(t *testing.T) {
	c := leases.New()
	c.Upsert(leases.RegionKey("a.py", ""), leases.Lease{
		Agent: "me", ExpiresAtMs: 90_000, HasHandover: true, HandoverAtMs: 5_000, HandoverTo: "other", Waiting: 1,
	})
	resp := Decide(Request{Verb: "edit", Path: "a.py", Agent: "me"}, c, policy.New(), 0, "me")
	if resp.Rung != 0 {
		t.Fatalf("own handover must not block: %+v", resp)
	}
	if deref(resp.HandoverInMs) != 5_000 || resp.HandoverTo != "other" || resp.Waiting != 1 {
		t.Fatalf("got %+v", resp)
	}
}

func TestDecideLostRegionNoteRidesOnRung0(t *testing.T) {
	c := leases.New()
	c.NoteHandover("a.py", leases.HandoverNote{To: "other", ToHuman: "sara", AtMs: 1_000})
	resp := Decide(Request{Verb: "edit", Path: "a.py", Agent: "me"}, c, policy.New(), 2_000, "me")
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
	})
	resp := Decide(Request{Verb: "edit", Path: "a.py", Agent: "me"}, c, policy.New(), 0, "me")
	if resp.Rung != 3 || !resp.HandoverToMe {
		t.Fatalf("got %+v", resp)
	}
}

func TestDecideRespectsPolicyFloor(t *testing.T) {
	pol := policy.New()
	pol.SetFloor(policy.Table{policy.Deny, policy.Deny, policy.Deny, policy.Deny, policy.Deny}, "org")
	resp := Decide(Request{Verb: "edit", Path: "a.py", Agent: "sess1"}, leases.New(), pol, 0, "")
	if resp.Effect != "deny" {
		t.Fatalf("org floor must win: got %+v", resp)
	}
}

func TestEventFrameEmptyOnMissingFields(t *testing.T) {
	if f := EventFrame(Request{Verb: "edit"}); f != nil {
		t.Fatalf("expected nil for missing path, got %s", f)
	}
	if f := EventFrame(Request{Path: "a.py"}); f != nil {
		t.Fatalf("expected nil for missing verb, got %s", f)
	}
}

func TestEventFrameShape(t *testing.T) {
	f := EventFrame(Request{Verb: "edit", Path: "a.py", Agent: "sess1", Human: "mohsen"})
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
	c.NoteHandover("a.py", leases.HandoverNote{To: "other", AtMs: 1_000})
	resp := Decide(Request{Verb: "edit", Path: "a.py", Agent: "me"}, c, policy.New(), 1_000, "me")
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
	resp := Decide(Request{Verb: "edit", Path: "a.py", Agent: "me"}, leases.New(), policy.New(), 0, "me")
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
		leases.Lease{Agent: "me", Symbol: "sign_out", ExpiresAtMs: 90_000})
	c.Upsert(leases.RegionKey("auth.py", "sign_in"),
		leases.Lease{Agent: "other", Human: "sara", Intent: "move session handling to JWT",
			Symbol: "sign_in", ExpiresAtMs: 90_000})

	resp := Decide(Request{Verb: "edit", Path: "auth.py", Agent: "me"}, c, policy.New(), 0, "me")
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
		leases.Lease{Agent: "other", Human: "sara", Symbol: "sign_in", ExpiresAtMs: 90_000})

	resp := Decide(Request{Verb: "edit", Path: "auth.py", Agent: "me"}, c, policy.New(), 0, "me")
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
		leases.Lease{Agent: "me", Symbol: "sign_out", ExpiresAtMs: 90_000})
	c.Upsert(leases.RegionKey("auth.py", "sign_in"),
		leases.Lease{Agent: "other-a", Symbol: "sign_in", ExpiresAtMs: 90_000})
	c.Upsert(leases.RegionKey("auth.py", "sign_out")+"#2",
		leases.Lease{Agent: "other-b", Symbol: "sign_out", ExpiresAtMs: 90_000})

	resp := Decide(Request{Verb: "edit", Path: "auth.py", Agent: "me"}, c, policy.New(), 0, "me")
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
		leases.Lease{Agent: "me", Symbol: "sign_out", ExpiresAtMs: 90_000})
	c.Upsert(leases.RegionKey("auth.py", "sign_in"),
		leases.Lease{Agent: "other", Symbol: "sign_in", ExpiresAtMs: 90_000})

	pol := policy.New()
	pol.SetFloor(policy.Table{policy.Silent, policy.Silent, policy.Deny, policy.Silent, policy.Silent}, "org")

	resp := Decide(Request{Verb: "edit", Path: "auth.py", Agent: "me"}, c, policy.New(), 0, "me")
	if resp.Rung != 2 || resp.Effect != "context" {
		t.Fatalf("sanity check on the unescalated policy failed: %+v", resp)
	}

	resp = Decide(Request{Verb: "edit", Path: "auth.py", Agent: "me"}, c, pol, 0, "me")
	if resp.Rung != 2 || resp.Effect != "deny" {
		t.Fatalf("an org floor raising rung 2 to deny must be honoured: got %+v", resp)
	}
	if resp.ExpiresInMs == nil {
		t.Fatalf("an escalated rung 2 still needs expires_in_ms for the hook's blocked message: %+v", resp)
	}
}
