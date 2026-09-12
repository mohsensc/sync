// Package negotiation is the client-side sliver of
// python/src/agent_sync/negotiation.py the MCP tool surface needs: the
// four moves and how to fold a client-supplied spelling to one of them. The
// rest of negotiation.py — Negotiator, Brief, wait-die — is relay-side and
// stays Python; this package only has to agree with it on vocabulary.
package negotiation

import "strings"

// Moves is the canonical order the "respond" tool reports back on a
// refusal — python's MOVES tuple, unchanged.
var Moves = []string{"DEFER", "SPLIT", "HANDOFF", "PROCEED"}

// Normalize folds a client-supplied move to its canonical spelling, or ""
// when it isn't one of the four. Agents write "split", "Split", " SPLIT "
// and mean the same thing; rejecting those is a protocol tax with no
// upside — same rule as negotiation.py's normalize_move.
func Normalize(move string) string {
	candidate := strings.ToUpper(strings.TrimSpace(move))
	for _, m := range Moves {
		if candidate == m {
			return candidate
		}
	}
	return ""
}
