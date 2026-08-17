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

// priorityOrder is priorityValues' keys in tier order, for an error message
// that has to list them in a stable, human-sensible order rather than
// whatever a map range happens to produce.
var priorityOrder = []string{"background", "normal", "elevated", "critical"}

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

// pyRepr renders s the way Python's repr() renders a str, so an operator
// diffing this daemon's log against the Python relay's for the same
// malformed principals.toml sees identical quoting instead of two
// different-looking errors for one typo. Python prefers a single-quote
// wrapper, switching to double quotes only when s contains a single quote
// and no double quote (CPython's unicode_repr, Objects/unicodeobject.c) —
// that is the entire rule implemented here. Escaping control characters or
// non-printable runes the way full repr() does would make this a general
// repr implementation, which is more than ParsePriority's only caller
// needs: value is always a tier name typo or a short number out of a TOML
// file, never arbitrary bytes, so those branches would ship untested.
func pyRepr(s string) string {
	quote := byte('\'')
	if strings.ContainsRune(s, '\'') && !strings.ContainsRune(s, '"') {
		quote = '"'
	}
	var b strings.Builder
	b.WriteByte(quote)
	for _, r := range s {
		if r == rune(quote) || r == '\\' {
			b.WriteByte('\\')
		}
		b.WriteRune(r)
	}
	b.WriteByte(quote)
	return b.String()
}

// ParsePriority reads a tier from a name or a number. Only called against
// the roster the operator wrote (principals.toml), where a typo should be
// reported loudly at load time.
//
// Both error branches name the four valid tiers, matching python's
// parse_priority word for word and order for order — an operator comparing
// the Go and Python relays' logs against the same malformed principals.toml
// should see the same complaint, not have to wonder if they hit two
// different bugs. The unknown-tier branch also has to match python's
// quoting, not just its wording — python's f"{value!r}" is single-quoted
// (pyRepr), where Go's %q would have printed double quotes.
func ParsePriority(value string) (int, error) {
	name := strings.ToLower(strings.TrimSpace(value))
	if v, ok := priorityValues[name]; ok {
		return v, nil
	}
	if n, err := strconv.Atoi(name); err == nil {
		if n < PriorityMin || n > PriorityMax {
			return 0, fmt.Errorf("priority %d is out of range; expected %d..%d or one of %s",
				n, PriorityMin, PriorityMax, strings.Join(priorityOrder, ", "))
		}
		return n, nil
	}
	return 0, fmt.Errorf("unknown priority tier %s; expected one of %s", pyRepr(value), strings.Join(priorityOrder, ", "))
}
