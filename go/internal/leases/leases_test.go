package leases

import "testing"

func TestConflictMatchesWholeFilePrefix(t *testing.T) {
	c := New()
	c.Upsert(RegionKey("src/auth.py", "sign_in"), Lease{Agent: "other", ExpiresAtMs: 10_000})

	if _, _, ok := c.Conflict("src/auth.py", "me", 0); !ok {
		t.Fatal("expected a conflict on a whole-file lookup against a symbol-scoped lease")
	}
	if _, _, ok := c.Conflict("src/other.py", "me", 0); ok {
		t.Fatal("unexpected conflict on an unrelated file")
	}
}

func TestConflictIgnoresOwnLease(t *testing.T) {
	c := New()
	c.Upsert(RegionKey("src/auth.py", ""), Lease{Agent: "me", ExpiresAtMs: 10_000})
	if _, _, ok := c.Conflict("src/auth.py", "me", 0); ok {
		t.Fatal("own lease must never be reported as a conflict")
	}
}

func TestConflictIgnoresExpired(t *testing.T) {
	c := New()
	c.Upsert(RegionKey("src/auth.py", ""), Lease{Agent: "other", ExpiresAtMs: 100})
	if _, _, ok := c.Conflict("src/auth.py", "me", 200); ok {
		t.Fatal("expired lease must not block — it ages out, never wedges")
	}
}

func TestEraseIfHeldByRequiresMatchingAgent(t *testing.T) {
	c := New()
	key := RegionKey("src/auth.py", "")
	c.Upsert(key, Lease{Agent: "holder", ExpiresAtMs: 10_000})

	c.EraseIfHeldBy(key, "somebody-else")
	if _, _, ok := c.Conflict("src/auth.py", "me", 0); !ok {
		t.Fatal("erase with the wrong agent must not delete a live lease")
	}

	c.EraseIfHeldBy(key, "holder")
	if _, _, ok := c.Conflict("src/auth.py", "me", 0); ok {
		t.Fatal("erase with the matching agent must delete the lease")
	}
}

func TestReplaceSwapsWholeTable(t *testing.T) {
	c := New()
	c.Upsert(RegionKey("a.py", ""), Lease{Agent: "x", ExpiresAtMs: 10_000})
	c.Replace(map[string]Lease{
		RegionKey("b.py", ""): {Agent: "y", ExpiresAtMs: 10_000},
	})
	if _, _, ok := c.Conflict("a.py", "me", 0); ok {
		t.Fatal("Replace must drop entries not in the new snapshot")
	}
	if _, _, ok := c.Conflict("b.py", "me", 0); !ok {
		t.Fatal("Replace must apply the new snapshot")
	}
}

func TestOwnHandoverReturnsSoonestDeadline(t *testing.T) {
	c := New()
	c.Upsert(RegionKey("a.py", "far"), Lease{
		Agent: "me", ExpiresAtMs: 10_000, HasHandover: true, HandoverAtMs: 9_000,
	})
	c.Upsert(RegionKey("a.py", "near"), Lease{
		Agent: "me", ExpiresAtMs: 10_000, HasHandover: true, HandoverAtMs: 2_000,
	})
	lease, ok := c.OwnHandover("a.py", "me", 0)
	if !ok || lease.HandoverAtMs != 2_000 {
		t.Fatalf("got %+v, ok=%v; want the nearer deadline", lease, ok)
	}
}

func TestOwnHandoverIgnoresOthersAndNoDeadline(t *testing.T) {
	c := New()
	c.Upsert(RegionKey("a.py", ""), Lease{Agent: "other", ExpiresAtMs: 10_000, HasHandover: true, HandoverAtMs: 1_000})
	c.Upsert(RegionKey("b.py", ""), Lease{Agent: "me", ExpiresAtMs: 10_000}) // no handover
	if _, ok := c.OwnHandover("a.py", "me", 0); ok {
		t.Fatal("must not report another agent's handover as our own")
	}
	if _, ok := c.OwnHandover("b.py", "me", 0); ok {
		t.Fatal("a lease with no handover deadline must not be reported")
	}
}

