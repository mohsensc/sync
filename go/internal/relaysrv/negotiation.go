package relaysrv

import (
	"fmt"
	"log"
	"strings"
)

var moves = []string{"DEFER", "SPLIT", "HANDOFF", "PROCEED"}

func normalizeMove(move string) (string, bool) {
	candidate := strings.ToUpper(strings.TrimSpace(move))
	for _, m := range moves {
		if m == candidate {
			return candidate, true
		}
	}
	return "", false
}

// Brief is what a blocked agent is told. Mirrors negotiation.py's Brief.
type Brief struct {
	HolderAgent       string
	HolderHuman       string
	HolderIntent      string
	Region            Region
	Decision          waitDieDecision
	RequesterPriority int
	HolderPriority    int
	HandoverAt        *float64
	HandoverTo        string
}

// NegotiationOutcome mirrors negotiation.py's NegotiationOutcome.
type NegotiationOutcome struct {
	Granted        bool
	Action         string
	LoggedOverride bool
	Error          string
}

type Negotiator struct {
	registry *Registry
}

func NewNegotiator(registry *Registry) *Negotiator {
	return &Negotiator{registry: registry}
}

// Open returns a brief if the region is contested, else nil. Mirrors
// negotiation.py's open: opening a brief *is* an ask, so it starts the
// holder's clock exactly the way a claim frame does.
func (n *Negotiator) Open(room, requester string, requesterAcquiredAt float64, scope Region, requesterPriority int, requesterHuman string, actor Conn) *Brief {
	held := n.registry.HolderOf(room, scope, actor)
	if held == nil || held.Agent == requester {
		return nil
	}
	tier := n.registry.PriorityOf(requester, requesterPriority)
	human := requesterHuman
	if human == "" {
		human = requester
	}
	age := requesterAcquiredAt
	// Contend re-resolves the holder itself under its own shard lock and
	// hands back a view of it plus the wait-die decision it actually
	// applied; used instead of the `held` read above, which could in
	// principle have gone stale between that unlocked read and this call
	// (the claim expiring, released concurrently by its owner). The
	// decision comes from there rather than being recomputed here so the
	// brief can't disagree with the grace period contendLocked set.
	held, decision := n.registry.Contend(room, scope, requester, human, tier, &age, actor)
	if held == nil {
		return nil
	}
	var handoverTo string
	if w := held.Winner; w != nil {
		handoverTo = w.Agent
	}
	return &Brief{
		HolderAgent: held.Agent, HolderHuman: held.Human, HolderIntent: held.Intent,
		Region: scope, Decision: decision, RequesterPriority: tier,
		HolderPriority: held.Priority, HandoverAt: held.HandoverAt, HandoverTo: handoverTo,
	}
}

// Apply applies a negotiation move. Mirrors negotiation.py's apply.
func (n *Negotiator) Apply(room, requester string, scope Region, move, reason string, splitScope *Region, requesterPriority int, actor Conn) NegotiationOutcome {
	canonical, ok := normalizeMove(move)
	if !ok {
		return NegotiationOutcome{Granted: false, Action: "invalid_move",
			Error: fmt.Sprintf("unknown negotiation move: %q; expected one of %s", move, strings.Join(moves, ", "))}
	}
	switch canonical {
	case "DEFER":
		return NegotiationOutcome{Granted: false, Action: "defer"}
	case "SPLIT":
		return n.split(room, requester, scope, splitScope, requesterPriority, actor)
	case "HANDOFF":
		n.registry.Release(room, requester, scope, actor)
		return NegotiationOutcome{Granted: false, Action: "handoff"}
	default: // PROCEED
		log.Printf("override: agent=%s room=%s path=%s reason=%s", requester, room, scope.Path, orNone(reason))
		return NegotiationOutcome{Granted: true, Action: "proceed", LoggedOverride: true}
	}
}

func orNone(s string) string {
	if s == "" {
		return "(none)"
	}
	return s
}

func (n *Negotiator) split(room, requester string, scope Region, splitScope *Region, requesterPriority int, actor Conn) NegotiationOutcome {
	target := scope
	if splitScope != nil {
		target = *splitScope
	}
	held := n.registry.HolderOf(room, scope, actor)

	if held != nil && held.Agent != requester {
		if SameRegion(target, held.Scope) {
			return NegotiationOutcome{Granted: false, Action: "split_rejected",
				Error: fmt.Sprintf("split scope %s overlaps %s's region %s; name a disjoint sub-region",
					regionName(target), held.Agent, regionName(held.Scope))}
		}
		if target.Path != held.Scope.Path {
			log.Printf("split outside the contested file: agent=%s room=%s target=%s", requester, room, regionName(target))
		}
	}

	result := n.registry.Acquire(room, requester, requester, target, "split", nil, requesterPriority, actor)
	if !result.Ok {
		var blocker, waiting string
		if result.HeldBy != nil {
			blocker = result.HeldBy.Agent
		} else if result.ReservedBy != nil {
			blocker = result.ReservedBy.Agent
			waiting = " (reserved for them after a handover; retry shortly)"
		}
		return NegotiationOutcome{Granted: false, Action: "split_rejected",
			Error: fmt.Sprintf("split scope %s is already held by %s%s", regionName(target), blocker, waiting)}
	}
	return NegotiationOutcome{Granted: true, Action: "split"}
}

func regionName(r Region) string {
	sym := "*"
	if r.Symbol != nil {
		sym = *r.Symbol
	}
	return r.Path + ":" + sym
}
