// SPIKE: relay rewrite prototype (docs/relay-spike.md). Not wired into any
// build, not the product.
//
// Frame shapes mirrored from go/internal/wire (the daemon's Go client) and
// python/src/agent_presence/relay.py's _lease_entry -- same field names, so
// tests/load's Client (a real python/websockets client, not a stub) can talk
// to this relay unmodified. Duplicated rather than imported: this lives
// outside the go/ module on purpose (see docs/relay-spike.md, "what this
// does not do"), and Go's internal/ visibility rule wouldn't let a package
// outside github.com/mohsensc/sync/go import go/internal/wire even with a
// replace directive.
package main

import "encoding/json"

type region struct {
	Path   string  `json:"path"`
	Symbol *string `json:"symbol"`
	Lines  []int   `json:"lines"`
}

type joinFrame struct {
	Type  string `json:"type"`
	Room  string `json:"room"`
	Agent string `json:"agent"`
	Human string `json:"human"`
}

type claimFrame struct {
	Type   string `json:"type"`
	Region region `json:"region"`
	Intent string `json:"intent"`
}

type releaseFrame struct {
	Type   string `json:"type"`
	Region region `json:"region"`
}

type heartbeatFrame struct {
	Type   string `json:"type"`
	Region region `json:"region"`
}

type envelope struct {
	Type string `json:"type"`
}

// claimResult answers the actor only -- never broadcast. Mirrors
// relay.py's claim reply shape closely enough for tests/load's Client,
// which only reads `granted` and `held_by`.
type claimResult struct {
	Type    string `json:"type"`
	Granted bool   `json:"granted"`
	HeldBy  string `json:"held_by,omitempty"`
	Region  region `json:"region"`
}

// leaseEntry mirrors relay.py's _lease_entry. expires_in_ms is duration off
// the relay's clock, never an absolute timestamp -- same rule the Go daemon
// client documents in go/internal/wire.
type leaseEntry struct {
	Agent       string `json:"agent"`
	Human       string `json:"human"`
	Intent      string `json:"intent"`
	Priority    string `json:"priority"`
	Region      region `json:"region"`
	ExpiresInMs int64  `json:"expires_in_ms"`
}

// leaseHeldFrame is what goes out on a grant or a renewal.
type leaseHeldFrame struct {
	Type  string `json:"type"`
	State string `json:"state"`
	leaseEntry
}

// leaseGoneFrame is what goes out on release. Plain map for expired/handover
// states isn't needed here -- this prototype's hot path is claim/release,
// not the full expiry/handover state machine (see docs/relay-spike.md,
// "what this does not do").
type leaseGoneFrame struct {
	Type   string `json:"type"`
	State  string `json:"state"`
	Agent  string `json:"agent"`
	Region region `json:"region"`
}

type leasesSnapshot struct {
	Type   string       `json:"type"`
	Leases []leaseEntry `json:"leases"`
}

func marshal(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		panic("wire: unmarshalable frame: " + err.Error())
	}
	return b
}

func regionKey(r region) string {
	sym := ""
	if r.Symbol != nil {
		sym = *r.Symbol
	}
	return r.Path + "\x00" + sym
}
