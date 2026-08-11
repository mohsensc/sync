package relaysrv

// Activity is one hook- or MCP-observed touch, kept in the room's presence
// buffer. Mirrors python's ladder.Activity.
type Activity struct {
	Agent  string
	Human  string
	Verb   string
	Region Region
	Intent string
	Source Source
}

var writeVerbs = map[string]bool{"edit": true}

// Classify returns the highest rung the incoming event reaches against
// everyone else in `others`. Mirrors ladder.classify's rungs 0-3 exactly
// (region overlap, always live).
//
// Rung 4 — declared-intent similarity across different paths — is NOT
// ported. It ships off by default (AGENT_PRESENCE_RUNG4 unset) in the
// Python relay and is advisory only: it never touches the lease table,
// only whether a redundant_work frame is sent. This Go relay always
// behaves as if the flag were unset, which is the shipped default and the
// common case; see docs/relay-parity.md for the gap. redundantPeer below
// always returns nil, so this function never reaches rung 4.
func Classify(incoming AgentEvent, others []Activity) int {
	highest := 0
	for _, o := range others {
		if o.Agent == incoming.Agent {
			continue
		}
		if o.Region.Path != incoming.Region.Path {
			continue
		}
		incomingWrites := writeVerbs[incoming.Verb]
		otherWrites := writeVerbs[o.Verb]

		var rung int
		switch {
		case incomingWrites && otherWrites:
			if SameRegion(o.Region, incoming.Region) {
				rung = 3
			} else {
				rung = 2
			}
		case otherWrites:
			rung = 1
		default:
			rung = 0
		}
		if rung > highest {
			highest = rung
		}
	}
	return highest
}

// redundantPeer is rung 4's match. Always nil — see Classify's doc comment.
func redundantPeer(_ AgentEvent, _ []Activity, _ string) *struct{} {
	return nil
}

// InterruptsAt: does this rung spend somebody's attention? With an effect
// given, the effect decides (ladder.interrupts_at); this Go relay has no
// policy engine (see docs/relay-parity.md), so it always uses the rung
// default: rungs 0-2 ambient, rung 3+ interrupts.
func InterruptsAt(rung int) bool {
	return rung >= 3
}
