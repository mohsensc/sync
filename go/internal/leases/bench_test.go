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
				c.Upsert(RegionKey(path, ""), Lease{Agent: "writer", ExpiresAtMs: 9_000_000_000_000})
				i++
			}
		}
	}()

	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		i := 0
		for pb.Next() {
			path := fmt.Sprintf("src/pkg%d/mod%d.py", i%40, i%25)
			c.Conflict(path, "me", 0)
			i++
		}
	})
}
