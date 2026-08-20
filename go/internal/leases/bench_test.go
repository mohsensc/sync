package leases

import (
	"fmt"
	"testing"
)

// setupBench seeds n leases across paths, roughly matching the daemon's
// real shape: several agents, several files each.
func setupBench(n int) *Cache {
	c := New()
	entries := make(map[string]Lease, n)
	for i := 0; i < n; i++ {
		path := fmt.Sprintf("src/pkg%d/mod%d.py", i%40, i%25)
		agent := fmt.Sprintf("agent-%d", i%40)
		entries[RegionKey(path, "")] = Lease{Agent: agent, ExpiresAtMs: 9_000_000_000_000}
	}
	c.Replace(entries)
	return c
}

// BenchmarkConflictConcurrentReads is the decision hot path: many
// goroutines calling Conflict concurrently, with one background writer
// doing what the relay pump does (Upsert on a live lease). This is the
// shape #20 asks to measure before/after any change to leases.Cache.
func BenchmarkConflictConcurrentReads(b *testing.B) {
	c := setupBench(1000)
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		i := 0
		for {
			select {
			case <-stop:
				return
			default:
				path := fmt.Sprintf("src/pkg%d/mod%d.py", i%40, i%25)
				c.Upsert(RegionKey(path, ""), Lease{Agent: "writer", ExpiresAtMs: 9_000_000_000_000}, 0)
				i++
			}
		}
	}()

	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		i := 0
		for pb.Next() {
			path := fmt.Sprintf("src/pkg%d/mod%d.py", i%40, i%25)
			c.Conflict(path, []string{"me"}, 0)
			i++
		}
	})
}

// BenchmarkUpsertSustainedAboveFloor is the #89-vs-cooldown check: a table
// that stays above pruneFloor for good — leases keep expiring and getting
// renewed on a fixed set of paths, so the table churns instead of settling
// back under the floor the way BenchmarkConflictConcurrentReads's fixed
// 1,000-path table does. That's the shape #89 is actually about: garbage
// arriving as fast as it's collected. Without sweepCooldownMs this is a
// full O(n) scan under the write lock on every single Upsert — measured
// ~17.3µs/op sustained before the cooldown existed. With it, per-op cost
// should sit close to BenchmarkUpsertBelowFloor's number, since the
// cooldown skips the scan on all but a small fraction of writes, and each
// scan it does run only walks this benchmark's bounded table instead of
// one that grew without limit.
func BenchmarkUpsertSustainedAboveFloor(b *testing.B) {
	const pathCount = pruneFloor + 500
	c := setupBench(pathCount)
	nowMs := int64(0)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		nowMs++
		path := fmt.Sprintf("src/pkg%d/mod%d.py", i%pathCount, i%pathCount)
		// Short-lived on purpose: by the time a sweep actually runs
		// (gated by sweepCooldownMs), a chunk of the table has expired
		// and is real work for it to reclaim, not a no-op scan.
		c.Upsert(RegionKey(path, ""), Lease{Agent: "writer", ExpiresAtMs: nowMs + 500}, nowMs)
	}
}

// BenchmarkUpsertBelowFloor is the baseline BenchmarkUpsertSustainedAboveFloor
// is judged against: a table that never crosses pruneFloor, so Upsert never
// even reaches the cooldown check.
func BenchmarkUpsertBelowFloor(b *testing.B) {
	c := setupBench(100)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		path := fmt.Sprintf("src/pkg%d/mod%d.py", i%40, i%25)
		c.Upsert(RegionKey(path, ""), Lease{Agent: "writer", ExpiresAtMs: 9_000_000_000_000}, 0)
	}
}
