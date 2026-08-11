package leases

import "testing"

func TestConflictForFileMatchesWholeFilePrefix(t *testing.T) {
	c := New()
	c.Upsert(RegionKey("src/auth.py", "sign_in"), Lease{Agent: "other", ExpiresAtMs: 10_000})

	if _, ok := c.ConflictForFile("src/auth.py", "me", 0); !ok {
		t.Fatal("expected a conflict on a whole-file lookup against a symbol-scoped lease")
	}
	if _, ok := c.ConflictForFile("src/other.py", "me", 0); ok {
		t.Fatal("unexpected conflict on an unrelated file")
	}
}

func TestConflictForFileIgnoresOwnLease(t *testing.T) {
	c := New()
	c.Upsert(RegionKey("src/auth.py", ""), Lease{Agent: "me", ExpiresAtMs: 10_000})
	if _, ok := c.ConflictForFile("src/auth.py", "me", 0); ok {
		t.Fatal("own lease must never be reported as a conflict")
	}
}

func TestConflictForFileIgnoresExpired(t *testing.T) {
	c := New()
	c.Upsert(RegionKey("src/auth.py", ""), Lease{Agent: "other", ExpiresAtMs: 100})
	if _, ok := c.ConflictForFile("src/auth.py", "me", 200); ok {
		t.Fatal("expired lease must not block — it ages out, never wedges")
	}
}

func TestEraseIfHeldByRequiresMatchingAgent(t *testing.T) {
	c := New()
	key := RegionKey("src/auth.py", "")
	c.Upsert(key, Lease{Agent: "holder", ExpiresAtMs: 10_000})

	c.EraseIfHeldBy(key, "somebody-else")
	if _, ok := c.ConflictForFile("src/auth.py", "me", 0); !ok {
		t.Fatal("erase with the wrong agent must not delete a live lease")
	}

	c.EraseIfHeldBy(key, "holder")
	if _, ok := c.ConflictForFile("src/auth.py", "me", 0); ok {
		t.Fatal("erase with the matching agent must delete the lease")
	}
}

func TestReplaceSwapsWholeTable(t *testing.T) {
	c := New()
	c.Upsert(RegionKey("a.py", ""), Lease{Agent: "x", ExpiresAtMs: 10_000})
	c.Replace(map[string]Lease{
		RegionKey("b.py", ""): {Agent: "y", ExpiresAtMs: 10_000},
	})
	if _, ok := c.ConflictForFile("a.py", "me", 0); ok {
		t.Fatal("Replace must drop entries not in the new snapshot")
	}
	if _, ok := c.ConflictForFile("b.py", "me", 0); !ok {
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
