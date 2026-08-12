// Package relaysrv is the Go relay: the process leases, wait-die, the
// ladder, negotiation and fan-out all live in, speaking the same wire
// protocol python/src/agent_presence/serve.py and relay.py do. It is a
// separate package from internal/relay (the daemon's relay *client*) on
// purpose — that package dials out to a relay, this one is the relay.
package relaysrv

import (
	"sync"
	"time"
)

// Clock mirrors python's clock.Clock: everything time-dependent reads
// through it so the whole protocol is testable without real waiting.
type Clock interface {
	Now() float64 // seconds since epoch, float for sub-second precision
}

type RealClock struct{}

func (RealClock) Now() float64 {
	return float64(time.Now().UnixNano()) / 1e9
}

// VirtualClock is the test clock. Not used by the running relay binary; Go
// unit tests use it the way the Python suite uses clock.VirtualClock, to
// exercise TTL, handover and rate-limit behaviour without real waits.
//
// Mutex-guarded because it legitimately crosses goroutines in tests that
// exercise the real concurrent server plumbing (a background writer
// goroutine reading Now() via shedReason while the test goroutine calls
// Advance) — see backpressure_test.go. Every other test here stays
// single-threaded and pays a negligible uncontended-lock cost for it.
type VirtualClock struct {
	mu sync.Mutex
	t  float64
}

func NewVirtualClock(epoch float64) *VirtualClock {
	return &VirtualClock{t: epoch}
}

func (c *VirtualClock) Now() float64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *VirtualClock) Advance(seconds float64) {
	if seconds < 0 {
		panic("VirtualClock cannot move backwards")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t += seconds
}
