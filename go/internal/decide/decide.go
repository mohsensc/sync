// Package decide answers the hook's half of the unix-socket protocol
// (hook/protocol.hpp) and turns an admitted hook line into the frame the
// relay expects. It is the Go mirror of cpp/daemon/decide.cpp.
package decide

import (
	"encoding/json"
	"unicode/utf8"

	"github.com/mohsensc/sync/go/internal/leases"
	"github.com/mohsensc/sync/go/internal/policy"
	"github.com/mohsensc/sync/go/internal/repo"
	"github.com/mohsensc/sync/go/internal/wire"
)

// Request is one line off the hook socket. Verb/Path/Agent mirror
// build_event in cpp/hook/hook.cpp; Want carries "decision" when the hook
// expects a line back (build_request).
type Request struct {
	Verb  string `json:"verb"`
	Path  string `json:"path"`
	Agent string `json:"agent"`
	Human string `json:"human"`
	Want  string `json:"want"`
}

// WantsDecision mirrors decide.cpp's wants_decision_line.
func (r Request) WantsDecision() bool { return r.Want == "decision" }

// Response is the line written back to the hook — every field decide.cpp
// can produce, across the rung-0 (ambient) and conflict (rung 2 or 3)
// paths.
//
// ExpiresInMs, HandoverInMs and LostMsAgo are *int64, not int64: decide.cpp
// writes each of these unconditionally whenever that section of the
// response applies at all (a conflict answer always carries
// expires_in_ms, even when the lease expires this millisecond), and a
// plain int64 with `omitempty` would drop a genuine zero the same way it
// drops an absent field — the hook then reads that as "the daemon didn't
// say" (see
// hook.cpp's `int_field(line, "expires_in_ms", -1)`) instead of "the lease
// expires now". A pointer's omitempty only omits a nil, so the field is
// present, including at zero, exactly when the surrounding code sets it.
type Response struct {
	Rung           int    `json:"rung"`
	Effect         string `json:"effect"`
	Decision       string `json:"decision,omitempty"`
	Holder         string `json:"holder,omitempty"`
	Human          string `json:"human,omitempty"`
	Intent         string `json:"intent,omitempty"`
	HolderPriority string `json:"holder_priority,omitempty"`
	ExpiresInMs    *int64 `json:"expires_in_ms,omitempty"`

	HandoverInMs       *int64 `json:"handover_in_ms,omitempty"`
	HandoverTo         string `json:"handover_to,omitempty"`
	HandoverToHuman    string `json:"handover_to_human,omitempty"`
	HandoverToPriority string `json:"handover_to_priority,omitempty"`
	HandoverToMe       bool   `json:"handover_to_me,omitempty"`
	Waiting            int    `json:"waiting,omitempty"`

	LostTo         string `json:"lost_to,omitempty"`
	LostToAgent    string `json:"lost_to_agent,omitempty"`
	LostToPriority string `json:"lost_to_priority,omitempty"`
	LostMsAgo      *int64 `json:"lost_ms_ago,omitempty"`
}

// Free-text caps enforced on every Response before it is marshalled. See
// hook.cpp's kMaxReply (8192 bytes): read_line treats a reply that hits
// that cap without finding a newline as no answer at all, and the hook is
// fail-open by design, so an over-long line turns a real deny into a
// silent allow. Nothing on the wire bounds what a peer puts in an intent,
// a human name or a handover target — they ride in on a lease anybody in
// the room can claim — so the daemon is the one place that has to cap them
// before they reach that budget.
//
// maxIntentBytes is generous for a one-line "what I'm doing"; the rest are
// identifiers and short words (session ids, names, priority tiers) that
// never legitimately run long. Even at 6 bytes of JSON per byte of input
// (the worst case: a control character with no short escape, \u00XX) the
// whole envelope stays a few thousand bytes under the cap.
const (
	maxIntentBytes = 300
	maxNameBytes   = 64
)

// truncateUTF8 returns the longest prefix of s that fits within max bytes
// without splitting a multi-byte rune. Go's own encoder tolerates a broken
// trailing rune (it substitutes U+FFFD rather than erroring), but this
// reply also has to survive the C++ hook's and the Python relay's own JSON
// readers, and a cut that lands mid-rune is not worth trusting to agree on.
func truncateUTF8(s string, max int) string {
	if len(s) <= max {
		return s
	}
	b := s[:max]
	for !utf8.ValidString(b) && len(b) > 0 {
		b = b[:len(b)-1]
	}
	return b
}

