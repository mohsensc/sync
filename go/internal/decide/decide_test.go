package decide

import (
	"testing"

	"github.com/mohsensc/sync/go/internal/leases"
	"github.com/mohsensc/sync/go/internal/policy"
)

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
	if resp.HandoverInMs != 5_000 || resp.HandoverTo != "other" || resp.Waiting != 1 {
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
	if resp.LostTo != "sara" || resp.LostToAgent != "other" || resp.LostMsAgo != 1_000 {
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
