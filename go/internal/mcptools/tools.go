// Package mcptools is the deliberate channel: the four MCP tools
// agent-sync exposes, and everything needed to assemble them for one
// session. It is the Go mirror of mcp_server.py — same tool names, same
// schemas, same reply shapes, same error strings — talking to the relay
// through internal/mcprelay the same way mcp_server.py talks to it through
// relay_client.RelayConnection: over the wire, never by touching relay
// state directly. A claim made here is a claim the relay actually holds,
// and every other connection in the room hears about it the same way it
// hears about a claim made by a daemon or a scripted client.
package mcptools

import (
	"context"
	"time"

	"github.com/mohsensc/sync/go/internal/mcprelay"
	"github.com/mohsensc/sync/go/internal/metrics"
	"github.com/mohsensc/sync/go/internal/negotiation"
	"github.com/mohsensc/sync/go/internal/repo"
	"github.com/mohsensc/sync/go/internal/wire"
)

// Tools is the tool surface for one MCP session. Identity is fixed at
// construction, read-only after — same reason relay.py latches it at
// join: a session that could rename itself mid-call could release a
// teammate's leases.
type Tools struct {
	conn    *mcprelay.Conn
	root    string // repo root, resolved once at construction; "" outside any repo
	room    string
	agent   string
	human   string
	metrics *metrics.Registry
}

// NewTools assembles the tool surface around an already-configured
// connection. The connection itself dials out lazily, so this never blocks
// on a relay that isn't running yet — see mcprelay.Conn's doc comment.
//
// root is resolved once by the caller (repo.FindRepoRoot), not
// re-derived per call: every claim_work/release/respond in the session
// needs the same root or two calls in the same process could disagree
// with each other, never mind with the daemon.
//
// reg is required, not defaulted: a Tools that silently fell back to a
// private registry nobody reads would look instrumented and not be.
func NewTools(conn *mcprelay.Conn, root, room, agent, human string, reg *metrics.Registry) *Tools {
	return &Tools{conn: conn, root: root, room: room, agent: agent, human: human, metrics: reg}
}

func (t *Tools) Room() string  { return t.room }
func (t *Tools) Agent() string { return t.agent }
func (t *Tools) Human() string { return t.human }

// Close releases the underlying connection. The client hanging up is the
// common way an MCP session ends, and a relay connection outliving the
// session it was joined for is a leak on the relay's side too — it holds
// the room open until the lease TTL.
func (t *Tools) Close() { t.conn.Close() }

// region is the wire shape a path/symbol pair takes on every request —
// symbol and lines always spelled out, null rather than omitted, matching
// what mcp_server.py's _region_dict (and redact.clean_region_dict, on the
// relay side) always produces.
//
// The path goes through repo.RegionKey against this session's root before
// it ever reaches the wire: a raw absolute path is only a shared name on
// the machine that sent it, and the daemon that answers PreToolUse for
// the same file keys its own lookups by repo.RegionKey too — sending
// anything else here is a claim nobody else's lookup ever matches.
func (t *Tools) region(path string, symbol *string) wire.Region {
	key := repo.RegionKeyResolved(t.root, path)
	if shape, ok := regionShape(key); ok {
		t.metrics.RegionKey(shape)
	}
	return wire.Region{Path: key, Symbol: symbol}
}

// PeerInfo is one who_else_is_here entry — the shape
// RelayConnection.presence() already builds in Python, reused verbatim
// here as the tool's JSON reply.
type PeerInfo struct {
	Human  string  `json:"human"`
	Agent  string  `json:"agent"`
	Verb   string  `json:"verb"`
	Path   string  `json:"path"`
	Symbol *string `json:"symbol"`
	// The wire's presence frame carries no intent field — only a claim
	// does, and a claim is not an event. Always null rather than guessed
	// at, same as mcp_server.py's who_else_is_here.
	Intent *string `json:"intent"`
}

// WhoElseIsHere lists other agents active in this room. Fails open: a dead
// relay must not turn this tool into a hang, and "no news of peers" is not
// the same claim as "nobody is here" — but it is the only answer a dead
// relay leaves available.
func (t *Tools) WhoElseIsHere(ctx context.Context) []PeerInfo {
	start := time.Now()
	peers, err := t.conn.Presence(ctx, t.agent)
	if err != nil {
		// Fails open in the reply — "no news of peers" is the only answer
		// a dead relay leaves available — but not silently in the metric:
		// this is the relay being unreachable, not a genuine "you're
		// alone", and the two must not look the same on a dashboard.
		t.recordCall(mcpToolWhoElseIsHere, outcomeForErr(err), start)
		return []PeerInfo{}
	}
	t.recordCall(mcpToolWhoElseIsHere, mcpOutcomeOK, start)
	out := make([]PeerInfo, len(peers))
	for i, p := range peers {
		out[i] = PeerInfo{Human: p.Human, Agent: p.Agent, Verb: p.Verb, Path: p.Path, Symbol: p.Symbol}
	}
	return out
}