// boundResponse truncates every free-text field on r. Called last, after
// HandoverToMe has already been computed from the untruncated lease data —
// hook.cpp's queued_for_me check compares the wire's handover_to against
// its own session id, and a field truncated before that comparison could
// break a match that was otherwise exact.
func boundResponse(r Response) Response {
	r.Holder = truncateUTF8(r.Holder, maxNameBytes)
	r.Human = truncateUTF8(r.Human, maxNameBytes)
	r.Intent = truncateUTF8(r.Intent, maxIntentBytes)
	r.HolderPriority = truncateUTF8(r.HolderPriority, maxNameBytes)
	r.HandoverTo = truncateUTF8(r.HandoverTo, maxNameBytes)
	r.HandoverToHuman = truncateUTF8(r.HandoverToHuman, maxNameBytes)
	r.HandoverToPriority = truncateUTF8(r.HandoverToPriority, maxNameBytes)
	r.LostTo = truncateUTF8(r.LostTo, maxNameBytes)
	r.LostToAgent = truncateUTF8(r.LostToAgent, maxNameBytes)
	r.LostToPriority = truncateUTF8(r.LostToPriority, maxNameBytes)
	return r
}

func leftMs(atMs, nowMs int64) int64 {
	if atMs > nowMs {
		return atMs - nowMs
	}
	return 0
}

func msPtr(v int64) *int64 { return &v }

func openResponse(rung int, effect policy.Effect) Response {
	r := Response{Rung: rung, Effect: effect.String()}
	// The old field, still on the wire — a hook from before effects existed
	// reads `decision` and nothing else.
	if effect == policy.Ask {
		r.Decision = "ask"
	}
	return r
}

func appendLost(r *Response, lost leases.HandoverNote, nowMs int64) {
	if lost.ToHuman != "" {
		r.LostTo = lost.ToHuman
	} else {
		r.LostTo = lost.To
	}
	if lost.To != "" {
		r.LostToAgent = lost.To
	}
	if lost.ToPriority != "" {
		r.LostToPriority = lost.ToPriority
	}
	ago := nowMs - lost.AtMs
	if ago < 0 {
		ago = 0
	}
	r.LostMsAgo = msPtr(ago)
}

// ambientResponse is decide.cpp's ambient_response: the two things a
// non-blocked agent may still need to hear — that a region it holds has a
// deadline, and that a region it held has gone. path is already a region
// key by the time it gets here — Decide normalizes once, before either of
// its cache lookups.
func ambientResponse(cache *leases.Cache, pol *policy.Cache, path string, myAgents []string, nowMs int64) Response {
	// EffectForPath, not the path-less EffectFor: path is a real region key
	// here (see the doc comment above), so a [[path]] rule for it has to be
	// able to fire even on the no-conflict, ambient reply — the whole point
	// of EffectForPath was answers like this one, not just the conflict path.
	r := openResponse(0, pol.EffectForPath(0, path))

	if mine, ok := cache.OwnHandover(path, myAgents, nowMs); ok {
		r.HandoverInMs = msPtr(leftMs(mine.HandoverAtMs, nowMs))
		r.HandoverTo = mine.HandoverTo
		r.HandoverToHuman = mine.HandoverToHuman
		r.HandoverToPriority = mine.HandoverToPriority
		if mine.Waiting > 0 {
			r.Waiting = mine.Waiting
		}
		return boundResponse(r)
	}

	if lost, ok := cache.HandoverNoteFor(path, myAgents, nowMs, leases.HandoverNoteMs); ok {
		appendLost(&r, lost, nowMs)
	}
	return boundResponse(r)
}

