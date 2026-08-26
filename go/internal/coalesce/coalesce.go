// Package coalesce collapses repeat relay traffic and caps volume per
// window — the Go mirror of cpp/daemon/coalesce.{hpp,cpp}. Overflow is
// dropped and counted, never queued: a backlog would delay live presence
// forever.
package coalesce

// Ev is one candidate for admission: the same (agent, verb, path) within
// one window is suppressed, everything else is not.
type Ev struct {
	Verb, Path, Agent string
}

type Coalescer struct {
	windowMs    int64
	maxPerWin   int
	windowStart int64
	inWindow    int
	dropped     int
	lastSeen    map[string]int64
}

func New(windowMs int64, maxPerWindow int) *Coalescer {
	return &Coalescer{windowMs: windowMs, maxPerWin: maxPerWindow, lastSeen: make(map[string]int64)}
}

func (c *Coalescer) evict(nowMs int64) {
	for k, t := range c.lastSeen {
		if nowMs < t || nowMs-t >= c.windowMs {
			delete(c.lastSeen, k)
		}
	}
}

// Admit reports whether e should be forwarded. Same rule as Coalescer::admit:
// a fresh window resets the per-window counter and sweeps entries that can no
// longer suppress anything; a key repeated inside the current window is
// dropped without counting against the per-window cap.
func (c *Coalescer) Admit(e Ev, nowMs int64) bool {
	// nowMs is wall clock, not monotonic, so a backwards step — an NTP
	// correction, a VM or container resync, a laptop waking up — makes
	// every subtraction below negative. Left alone, the window then never
	// rolls: windowStart is never advanced, evict never runs, and every key
	// already in lastSeen goes on suppressing Admit until real time crawls
	// back past windowStart+windowMs, which after a big step is far longer
	// than the 1s this is meant to be. That matters because the caller
	// doesn't retry: daemon's drainContend has already taken the path off
	// its bounded queue by the time it asks, so a false here discards the
	// frame outright, and a hook session blocked on a lease never gets its
	// contend sent — the holder is never given a deadline and the blocked
	// session has no way out.
	//
	// Treat a clock that's gone backwards as an elapsed window rather than
	// an unmet one, the same way leases.Cache.Upsert already treats its
	// sweep cooldown.
	if nowMs < c.windowStart || nowMs-c.windowStart >= c.windowMs {
		c.windowStart = nowMs
		c.inWindow = 0
		c.evict(nowMs)
	}

	key := e.Agent + "|" + e.Verb + "|" + e.Path
	// Same reasoning for the per-key check: a lastSeen stamp in the future
	// relative to nowMs is a leftover from before the step, not something
	// still inside its window.
	if t, ok := c.lastSeen[key]; ok && nowMs >= t && nowMs-t < c.windowMs {
		return false
	}

	if c.inWindow >= c.maxPerWin {
		c.dropped++
		return false
	}

	c.lastSeen[key] = nowMs
	c.inWindow++
	return true
}

func (c *Coalescer) Dropped() int { return c.dropped }
func (c *Coalescer) Tracked() int { return len(c.lastSeen) }
