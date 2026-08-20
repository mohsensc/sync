package main

import (
	"net"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"testing"
	"time"

	"github.com/mohsensc/sync/go/internal/devproxy"
)

// TestNewArbiterLockSeedsItsOwnClaim is the regression test for the
// takeover race: a freshly-won arbiter must never serve an empty Lock. If
// it did, a third `pnpm dev` landing in the gap between the bind and the
// winner's own self-claim could claim into the empty lock and win — which
// is exactly how a forcer that never lost the bind still ended up refused
// by a process that never passed --force.
func TestNewArbiterLockSeedsItsOwnClaim(t *testing.T) {
	lock := newArbiterLock("winner", "featA", 111, 4001)

	arbiter := httptest.NewServer(devproxy.Handler(lock))
	defer arbiter.Close()

	client := devproxy.NewClient(arbiter.URL)

	// A third party racing in immediately after the bind must be refused
	// with the winner already on record as holder — not granted an empty
	// lock.
	_, err := client.Claim("third-party", "featB", 222, 4002, false)
	if err == nil {
		t.Fatal("a third-party claim right after the bind must be refused, lock was seeded")
	}
	refused, ok := err.(*devproxy.ErrRefused)
	if !ok {
		t.Fatalf("want *ErrRefused, got %T: %v", err, err)
	}
	if refused.Holder.Owner != "winner" || refused.Holder.PID != 111 {
		t.Fatalf("refusal must name the seeded self-claim as holder, got %+v", refused.Holder)
	}
}

// TestHeartbeatDetectsForcedEvictionPromptly exercises the arbiter side of
// the takeover fix: once this process is watching its own lease at
// arbiterHeartbeatEvery (passed in as interval here), a --force claim
// against it must be noticed and reported on lostLease within about one
// tick — not up to heartbeatEvery (20s) later.
func TestHeartbeatDetectsForcedEvictionPromptly(t *testing.T) {
	lock := devproxy.NewLock(90 * time.Second)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	srv := &http.Server{Handler: devproxy.Handler(lock)}
	go srv.Serve(ln)
	defer srv.Close()

	client := devproxy.NewClient("http://" + ln.Addr().String())
	if _, err := client.Claim("victim", "featA", 111, 4001, false); err != nil {
		t.Fatalf("setup claim: %v", err)
	}

	done := make(chan struct{})
	lost := make(chan devproxy.Holder, 1)
	fastInterval := 30 * time.Millisecond
	go heartbeat(client, "victim", "featA", 111, 4001, fastInterval, done, lost)
	defer close(done)

	time.Sleep(fastInterval / 2)
	if _, err := client.Claim("attacker", "featB", 222, 4002, true); err != nil {
		t.Fatalf("force claim: %v", err)
	}

	select {
	case holder := <-lost:
		if holder.Owner != "attacker" {
			t.Fatalf("want attacker as the evicting holder, got %+v", holder)
		}
	case <-time.After(20 * fastInterval):
		t.Fatal("forced-out holder did not notice eviction within a few ticks of interval")
	}
}

// TestStopViteEscalatesToSigkill proves the shutdown path is bounded: a
// child that ignores SIGTERM must still be gone (and the lease-release
// path unblocked) within grace, not the full 90s TTL.
func TestStopViteEscalatesToSigkill(t *testing.T) {
	vite := exec.Command("sh", "-c", "trap '' TERM; sleep 30")
	if err := vite.Start(); err != nil {
		t.Fatalf("start stub: %v", err)
	}

	viteDone := make(chan error, 1)
	go func() { viteDone <- vite.Wait() }()

	start := time.Now()
	const grace = 200 * time.Millisecond
	err := stopVite(vite, viteDone, grace)
	elapsed := time.Since(start)

	if elapsed > 2*grace {
		t.Fatalf("stopVite took %s, want bounded near grace (%s) via SIGKILL escalation", elapsed, grace)
	}
	if err == nil {
		t.Fatal("want a non-nil error: the child was killed, not a clean exit")
	}
}

// TestStopViteReturnsCleanlyOnSigterm proves the escalation path doesn't
// fire when the child exits promptly on SIGTERM — no gratuitous SIGKILL,
// no waiting out the full grace window either.
func TestStopViteReturnsCleanlyOnSigterm(t *testing.T) {
	vite := exec.Command("sleep", "30")
	if err := vite.Start(); err != nil {
		t.Fatalf("start stub: %v", err)
	}

	viteDone := make(chan error, 1)
	go func() { viteDone <- vite.Wait() }()

	start := time.Now()
	const grace = 2 * time.Second
	_ = stopVite(vite, viteDone, grace)
	elapsed := time.Since(start)

	if elapsed >= grace {
		t.Fatalf("stopVite waited %s, a SIGTERM-honoring child should exit well before grace (%s)", elapsed, grace)
	}
}
