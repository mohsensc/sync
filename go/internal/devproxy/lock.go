// Package devproxy makes :5173 itself the lock. #61 and #62 both trace to
// the same hole: the old browser.lock was a file nobody's vite actually
// checked before binding --strictPort, so a lock only serialized worktrees
// that chose to honor it. A worktree can't rebind a socket someone else
// already holds — that part the kernel enforces for free. So one process
// per machine (the arbiter, see cmd/webdev) owns the real socket, and every
// worktree that wants to serve dev traffic goes through it instead of
// vite directly. Losing a claim is not negotiable: the caller either owns
// the lease or it does not touch the port.
package devproxy

import (
	"sync"
	"time"
)

// Holder describes whoever currently owns the dev-server lease: which
// worktree, which pid (so a stale claim can be told apart from a live
// renewal by the same process), and which local port its vite is actually
// listening on.
type Holder struct {
	Owner     string    `json:"owner"`
	Worktree  string    `json:"worktree"`
	PID       int       `json:"pid"`
	Port      int       `json:"port"`
	ExpiresAt time.Time `json:"expires_at"`
}

// isSame reports whether h and other identify the same running process —
// the thing that's allowed to renew its own lease without --force.
func (h Holder) isSame(owner, worktree string, pid int) bool {
	return h.Owner == owner && h.Worktree == worktree && h.PID == pid
}

// Lock is the arbiter's whole state: at most one live holder at a time.
// TTL, not a release call, is what actually frees the port — a killed
// holder (crash, OOM, `kill -9`) never gets to call release, and #62's
// hour-long diagnosis was exactly that: a dead process's claim outliving
// the process.
type Lock struct {
	mu  sync.Mutex
	ttl time.Duration
	now func() time.Time // overridden in tests so expiry doesn't need a real sleep

	holder *Holder
}

// NewLock builds a Lock with the given lease TTL, ticking off the real
// clock.
func NewLock(ttl time.Duration) *Lock {
	return &Lock{ttl: ttl, now: time.Now}
}

func (l *Lock) live() bool {
	return l.holder != nil && l.now().Before(l.holder.ExpiresAt)
}

// Claim grants the lease to (owner, worktree, pid) at the given port, or
// refuses it and hands back whoever currently holds it. Granted when: no
// one holds it, the current holder's lease has expired, the caller
// already is the current holder (a heartbeat renewal), or force is set
// (an explicit operator override, #62's "die loudly" with a documented
// escape hatch rather than a silent retry).
func (l *Lock) Claim(owner, worktree string, pid, port int, force bool) (granted bool, current Holder) {
	l.mu.Lock()
	defer l.mu.Unlock()

	if l.live() && !force && !l.holder.isSame(owner, worktree, pid) {
		return false, *l.holder
	}

	h := Holder{
		Owner: owner, Worktree: worktree, PID: pid, Port: port,
		ExpiresAt: l.now().Add(l.ttl),
	}
	l.holder = &h
	return true, h
}

// Release drops the lease if — and only if — (owner, worktree, pid) is
// still the one holding it. A release from anyone else is a no-op:
// releasing on process exit must never clobber a lease someone else won
// after this process's lease had already expired.
func (l *Lock) Release(owner, worktree string, pid int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.holder != nil && l.holder.isSame(owner, worktree, pid) {
		l.holder = nil
	}
}

// Status reports the live holder, if any. An expired holder reads the
// same as no holder — expiry frees the port even before the next Claim
// or Release gets around to noticing.
func (l *Lock) Status() (Holder, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if !l.live() {
		return Holder{}, false
	}
	return *l.holder, true
}
