package relaysrv

import "strings"

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

// Redundancy is who else is already doing this work, and how sure we are.
// Mirrors ladder.py's Redundancy.
type Redundancy struct {
	Agent  string
	Human  string
	Intent string
	Region Region
	Score  float64
}

// redundantPeer is rung 4's match: the strongest declared-intent match
// against the incoming agent's own declaration, in a *different* file.
// Mirrors ladder.py's redundant_peer exactly, including all four gates —
// see there for why each one is a refusal rather than a judgment call.
// Ported as-is, off by default (AGENT_PRESENCE_RUNG4 unset); a separate
// track (#15) owns improving the scorer, not this port.
func redundantPeer(incoming AgentEvent, others []Activity, intent string) *Redundancy {
	if !rung4Enabled() {
		return nil
	}
	if incoming.Source != SourceMCP || strings.TrimSpace(intent) == "" {
		return nil
	}

	threshold := rung4Threshold()
	var best *Redundancy
	for _, o := range others {
		if o.Agent == incoming.Agent {
			continue
		}
		if o.Source != SourceMCP || strings.TrimSpace(o.Intent) == "" {
			continue
		}
		if o.Region.Path == incoming.Region.Path {
			continue
		}
		score := lexicalScore(intent, o.Intent)
		if score < threshold {
			continue
		}
		if best == nil || score > best.Score {
			best = &Redundancy{Agent: o.Agent, Human: o.Human, Intent: o.Intent, Region: o.Region, Score: score}
		}
	}
	return best
}

// Classify returns the highest rung the incoming event reaches against
// everyone else in `others`. Mirrors ladder.classify: rungs 0-3 are
// region overlap and always live; rung 4 is declared-intent similarity
// across different paths, gated by AGENT_PRESENCE_RUNG4 (off by default,
// see redundantPeer).
func Classify(incoming AgentEvent, others []Activity, intent string) int {
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
	if redundantPeer(incoming, others, intent) != nil {
		highest = max(highest, 4)
	}
	return highest
}

// InterruptsAt: does this rung spend somebody's attention? With an effect
// given, the effect decides (ladder.interrupts_at's effect branch); with
// none, rungs 0-2 are ambient and rung 3+ interrupts, the rung default.
func InterruptsAt(rung int, effect *Effect) bool {
	if effect != nil {
		return opensNegotiation(*effect)
	}
	return rung >= 3
}