func TestOwnHandoverIgnoresExpiredLease(t *testing.T) {
	c := New()
	c.Upsert(RegionKey("a.py", ""), Lease{Agent: "me", ExpiresAtMs: 100, HasHandover: true, HandoverAtMs: 50})
	if _, ok := c.OwnHandover("a.py", "me", 200); ok {
		t.Fatal("an expired lease must not warn about a handover")
	}
}

func TestNoteHandoverAndHandoverNoteFor(t *testing.T) {
	c := New()
	c.NoteHandover("a.py", HandoverNote{To: "other", ToHuman: "sara", AtMs: 1_000})

	note, ok := c.HandoverNoteFor("a.py", 2_000, HandoverNoteMs)
	if !ok || note.To != "other" || note.ToHuman != "sara" {
		t.Fatalf("got %+v, ok=%v", note, ok)
	}

	if _, ok := c.HandoverNoteFor("b.py", 2_000, HandoverNoteMs); ok {
		t.Fatal("must not report a handover for an unrelated path")
	}
}

func TestHandoverNoteForExpiresAfterWithin(t *testing.T) {
	c := New()
	c.NoteHandover("a.py", HandoverNote{To: "other", AtMs: 0})
	if _, ok := c.HandoverNoteFor("a.py", HandoverNoteMs+1, HandoverNoteMs); ok {
		t.Fatal("a stale note past the horizon must not be reported")
	}
}

func TestNoteHandoverPrunesOldEntries(t *testing.T) {
	c := New()
	c.NoteHandover("old.py", HandoverNote{To: "x", AtMs: 0})
	// A new note far enough in the future to push "old.py" past the cutoff.
	c.NoteHandover("new.py", HandoverNote{To: "y", AtMs: HandoverNoteMs + 1000})

	if _, ok := c.HandoverNoteFor("old.py", HandoverNoteMs+1000, HandoverNoteMs); ok {
		t.Fatal("a note older than the horizon must be pruned on the next write")
	}
	if _, ok := c.HandoverNoteFor("new.py", HandoverNoteMs+1000, HandoverNoteMs); !ok {
		t.Fatal("the fresh note must survive")
	}
}

// --- rung 2 vs rung 3: same-symbol against disjoint-symbol -----------------

func TestConflictIsRung3WhenIHoldNoClaimOfMyOwn(t *testing.T) {
	// The common, hook-only case: I never declared a symbol through MCP,
	// so there is no evidence my edit is disjoint from theirs. Unproven
	// stays rung 3 — a rung firing on the wrong evidence is worse than one
	// that never fires.
	c := New()
	c.Upsert(RegionKey("auth.py", "sign_in"), Lease{Agent: "other", ExpiresAtMs: 10_000})

	_, rung, ok := c.Conflict("auth.py", "me", 0)
	if !ok || rung != 3 {
		t.Fatalf("got rung=%d ok=%v, want rung 3", rung, ok)
	}
}

func TestConflictIsRung2WhenSymbolsAreKnownAndDisjoint(t *testing.T) {
	// I hold my own claim on "sign_out"; they hold theirs on "sign_in".
	// That is the one case with real evidence of no overlap. Symbol has
	// to be set to match the key it's filed under — Conflict reads the
	// field, not the map key.
	c := New()
	c.Upsert(RegionKey("auth.py", "sign_out"), Lease{Agent: "me", Symbol: "sign_out", ExpiresAtMs: 10_000})
	c.Upsert(RegionKey("auth.py", "sign_in"), Lease{Agent: "other", Symbol: "sign_in", ExpiresAtMs: 10_000})

	held, rung, ok := c.Conflict("auth.py", "me", 0)
	if !ok || rung != 2 {
		t.Fatalf("got rung=%d ok=%v, want rung 2", rung, ok)
	}
	if held.Agent != "other" {
		t.Fatalf("got holder %q, want other", held.Agent)
	}
}