// ClaimWork declares intent to modify a region before editing it.
func (t *Tools) ClaimWork(ctx context.Context, path string, symbol *string, intent string) map[string]any {
	start := time.Now()
	reply, err := t.conn.Claim(ctx, t.region(path, symbol), intent)
	if err != nil {
		t.recordCall(mcpToolClaimWork, outcomeForErr(err), start)
		// Fail closed, deliberately: granting locally when the relay
		// cannot be told is exactly the bug this tool exists to not have
		// anymore. An error the agent can see beats a claim nobody else
		// ever learns about.
		return map[string]any{"granted": false, "error": err.Error()}
	}
	// A losing claim is a relay verdict, not a failure of this call — see
	// mcpOutcomeRefused's doc comment.
	outcome := mcpOutcomeRefused
	if boolOf(reply["granted"]) {
		outcome = mcpOutcomeOK
	}
	t.recordCall(mcpToolClaimWork, outcome, start)
	return claimReply(reply, t.agent)
}

// Release gives up a previously claimed region.
func (t *Tools) Release(ctx context.Context, path string, symbol *string) map[string]any {
	start := time.Now()
	err := t.conn.Release(ctx, t.region(path, symbol))
	t.recordCall(mcpToolRelease, outcomeForErr(err), start)
	if err != nil {
		return map[string]any{"released": false, "error": err.Error()}
	}
	return map[string]any{"released": true}
}

// Respond replies to a contested claim with DEFER, SPLIT, HANDOFF or
// PROCEED.
func (t *Tools) Respond(ctx context.Context, path string, symbol *string, move, reason string) map[string]any {
	start := time.Now()
	canonical := negotiation.Normalize(move)
	if canonical == "" {
		// Checked locally rather than round-tripped: an invented move is
		// never valid no matter what the relay says, and this keeps the
		// tool surface total — respond never throws — without a network
		// call to learn something already known. Recorded as refused, not
		// error: the request was understood well enough to know it's
		// invalid, the same way a losing claim is refused rather than
		// erroring.
		t.recordCall(mcpToolRespond, mcpOutcomeRefused, start)
		return map[string]any{
			"granted":     false,
			"error":       "unknown move: " + move,
			"valid_moves": append([]string{}, negotiation.Moves...),
		}
	}
	reply, err := t.conn.Move(ctx, t.region(path, symbol), canonical, reason)
	if err != nil {
		t.recordCall(mcpToolRespond, outcomeForErr(err), start)
		return map[string]any{"granted": false, "error": err.Error()}
	}
	action := strOf(reply["action"])
	outcome := mcpOutcomeRefused
	if boolOf(reply["granted"]) {
		outcome = mcpOutcomeOK
	}
	t.recordCall(mcpToolRespond, outcome, start)
	result := map[string]any{
		"granted": boolOf(reply["granted"]),
		"action":  action,
		// PROCEED is the only move the relay's Negotiator.apply ever logs
		// as an override, so the action name alone is enough to
		// reconstruct the flag the wire's move_result frame doesn't carry.
		"override": action == "proceed",
	}
	if e, ok := reply["error"]; ok {
		result["error"] = e
	}
	return result
}

// claimReply reshapes the wire's claim_result frame into what this tool
// has always returned: seconds instead of milliseconds, held_by_human
// instead of the wire's human, and the move list spelled out — that list
// is a tool-surface convenience, not a lease fact, so the wire doesn't
// carry it. Mirrors mcp_server.py's _claim_reply.
func claimReply(reply map[string]any, agent string) map[string]any {
	if boolOf(reply["granted"]) {
		result := map[string]any{"granted": true}
		if intOf(reply["rung"]) == 4 {
			result["rung"] = 4
			result["redundant"] = reply["redundant"]
		}
		return result
	}

	result := map[string]any{
		"granted":       false,
		"held_by":       reply["held_by"],
		"held_by_human": reply["human"],
		"intent":        strOf(reply["intent"]),
		"decision":      decisionOr(reply["decision"]),
	}

	if boolOf(reply["reserved"]) {
		// Not held, kept: a handover freed this region for somebody else a
		// moment ago. Short and self-clearing, so the answer is a number
		// of seconds rather than a negotiation.
		result["reserved"] = true
		result["moves"] = []string{"DEFER"}
		if v, ok := reply["retry_in_ms"]; ok {
			result["retry_in_s"] = numOf(v) / 1000.0
		}
		return result
	}

	result["moves"] = append([]string{}, negotiation.Moves...)
	if v, ok := reply["handover_in_ms"]; ok {
		handoverS := numOf(v) / 1000.0
		result["handover_in_s"] = handoverS
		result["waiting"] = intOf(reply["waiting"])
		if strOf(reply["handover_to"]) == agent {
			// DEFER with a number on it. This is the region's queue, and
			// this agent is at the front of it.
			result["retry_in_s"] = handoverS
		} else {
			result["handover_to"] = reply["handover_to"]
		}
	}
	return result
}
