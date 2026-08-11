package relaysrv

// orderKey is the single total order over agents: tier first (negated, so
// higher tier sorts smaller/first), then age, then agent id as a tie
// breaker. Mirrors python's wait_die.order_key exactly, field for field —
// this is the one comparison in the whole system, so the fields, their
// order and their signs all have to match the Python relay byte for byte
// in behaviour, even though nothing here rides the wire.
type orderKey struct {
	negPriority int
	acquiredAt  float64
	agent       string
}

func newOrderKey(priority int, acquiredAt float64, agent string) orderKey {
	return orderKey{negPriority: -priority, acquiredAt: acquiredAt, agent: agent}
}

// less is strict less-than over the tuple (negPriority, acquiredAt, agent),
// lexicographic, matching Python tuple comparison.
func (k orderKey) less(other orderKey) bool {
	if k.negPriority != other.negPriority {
		return k.negPriority < other.negPriority
	}
	if k.acquiredAt != other.acquiredAt {
		return k.acquiredAt < other.acquiredAt
	}
	return k.agent < other.agent
}

// leq is less-than-or-equal, used where note_contender's "<=" matters: the
// incumbent re-asking with an identical key is the common case and has to
// take the cheap branch, not the rescan one.
func (k orderKey) leq(other orderKey) bool {
	return k == other || k.less(other)
}

type waitDieDecision string

const (
	decisionWait  waitDieDecision = "wait"
	decisionAbort waitDieDecision = "abort"
)

// resolveWaitDie is wait-die: the more entitled transaction waits, the less
// entitled dies. Mirrors python's wait_die.resolve exactly — see that
// docstring for the full argument on why this is deadlock-free without any
// cycle detection.
func resolveWaitDie(requesterAgent string, requesterAcquiredAt float64, holder *Claim, requesterPriority int) waitDieDecision {
	mine := newOrderKey(requesterPriority, requesterAcquiredAt, requesterAgent)
	theirs := newOrderKey(holder.Priority, holder.AcquiredAt, holder.Agent)
	if mine.less(theirs) {
		return decisionWait
	}
	return decisionAbort
}
