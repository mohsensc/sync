// The MCP surface has the same "the operator can't scrape this" problem
// presenced has, and internal/metrics is the same one catalogue for both —
// see that package's doc comment. This file is everything specific to this
// package: the tool-name and outcome vocabularies ap_mcp_calls_total's
// labels are bounded to, and the two helpers every call site funnels
// through so a label value can only ever come from a constant here.
package mcptools

import (
	"errors"
	"path/filepath"
	"time"

	"github.com/mohsensc/sync/go/internal/mcprelay"
	"github.com/mohsensc/sync/go/internal/metrics"
)

// mcpTool* are the tool label's entire domain: the four names this server
// ever registers, plus the one bucket every other name collapses into.
// Dispatch's "unknown tool" branch is reachable with a client-supplied
// name — see Dispatch's doc comment — and that name must never reach a
// label unfiltered, or ap_mcp_calls_total's cardinality grows with
// whatever a client feels like typing.
const (
	mcpToolWhoElseIsHere = "who_else_is_here"
	mcpToolClaimWork     = "claim_work"
	mcpToolRelease       = "release"
	mcpToolRespond       = "respond"
	mcpToolUnknown       = "unknown"
)

// Outcome vocabulary for every MCPCall this package records. Defined here
// rather than in internal/metrics because it's specific to what an MCP
// tool call resolves to, the same way metrics.Registry's own Outcome*
// constants are specific to a lease.
const (
	// mcpOutcomeOK: the tool did what it was asked.
	mcpOutcomeOK = "ok"
	// mcpOutcomeRefused: the request was understood and declined without
	// anything going wrong — a losing claim, an invented negotiation
	// move. Never a system fault.
	mcpOutcomeRefused = "refused"
	// mcpOutcomeNoRelay: the request never reached the relay to be
	// answered at all — connect or roundtrip failure. Kept apart from
	// mcpOutcomeError so "the relay is down" and "this server has a bug"
	// show up as different signals rather than one undifferentiated
	// "error".
	mcpOutcomeNoRelay = "no_relay"
	// mcpOutcomeError: Dispatch rejected the call before any Tools method
	// ran — an unknown tool name, or a missing/mistyped required
	// argument. The one case a Tools method itself can still produce this
	// is defensive: see outcomeForErr.
	mcpOutcomeError = "error"
)

// recordCall is the one place a call to r.MCPCall happens for this
// package, so every site records the same shape: tool, outcome, and how
// long it took from start. Both Dispatch (unknown tool, bad argument) and
// every Tools method funnel through this.
func (t *Tools) recordCall(tool, outcome string, start time.Time) {
	t.metrics.MCPCall(tool, outcome, time.Since(start))
}

// outcomeForErr classifies an error a mcprelay.Conn call returned into
// this package's vocabulary. mcprelay's own doc comment states its
// contract: "every failure here becomes an *Unavailable, never a hang" —
// so in the ordinary case this is just naming that fact. The fallback to
// mcpOutcomeError exists so a violation of that contract shows up as "this
// server has a bug" rather than being silently mislabeled as "the relay is
// down".
func outcomeForErr(err error) string {
	if err == nil {
		return mcpOutcomeOK
	}
	var unavailable *mcprelay.Unavailable
	if errors.As(err, &unavailable) {
		return mcpOutcomeNoRelay
	}
	return mcpOutcomeError
}

// regionShape classifies a region key already run through
// RegionKeyResolved, for RegionKey's live regression detector — see
// repo.RegionKey's doc comment for what "absolute" here means and why it's
// the bug this metric watches for.
//
// An empty key is neither shape. Dispatch only requires "path" to be
// present, not non-empty (see requireStr), so path="" is a reachable
// caller mistake, and RegionKey("", ...) answers "" for it. filepath.IsAbs
// says that's relative, which would be true only by coincidence — so this
// excludes it rather than counting it as a shape it isn't.
func regionShape(key string) (shape string, ok bool) {
	if key == "" {
		return "", false
	}
	if filepath.IsAbs(key) {
		return metrics.ShapeAbsolute, true
	}
	return metrics.ShapeRelative, true
}
