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
