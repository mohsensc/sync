// Package wire is the JSON shape of the frames the daemon and the Python
// relay exchange, and the ones the hook and the daemon exchange over the
// unix socket. It is the Go mirror of cpp/daemon/relay_client.{hpp,cpp} and
// hook/protocol.hpp, kept to the same field names on purpose: the relay does
// not know which language sent a frame, so nothing here may drift from what
// python/src/agent_presence/relay.py and serve.py actually read.
package wire

import "encoding/json"

// Region is a path plus an optional symbol. Both are always spelled out on
// the wire, symbol and lines as explicit null rather than omitted, because
// that is the shape redact._clean_region always produces and the relay never
// special-cases a missing key.
type Region struct {
	Path   string  `json:"path"`
	Symbol *string `json:"symbol"`
	Lines  []int   `json:"lines"`
}

// Join is the first frame on every connection. principal/token/unattended
// are the identity band described in cpp/daemon/relay_client.hpp's
// RelayConfig; omitempty on all three means an unconfigured install puts
// exactly the bytes on the wire it always did.
type Join struct {
	Type       string `json:"type"`
	Room       string `json:"room"`
	Agent      string `json:"agent"`
	Human      string `json:"human"`
	Principal  string `json:"principal,omitempty"`
	Token      string `json:"token,omitempty"`
	Unattended bool   `json:"unattended,omitempty"`
}

// Event is the one-way frame a hook line becomes. source is always "hook":
// the daemon makes no claims of its own.
type Event struct {
	Type   string `json:"type"`
	Source string `json:"source"`
	Verb   string `json:"verb"`
	Agent  string `json:"agent"`
	Human  string `json:"human"`
	Region Region `json:"region"`
}

// Contend is "I was stopped here and I want it" — see
// cpp/daemon/relay_client.hpp's relay_contend_frame. It takes no lease; it
// only starts the handover clock on the current holder.
type Contend struct {
	Type   string `json:"type"`
	Region Region `json:"region"`
}

// Envelope reads only the "type" field, which is all that is needed to
// decide how to unmarshal the rest of an inbound frame.
type Envelope struct {
	Type string `json:"type"`
}

// Presence is a peer touch fanned out from another daemon in the room.
type Presence struct {
	Agent  string `json:"agent"`
	Human  string `json:"human"`
	Verb   string `json:"verb"`
	Region Region `json:"region"`
}

// LeaseFrame is the body shared by the "lease", "leases" (per element) and
// "claim_result" frames — see relay.py's _lease_entry. One flat struct
// rather than three, because the wire shape genuinely is one shape used
// three ways: Decode whichever fields the frame in hand carries and ignore
// the rest. Numeric fields are durations off the relay's wall clock, never
// absolute timestamps — see relay.applyLease.
type LeaseFrame struct {
	Agent              string   `json:"agent"`
	Human              string   `json:"human"`
	Intent             string   `json:"intent"`
	Priority           string   `json:"priority"`
	HolderPriority     string   `json:"holder_priority"`
	Region             Region   `json:"region"`
	ExpiresInMs        *float64 `json:"expires_in_ms"`
	HandoverInMs       *float64 `json:"handover_in_ms"`
	HandoverTo         string   `json:"handover_to"`
	HandoverToHuman    string   `json:"handover_to_human"`
	HandoverToPriority string   `json:"handover_to_priority"`
	Waiting            int      `json:"waiting"`

	// "lease" only: state distinguishes a grant/renewal from an erase, and
	// to/to_human/to_priority name the new holder on a handover.
	State      string `json:"state"`
	To         string `json:"to"`
	ToHuman    string `json:"to_human"`
	ToPriority string `json:"to_priority"`

	// "claim_result" only. Wave 1 never sends a claim frame — that is the
	// MCP tool's path, not the daemon's — so these are parsed for
	// completeness and presently unused.
	Granted bool   `json:"granted"`
	HeldBy  string `json:"held_by"`
}

// Leases is the full-table snapshot sent on join and after a relay restart.
// Presence rides along on the same frame — see relay.py's
// _send_lease_snapshot (#31) — additive, so a reader that only ever looked
// for "leases" there (the daemon included) keeps working unchanged.
type Leases struct {
	Type     string                  `json:"type"`
	Leases   []LeaseFrame            `json:"leases"`
	Presence []PresenceSnapshotEntry `json:"presence,omitempty"`
}

// PresenceSnapshotEntry is one entry of the join reply's presence array:
// recent hook-observed activity a joiner missed because it wasn't in the
// room yet. Same shape a live Presence frame carries, plus the relay's own
// wall-clock timestamp — see relay.py's _presence_snapshot.
type PresenceSnapshotEntry struct {
	Agent  string  `json:"agent"`
	Human  string  `json:"human"`
	Verb   string  `json:"verb"`
	Region Region  `json:"region"`
	Ts     float64 `json:"ts"`
}

// Claim is a claim-capable client's request to hold a region — the frame
// the MCP tool surface sends for claim_work. The daemon never sends this:
// it observes leases, it doesn't take them.
type Claim struct {
	Type   string `json:"type"`
	Region Region `json:"region"`
	Intent string `json:"intent"`
}

// MoveRequest is a reply to a contested claim — DEFER, SPLIT, HANDOFF or
// PROCEED — the frame the MCP tool surface's respond tool sends. Named
// MoveRequest rather than Move to keep it apart from wire.Presence's Verb
// vocabulary at a glance; the relay's own reply to this frame is
// "move_result", read the same ad hoc way claim_result is.
type MoveRequest struct {
	Type   string `json:"type"`
	Region Region `json:"region"`
	Move   string `json:"move"`
	Reason string `json:"reason"`
}

// ReleaseRequest gives up a previously claimed region. No reply travels for
// this one — the room hears about it, not the releaser (relay.py's
// Relay.publish never echoes back to the sender).
type ReleaseRequest struct {
	Type   string `json:"type"`
	Region Region `json:"region"`
}

// Policy carries the org floor. floor is five effect names in rung order;
// see hook/protocol.hpp's kEffectNames for the vocabulary.
type Policy struct {
	Floor  []string `json:"floor"`
	Source string   `json:"source"`
	Digest string   `json:"digest"`
}

// JoinRefused explains why the relay dropped a join. Reaching this in wave 1
// just means the client logs it and stays in backoff; principal enforcement
// itself is unchanged, the relay is unaware of this client's language.
type JoinRefused struct {
	Room   string `json:"room"`
	Reason string `json:"reason"`
	Detail string `json:"detail"`
}

// Marshal is a thin wrapper so callers don't sprinkle error-ignoring
// json.Marshal calls everywhere; every type above is built from plain
// strings and numbers and cannot fail to encode.
func Marshal(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		// Every struct in this package is strings, bools and *float64 —
		// nothing that can fail to marshal. A panic here would be a bug in
		// this file, not a runtime condition to recover from.
		panic("wire: unmarshalable frame: " + err.Error())
	}
	return b
}
