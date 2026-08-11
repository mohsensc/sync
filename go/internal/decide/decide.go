// Package decide answers the hook's half of the unix-socket protocol
// (hook/protocol.hpp) and turns an admitted hook line into the frame the
// relay expects. It is the Go mirror of cpp/daemon/decide.cpp, narrowed to
// what wave 1 ports — see the package doc on Response for the cut line.
package decide

import (
	"encoding/json"

	"github.com/mohsensc/sync/go/internal/leases"
	"github.com/mohsensc/sync/go/internal/wire"
)

// Effect names, in rung order — hook/protocol.hpp's kEffectNames. The one
// place they are spelled, same rule as the C++ side.
const (
	EffectSilent  = "silent"
	EffectNotify  = "notify"
	EffectContext = "context"
	EffectAsk     = "ask"
	EffectDeny    = "deny"
)

// builtinFloor is policy_cache.hpp's kBuiltinFloor: the compiled-in effect
// per rung when no org policy has been loaded. Wave 1 does not wire the live
// "policy" frame into this table — see docs/go-daemon.md — so a Go daemon
// answers with these defaults for the lifetime of the process, same as a
// C++ daemon that has never received one.
var builtinFloor = [5]string{EffectSilent, EffectNotify, EffectContext, EffectDeny, EffectContext}

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

// Response is the line written back to the hook. Only the rung-0 and rung-3
// fields decide.cpp produces are here: no handover_in_ms / lost_to (own
// lease/handover notes — leases.Cache does not track handovers in wave 1)
// and no priority-clamped effect beyond the builtin floor.
type Response struct {
	Rung           int    `json:"rung"`
	Effect         string `json:"effect"`
	Decision       string `json:"decision,omitempty"`
	Holder         string `json:"holder,omitempty"`
	Human          string `json:"human,omitempty"`
	Intent         string `json:"intent,omitempty"`
	HolderPriority string `json:"holder_priority,omitempty"`
	ExpiresInMs    int64  `json:"expires_in_ms,omitempty"`
}

func rung0() Response {
	return Response{Rung: 0, Effect: builtinFloor[0]}
}

// Decide is decide_response's rung-0/rung-3 path: a live lease on the file,
// held by somebody else, is rung 3; anything else is rung 0. selfAgent is
// the id this daemon joined the room under; empty means no room is
// configured and the request's own agent (the hook's session id) is used
// instead, exactly as decide.hpp documents.
func Decide(req Request, cache *leases.Cache, nowMs int64, selfAgent string) Response {
	if req.Path == "" || req.Verb != "edit" {
		return rung0()
	}
	agent := selfAgent
	if agent == "" {
		agent = req.Agent
	}
	held, ok := cache.ConflictForFile(req.Path, agent, nowMs)
	if !ok {
		return rung0()
	}

	resp := Response{
		Rung:           3,
		Effect:         builtinFloor[3],
		Holder:         held.Agent,
		Human:          held.Human,
		Intent:         held.Intent,
		HolderPriority: held.Priority,
		ExpiresInMs:    held.ExpiresAtMs - nowMs,
	}
	if resp.Effect == EffectAsk {
		resp.Decision = EffectAsk // legacy field pre-dating effects; see decide.cpp
	}
	return resp
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