// Decide is decide_response: a live lease on the file held by somebody else
// is rung 2 or rung 3 — same symbol (or no evidence either way) is 3,
// proven-disjoint symbols is 2; anything else is rung 0, with the ambient
// handover/lost-region notes folded in. selfAgent is the id this daemon
// joined the room under; empty means no room is configured. root is the
// repo root this daemon resolved at startup — see repo.RegionKey — and is
// used once, here, to turn whatever path the hook sent (often absolute)
// into the same region key every checkout of this repo uses.
//
// Both selfAgent and req.Agent are checked against every lease: the MCP
// surface claims a region under the hook session's id, while this daemon's
// own relay identity is a different string for the same requester, so a
// lease is "mine" if it matches either — see leases.Cache.Conflict.
//
// Rung 1 ("A editing, B reading") never comes out of here: it only exists
// when the *incoming* action is a read, and a read never asks for a
// decision at all — hook.cpp's wants_decision only sends `want:"decision"`
// for a PreToolUse edit. Rung 1 is computed from the presence table
// instead (see presence.Table.Peers), which is the ambient, no-interrupt
// surface that rung was always meant to reach.
func Decide(req Request, cache *leases.Cache, pol *policy.Cache, nowMs int64, selfAgent string, root string) Response {
	// One agent, two names. The id this daemon joined the room under, and
	// the session id the hook sent. A lease taken through the MCP surface is
	// filed under the session id; one this daemon took is filed under its
	// relay identity. Either is me, so both travel together to every question
	// below that asks whose a region is — the bug this fixes was a single
	// collapsed identity answering "not mine" about the caller's own lease.
	myAgents := []string{selfAgent, req.Agent}

	if req.Path == "" || req.Verb != "edit" {
		// EffectFor(0), not EffectForPath: when req.Path == "" there is no
		// region key to give it. When it's non-empty but the verb isn't
		// "edit", there would be — but this branch is the cheap early-out
		// that has to fit inside the hook's decision budget for requests
		// that were never going to contend a region (WantsDecision only
		// fires for a PreToolUse edit; see the doc comment below), and
		// RegionKeyResolved's stat/symlink resolution is not free. Anything
		// that can reach this branch with a real path and still wants
		// path-scoped policy has to go through the event/journal path
		// instead, where the path is normalized anyway.
		return openResponse(0, pol.EffectFor(0))
	}
	path := repo.RegionKeyResolved(root, req.Path)

	held, rung, ok := cache.Conflict(path, myAgents, nowMs)
	if !ok {
		return ambientResponse(cache, pol, path, myAgents, nowMs)
	}

	// EffectForPath: this is the branch a `[[path]]` rule most needs to
	// reach — a rung 2/3 deny an operator wants softened (or hardened) for
	// one glob, not the whole repo. Path is already the normalized region
	// key cache.Conflict just matched against.
	r := openResponse(rung, pol.EffectForPath(rung, path))
	r.Holder = held.Agent
	r.Human = held.Human
	r.Intent = held.Intent
	r.HolderPriority = held.Priority
	r.ExpiresInMs = msPtr(leftMs(held.ExpiresAtMs, nowMs))

	if held.HasHandover {
		r.HandoverInMs = msPtr(leftMs(held.HandoverAtMs, nowMs))
		r.HandoverTo = held.HandoverTo
		r.HandoverToHuman = held.HandoverToHuman
		r.HandoverToPriority = held.HandoverToPriority
		if leases.IsMine(held.HandoverTo, myAgents) {
			r.HandoverToMe = true
		}
		if held.Waiting > 0 {
			r.Waiting = held.Waiting
		}
	}

	if lost, ok := cache.HandoverNoteFor(path, myAgents, nowMs, leases.HandoverNoteMs); ok {
		appendLost(&r, lost, nowMs)
	}
	return boundResponse(r)
}

// BlockedByLease mirrors decide.cpp's blocked_by_lease: rung 3, regardless
// of what policy did with the effect.
func BlockedByLease(resp Response) bool { return resp.Rung == 3 }

// ParseRequest is forgiving the way json_field is: a line that isn't valid
// JSON, or is missing every field, decodes to a zero Request rather than an
// error, so a socket line from something other than the hook is answered
// (or ignored) the same way it always was — never a crash.
func ParseRequest(line []byte) Request {
	var r Request
	_ = json.Unmarshal(line, &r)
	return r
}

// EventFrame turns an admitted hook line into the frame the relay
// dispatches on. Mirrors relay_client.hpp's relay_event_frame: empty verb or
// path means the relay would only drop the frame anyway, so the caller gets
// an empty slice and pushes nothing. root normalizes the path through
// repo.RegionKey before it goes out — this is the one place an outbound
// event frame is built, so it is the one place that has to do it: two
// checkouts of the same repo send the same region key, or the room they
// share is worthless.
func EventFrame(req Request, root string) []byte {
	if req.Verb == "" || req.Path == "" {
		return nil
	}
	ev := wire.Event{
		Type:   "event",
		Source: "hook",
		Verb:   req.Verb,
		Agent:  req.Agent,
		Human:  req.Human,
		Region: wire.Region{Path: repo.RegionKeyResolved(root, req.Path)},
	}
	return wire.Marshal(ev)
}

// ContendFrame mirrors relay_client.hpp's relay_contend_frame: a whole-file
// region, which is what the hook asked about. Normalized the same way
// EventFrame's region is — a contend frame with the raw path would start
// the handover clock under a name the matching lease was never filed
// under, and the wait would never resolve.
func ContendFrame(path string, root string) []byte {
	if path == "" {
		return nil
	}
	return wire.Marshal(wire.Contend{Type: "contend", Region: wire.Region{Path: repo.RegionKeyResolved(root, path)}})
}
