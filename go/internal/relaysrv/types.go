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

// HandoverWinner is the contender this region goes to when the lease ends.
func (c *Claim) HandoverWinner() *Contender {
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