func TestConflictIsRung3WhenSymbolsMatch(t *testing.T) {
	c := New()
	c.Upsert(RegionKey("auth.py", "sign_in"), Lease{Agent: "me", Symbol: "sign_in", ExpiresAtMs: 10_000})
	c.Upsert(RegionKey("auth.py", "sign_in")+"#2", Lease{Agent: "other", Symbol: "sign_in", ExpiresAtMs: 10_000})

	_, rung, ok := c.Conflict("auth.py", "me", 0)
	if !ok || rung != 3 {
		t.Fatalf("got rung=%d ok=%v, want rung 3: the same symbol is a real overlap", rung, ok)
	}
}

func TestConflictIsRung3WhenEitherSideClaimedTheWholeFile(t *testing.T) {
	c := New()
	// They claimed the whole file (empty symbol) — that always overlaps.
	c.Upsert(RegionKey("auth.py", ""), Lease{Agent: "other", ExpiresAtMs: 10_000})
	c.Upsert(RegionKey("auth.py", "sign_out"), Lease{Agent: "me", Symbol: "sign_out", ExpiresAtMs: 10_000})

	_, rung, ok := c.Conflict("auth.py", "me", 0)
	if !ok || rung != 3 {
		t.Fatalf("a whole-file claim by the holder must always win rung 3: got rung=%d ok=%v", rung, ok)
	}
}

func TestConflictIsRung3WhenMyOwnClaimIsTheWholeFile(t *testing.T) {
	c := New()
	c.Upsert(RegionKey("auth.py", ""), Lease{Agent: "me", ExpiresAtMs: 10_000})
	c.Upsert(RegionKey("auth.py", "sign_in"), Lease{Agent: "other", Symbol: "sign_in", ExpiresAtMs: 10_000})

	_, rung, ok := c.Conflict("auth.py", "me", 0)
	if !ok || rung != 3 {
		t.Fatalf("my own whole-file claim must overlap every symbol: got rung=%d ok=%v", rung, ok)
	}
}

func TestConflictPicksTheHighestRungAmongSeveralHolders(t *testing.T) {
	// I hold "sign_out". One other agent holds the disjoint "sign_in"
	// (rung 2 on its own); a second holds "sign_out" too — the same
	// symbol as mine, a real rung 3. The worse of the two must win, the
	// same rule ladder.classify uses across every other activity.
	c := New()
	c.Upsert(RegionKey("auth.py", "sign_out"), Lease{Agent: "me", Symbol: "sign_out", ExpiresAtMs: 10_000})
	c.Upsert(RegionKey("auth.py", "sign_in"), Lease{Agent: "other-a", Symbol: "sign_in", ExpiresAtMs: 10_000})
	c.Upsert(RegionKey("auth.py", "sign_out")+"#2", Lease{Agent: "other-b", Symbol: "sign_out", ExpiresAtMs: 10_000})

	_, rung, ok := c.Conflict("auth.py", "me", 0)
	if !ok || rung != 3 {
		t.Fatalf("got rung=%d ok=%v, want the rung-3 holder to win over the rung-2 one", rung, ok)
	}
}

func TestSymbolsConflictTable(t *testing.T) {
	cases := []struct {
		held string
		mine []string
		want bool
	}{
		{held: "", mine: nil, want: true},
		{held: "sign_in", mine: nil, want: true},
		{held: "", mine: []string{"sign_out"}, want: true},
		{held: "sign_in", mine: []string{""}, want: true},
		{held: "sign_in", mine: []string{"sign_in"}, want: true},
		{held: "sign_in", mine: []string{"sign_out"}, want: false},
		{held: "sign_in", mine: []string{"sign_out", "sign_in"}, want: true},
	}
	for _, c := range cases {
		if got := symbolsConflict(c.held, c.mine); got != c.want {
			t.Errorf("symbolsConflict(%q, %v) = %v, want %v", c.held, c.mine, got, c.want)
		}
	}
}
