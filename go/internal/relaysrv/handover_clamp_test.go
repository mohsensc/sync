package relaysrv

import (
	"testing"

	"github.com/mohsensc/sync/go/internal/metrics"
)

// Issue #3 of the system-seams audit: a contended lease's handover_in_ms
// was computed straight off the fair-share grace period (contendLocked, up
// to FairShareGraceS = 900s) with nothing capping it to the holder's own
// remaining TTL. Reproduced: expires_in_ms 7143 alongside handover_in_ms
// 899595 on the same region — a promise the lease cannot possibly outlive,
// because when a junior contender's ask resolves as 'abort' the lease just
// expires on schedule and an unrelated agent can take the region before the
// promised handover ever arrives. The fix clamps handover_in_ms (never
// handover_at, and never the stored Claim — see clampedHandoverMs's doc
// comment) to the remaining TTL at the point each wire frame is built.

// TestRefusedClaimClampsHandoverToRemainingTTL drives the exact audit
// repro through onClaim: a holds the region near its natural expiry, a
// younger b contends and abort-resolves, and the claim_result reply must
// never promise a handover later than the lease itself can live.
func TestRefusedClaimClampsHandoverToRemainingTTL(t *testing.T) {
	clock := NewVirtualClock(1000.0)
	rel := NewRelay(clock, InertRoster(), metrics.New())
	a := &recorder{agent: "a1", human: "sara"}
	b := &recorder{agent: "a2", human: "dev"}
	rel.Join("r1", a)
	rel.Join("r1", b)

	claimRegion(rel, a, "src/pay.py")
	clock.Advance(LeaseTTLS - 7) // ~7s left before a's lease expires on its own
	reply := claimRegion(rel, b, "src/pay.py")

	if reply["granted"] != false {
		t.Fatalf("expected b's claim refused, got %+v", reply)
	}
	if reply["decision"] != "abort" {
		t.Fatalf("expected decision abort (b is younger than a), got %v", reply["decision"])
	}
	handoverMs, ok := reply["handover_in_ms"].(int)
	if !ok {
		t.Fatalf("expected a handover_in_ms on the refused reply, got %+v", reply)
	}
	expiresMs, ok := reply["expires_in_ms"].(int)
	if !ok {
		t.Fatalf("expected an expires_in_ms on the refused reply, got %+v", reply)
	}
	if handoverMs > expiresMs {
		t.Fatalf("handover_in_ms (%d) promises past the lease's own remaining TTL (%d): %+v", handoverMs, expiresMs, reply)
	}
}

// TestNegotiateReplyClampsHandoverToRemainingTTL is the same repro through
// onEvent's negotiate path, which computes handover_in_ms from the Brief
// rather than a Claim directly — a separate call site, needing the same fix.
func TestNegotiateReplyClampsHandoverToRemainingTTL(t *testing.T) {
	clock := NewVirtualClock(1000.0)
	rel := NewRelay(clock, InertRoster(), metrics.New())
	a := &recorder{agent: "a1", human: "sara"}
	b := &recorder{agent: "a2", human: "dev"}
	rel.Join("r1", a)
	rel.Join("r1", b)

	claimRegion(rel, a, "src/pay.py")
	clock.Advance(LeaseTTLS - 7) // ~7s left before a's lease expires on its own
	// Both touches land at the same instant so a's stays inside the
	// presence buffer's own (much shorter, 30s) freshness window — that
	// window is unrelated to the lease TTL this test is clamping against,
	// and advancing between them would let a's touch age out and hide the
	// rung 3 collision entirely.
	rel.Handle(a, map[string]any{"type": "event", "verb": "edit", "region": goldenRegion("src/pay.py", "")})
	reply := rel.Handle(b, map[string]any{"type": "event", "verb": "edit", "region": goldenRegion("src/pay.py", "")})

	if reply["type"] != "negotiate" {
		t.Fatalf("expected a negotiate reply, got %+v", reply)
	}
	handoverMs, ok := reply["handover_in_ms"].(int)
	if !ok {
		t.Fatalf("expected a handover_in_ms on the negotiate reply, got %+v", reply)
	}
	held := rel.registry.HolderOf("r1", Region{Path: "src/pay.py"}, nil)
	if held == nil {
		t.Fatalf("expected a's claim still live on src/pay.py")
	}
	wantMax := msRemaining(held.ExpiresAt, clock.Now())
	if handoverMs > wantMax {
		t.Fatalf("handover_in_ms (%d) promises past the lease's own remaining TTL (%d): %+v", handoverMs, wantMax, reply)
	}
}

// TestClampedHandoverMsNeverExceedsRemainingTTL pins the boundary directly:
// unchanged strictly before expiry, unchanged exactly at it, clamped for
// anything past it.
func TestClampedHandoverMsNeverExceedsRemainingTTL(t *testing.T) {
	const now = 1000.0
	cases := []struct {
		name                  string
		handoverAt, expiresAt float64
		want                  int
	}{
		{"handover well before expiry: untouched", now + 5, now + 90, 5000},
		{"handover exactly at expiry: unchanged", now + 90, now + 90, 90000},
		{"handover 1ms past expiry: clamped", now + 90.001, now + 90, 90000},
		{"handover far past expiry: clamped", now + 900, now + 7, 7000},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := clampedHandoverMs(c.handoverAt, c.expiresAt, now); got != c.want {
				t.Fatalf("clampedHandoverMs(%v, %v, now) = %d, want %d", c.handoverAt, c.expiresAt, got, c.want)
			}
		})
	}
}
