package relaysrv

// Region is a contended unit of code: a path, an optional symbol, and an
// optional line range that never narrows contention (the symbol is the
// unit). Mirrors python's types.Region.
type Region struct {
	Path   string
	Symbol *string
	// Lines is carried for display only; never compared. len 0 or nil both
	// mean "no line range", kept distinct from Go's zero-value ambiguity by
	// always treating a nil/empty slice as absent.
	Lines []int
}

// SameRegion is true when two regions contend for the same code. See
// python's types.same_region for the exact rules (path must match; a nil
// symbol is "the whole file" and contends with every symbol on that path,
// including another whole-file region; two symbols contend only when equal).
func SameRegion(a, b Region) bool {
	if a.Path != b.Path {
		return false
	}
	if a.Symbol == nil || b.Symbol == nil {
		return true
	}
	return *a.Symbol == *b.Symbol
}

func symbolKey(r Region) string {
	if r.Symbol == nil {
		return "\x00"
	}
	return *r.Symbol
}

type Source string

const (
	SourceHook Source = "hook"
	SourceMCP  Source = "mcp"
)

func ParseSource(v string) Source {
	if v == "mcp" {
		return SourceMCP
	}
	return SourceHook
}

// Contender is somebody who asked for a region while a claim held it.
type Contender struct {
	Agent        string
	Human        string
	Priority     int
	FirstAskedAt float64
}

// order is the same three components, in the same order, as orderKey:
// smaller is more entitled.
func (c Contender) order() orderKey {
	return newOrderKey(c.Priority, c.FirstAskedAt, c.Agent)
}

// Claim is a live lease. Mirrors python's types.Claim including the
// incremental winner-tracking optimisation (note_contender/handover_winner):
// recomputing the min over contenders on every read cost real latency at
// scale in the Python relay, so the winner is maintained, not recomputed.
type Claim struct {
	Room   string
	Human  string
	Agent  string
	Scope  Region
	Intent string
	// State is always "held" for anything live; python's LeaseState carries
	// "soft" too but nothing in the relay ever grants a soft lease, so it is
	// not modelled here — see the note in relay.go's leaseFrame.
	AcquiredAt float64
	ExpiresAt  float64
	Priority   int
	HandoverAt *float64
	Contenders map[string]Contender

	winner      *Contender
	winnerStale bool
}

// NoteContender records an ask, keeping the winner up to date in constant
// time. See Claim.note_contender in types.py for the invariant this
// maintains (incumbent re-asking with a worse key needs a rescan, handled
// lazily by handoverWinner).
func (c *Claim) NoteContender(contender Contender) {
	if c.Contenders == nil {
		c.Contenders = make(map[string]Contender)
	}
	c.Contenders[contender.Agent] = contender
	current := c.winner
	if current == nil || contender.order().leq(current.order()) {
		w := contender
		c.winner = &w
		c.winnerStale = false
	} else if current.Agent == contender.Agent {
		c.winnerStale = true
	}
}

// handoverWinner is the contender this region goes to when the lease ends.
//
// Caller must hold the owning shard's mutex: the lazy rescan below *writes*
// c.winner/c.winnerStale and reads c.Contenders, which NoteContender writes
// under that same lock. It used to be exported and got called from
// connection goroutines off the lock (issue #86) — a concurrent map
// read/write, which is a fatal runtime error, not a panic session()'s
// recover can catch. Nothing outside the lock needs it now: take a
// claimView instead.
func (c *Claim) handoverWinner() *Contender {
	if c.winnerStale {
		var best *Contender
		for agent := range c.Contenders {
			cand := c.Contenders[agent]
			if best == nil || cand.order().less(best.order()) {
				b := cand
				best = &b
			}
		}
		c.winner = best
		c.winnerStale = false
	}
	return c.winner
}

// claimView is a claim as everything outside the shard lock is allowed to
// see it: a value copy, taken under s.mu, with the handover winner already
// resolved and the contender map reduced to its count. The registry used to
// hand back the live *Claim, which connection goroutines then read and
// (through handoverWinner) wrote while another goroutine mutated the same
// claim under the lock — issue #86.
//
// Field names match Claim's so a read site reads the same either way.
// Scope's Lines slice shares its backing array with the claim's; regions are
// built once at ingest and never mutated, so that share is read-only.
type claimView struct {
	Room       string
	Human      string
	Agent      string
	Scope      Region
	Intent     string
	AcquiredAt float64
	ExpiresAt  float64
	Priority   int
	HandoverAt *float64
	// Winner and HandoverAt are pointers to copies, never into the claim:
	// the point of the whole exercise is that nothing here aliases memory
	// the lock protects.
	Winner *Contender
	// Waiting is len(Contenders) at copy time — the only thing the wire
	// wants from the map.
	Waiting int
}

// viewOf copies a claim for use outside the lock. Caller holds the owning
// shard's mutex (handoverWinner writes).
func viewOf(c *Claim) claimView {
	v := claimView{
		Room: c.Room, Human: c.Human, Agent: c.Agent, Scope: c.Scope, Intent: c.Intent,
		AcquiredAt: c.AcquiredAt, ExpiresAt: c.ExpiresAt, Priority: c.Priority,
		Waiting: len(c.Contenders),
	}
	if c.HandoverAt != nil {
		h := *c.HandoverAt
		v.HandoverAt = &h
	}
	if w := c.handoverWinner(); w != nil {
		cw := *w
		v.Winner = &cw
	}
	return v
}

func viewPtr(c *Claim) *claimView {
	if c == nil {
		return nil
	}
	v := viewOf(c)
	return &v
}

// AgentEvent is a hook or MCP touch, claim or release. Mirrors
// python's types.AgentEvent.
type AgentEvent struct {
	Room   string
	Human  string
	Agent  string
	Kind   string // touch | claim | release
	Source Source
	Verb   string
	Region Region
	Ts     float64
}
