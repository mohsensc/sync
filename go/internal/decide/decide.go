// Package decide answers the hook's half of the unix-socket protocol
// (hook/protocol.hpp) and turns an admitted hook line into the frame the
// relay expects. It is the Go mirror of cpp/daemon/decide.cpp.
package decide

import (
	"encoding/json"

	"github.com/mohsensc/sync/go/internal/leases"
	"github.com/mohsensc/sync/go/internal/policy"
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
// can produce, across both the rung-0 (ambient) and rung-3 (blocked) paths.
type Response struct {
	Rung           int    `json:"rung"`
	Effect         string `json:"effect"`
	Decision       string `json:"decision,omitempty"`
	Holder         string `json:"holder,omitempty"`
	Human          string `json:"human,omitempty"`
	Intent         string `json:"intent,omitempty"`
	HolderPriority string `json:"holder_priority,omitempty"`
	ExpiresInMs    int64  `json:"expires_in_ms,omitempty"`

	HandoverInMs       int64  `json:"handover_in_ms,omitempty"`
	HandoverTo         string `json:"handover_to,omitempty"`
	HandoverToHuman    string `json:"handover_to_human,omitempty"`
	HandoverToPriority string `json:"handover_to_priority,omitempty"`
	HandoverToMe       bool   `json:"handover_to_me,omitempty"`
	Waiting            int    `json:"waiting,omitempty"`

	LostTo         string `json:"lost_to,omitempty"`
	LostToAgent    string `json:"lost_to_agent,omitempty"`
	LostToPriority string `json:"lost_to_priority,omitempty"`
	LostMsAgo      int64  `json:"lost_ms_ago,omitempty"`
}

func leftMs(atMs, nowMs int64) int64 {
	if atMs > nowMs {
		return atMs - nowMs
	}
	return 0
}

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
	r.LostMsAgo = ago
}

// ambientResponse is decide.cpp's ambient_response: the two things a
// non-blocked agent may still need to hear — that a region it holds has a
// deadline, and that a region it held has gone.
func ambientResponse(cache *leases.Cache, pol *policy.Cache, path, agent string, nowMs int64) Response {
	r := openResponse(0, pol.EffectFor(0))

	if mine, ok := cache.OwnHandover(path, agent, nowMs); ok {
		r.HandoverInMs = leftMs(mine.HandoverAtMs, nowMs)
		r.HandoverTo = mine.HandoverTo
		r.HandoverToHuman = mine.HandoverToHuman
		r.HandoverToPriority = mine.HandoverToPriority
		if mine.Waiting > 0 {
			r.Waiting = mine.Waiting
		}
		return r
	}

	if lost, ok := cache.HandoverNoteFor(path, nowMs, leases.HandoverNoteMs); ok {
		appendLost(&r, lost, nowMs)
	}
	return r
}

// Decide is decide_response: a live lease on the file held by somebody else
// is rung 3; anything else is rung 0, with the ambient handover/lost-region
// notes folded in. selfAgent is the id this daemon joined the room under;
// empty means no room is configured and the request's own agent (the
// hook's session id) is used instead — see decide.hpp's note on why those
// are different namespaces.
func Decide(req Request, cache *leases.Cache, pol *policy.Cache, nowMs int64, selfAgent string) Response {
	agent := selfAgent
	if agent == "" {
		agent = req.Agent
	}

	if req.Path == "" || req.Verb != "edit" {
		return openResponse(0, pol.EffectFor(0))
	}

	held, ok := cache.ConflictForFile(req.Path, agent, nowMs)
	if !ok {
		return ambientResponse(cache, pol, req.Path, agent, nowMs)
	}

	r := openResponse(3, pol.EffectFor(3))
	r.Holder = held.Agent
	r.Human = held.Human
	r.Intent = held.Intent
	r.HolderPriority = held.Priority
	r.ExpiresInMs = leftMs(held.ExpiresAtMs, nowMs)

	if held.HasHandover {
		r.HandoverInMs = leftMs(held.HandoverAtMs, nowMs)
		r.HandoverTo = held.HandoverTo
		if agent != "" && held.HandoverTo == agent {
			r.HandoverToMe = true
		}
		if held.Waiting > 0 {
			r.Waiting = held.Waiting
		}
	}

	if lost, ok := cache.HandoverNoteFor(req.Path, nowMs, leases.HandoverNoteMs); ok {
		appendLost(&r, lost, nowMs)
	}
	return r
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
// an empty slice and pushes nothing.
func EventFrame(req Request) []byte {
	if req.Verb == "" || req.Path == "" {
		return nil
	}
	ev := wire.Event{
		Type:   "event",
		Source: "hook",
		Verb:   req.Verb,
		Agent:  req.Agent,
		Human:  req.Human,
		Region: wire.Region{Path: req.Path},
	}
	return wire.Marshal(ev)
}

// ContendFrame mirrors relay_client.hpp's relay_contend_frame: a whole-file
// region, which is what the hook asked about.
func ContendFrame(path string) []byte {
	if path == "" {
		return nil
	}
	return wire.Marshal(wire.Contend{Type: "contend", Region: wire.Region{Path: path}})
}
