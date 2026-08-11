package relaysrv

import (
	"fmt"
	"strconv"
	"strings"
)

// Priority tiers. Four names, not an open integer range — see
// python/src/agent_presence/priority.py for why. Kept as the same four
// names and the same integer values so a tier stamped by one language's
// relay means the same thing to the other's daemon.
const (
	PriorityBackground = 0
	PriorityNormal     = 1
	PriorityElevated   = 2
	PriorityCritical   = 3
	PriorityMin        = PriorityBackground
	PriorityMax        = PriorityCritical
)

var priorityNames = map[int]string{
	PriorityBackground: "background",
	PriorityNormal:     "normal",
	PriorityElevated:   "elevated",
	PriorityCritical:   "critical",
}

var priorityValues = map[string]int{
	"background": PriorityBackground,
	"normal":     PriorityNormal,
	"elevated":   PriorityElevated,
	"critical":   PriorityCritical,
}

// ClampPriority folds any integer into the four tiers.
func ClampPriority(p int) int {
	if p < PriorityMin {
		return PriorityMin
	}
	if p > PriorityMax {
		return PriorityMax
	}
	return p
}

// PriorityName is the tier name for the wire, clamped like priority.py's
// name_of so the name and the number never disagree.
func PriorityName(p int) string {
	return priorityNames[ClampPriority(p)]
}

// ParsePriority reads a tier from a name or a number. Only called against
// the roster the operator wrote (principals.toml), where a typo should be
// reported loudly at load time.
func ParsePriority(value string) (int, error) {
	name := strings.ToLower(strings.TrimSpace(value))
	if v, ok := priorityValues[name]; ok {
		return v, nil
	}
	if n, err := strconv.Atoi(name); err == nil {
		if n < PriorityMin || n > PriorityMax {
			return 0, fmt.Errorf("priority %d is out of range; expected %d..%d or a tier name", n, PriorityMin, PriorityMax)
		}
		return n, nil
	}
	return 0, fmt.Errorf("unknown priority tier %q", value)
}
