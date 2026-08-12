// Package presence is who is currently doing what, plus the snapshot file
// the statusline reads.
//
// The statusline (scripts/statusline-presence.sh) has no other source of
// truth and parses the file with hand-rolled bash, not a JSON library: it
// unescapes exactly `\\` and `\"` and nothing else. WriteSnapshot used to
// hand-write those same two escapes to match — the one daemon-side hand-
// rolled JSON writer left after #19 — which meant a peer path holding a raw
// newline broke the file's one-line contract instead of being escaped into
// it, since nothing but `"` and `\` ever got touched. encoding/json escapes
// every control byte and always produces one line, so it is a strict
// improvement, not just a style change; it also happens to produce byte-
// identical output to the old hand-rolled escaping for every case the bash
// side already handles (quote, backslash, plain UTF-8), which is why
// scripts/statusline-presence.sh needed no changes to go with it — see
// python/tests/test_statusline_presence.py's e2e cases, which exercise this
// writer for real rather than a stand-in.
package presence

import (
	"bytes"
	"encoding/json"
	"os"
	"sort"
	"sync"
)

// Peer is one line of the snapshot's "peers" array.
type Peer struct {
	Human string
	Verb  string
	Path  string
	// Rung is the ladder rung this peer's own activity reaches against
	// everyone else in the table, computed by Peers. 0 (the zero value,
	// omitted on the wire) covers every case but one: a peer reading a
	// file somebody else is editing is rung 1 — see Peers' doc comment
	// for why this is the only place that rung is ever computed.
	Rung int
}

type entry struct {
	human, verb, path string
	seenMs            int64
	seq               int64
}

// Table tracks who is doing what, dropping an agent after ttlMs of
// silence. Safe for concurrent use. Plain mutex, not a channel-owned
// goroutine (#20): every caller is the event path (onLine, one goroutine
// per accepted connection) or the tick, never the decision path — see
// docs/go-daemon.md's "every remaining mutex, checked on merit" section.
type Table struct {
	ttlMs int64
	mu    sync.Mutex
	seq   int64
	byID  map[string]entry
}

func NewTable(ttlMs int64) *Table {
	return &Table{ttlMs: ttlMs, byID: make(map[string]entry)}
}

// Touch records an event. Returns true when the snapshot would look
// different, which is the only time it is worth rewriting the file.
func (t *Table) Touch(agent, human, verb, path string, nowMs int64) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	e, ok := t.byID[agent]
	if !ok {
		t.byID[agent] = entry{human: human, verb: verb, path: path, seenMs: nowMs, seq: t.seq}
		t.seq++
		return true
	}
	changed := e.human != human || e.verb != verb || e.path != path
	e.human, e.verb, e.path, e.seenMs = human, verb, path, nowMs
	t.byID[agent] = e
	return changed
}

// Expire forgets agents that have gone quiet. Returns true if any were
// dropped.
func (t *Table) Expire(nowMs int64) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	dropped := false
	for id, e := range t.byID {
		if nowMs-e.seenMs >= t.ttlMs {
			delete(t.byID, id)
			dropped = true
		}
	}
	return dropped
}

// Peers returns first-seen order, so the statusline does not reshuffle
// every tick, with rung 1 filled in wherever it applies.
//
// Rung 1 — "A editing, B reading" — is the one rung that never reaches
// decide.Decide: it only exists when the *incoming* action is a read, and
// a read never asks for a decision at all (hook.cpp's wants_decision only
// sends want:"decision" for a PreToolUse edit). The table this method
// reads is fed from both this machine's own hook events and every other
// daemon's presence broadcast, so it already has everything rung 1 needs —
// who is reading what, and who else is editing that same path — without
// any new plumbing. This is the whole of the computation: no interrupt,
// no lease, just two entries in the same table.
func (t *Table) Peers() []Peer {
	t.mu.Lock()
	defer t.mu.Unlock()
	type ordered struct {
		entry
		id string
	}
	all := make([]ordered, 0, len(t.byID))
	for id, e := range t.byID {
		all = append(all, ordered{e, id})
	}
	sort.Slice(all, func(i, j int) bool { return all[i].seq < all[j].seq })

	out := make([]Peer, len(all))
	for i, e := range all {
		rung := 0
		if e.verb == "read" && e.path != "" {
			for _, o := range all {
				if o.id == e.id {
					continue
				}
				if o.verb == "edit" && o.path == e.path {
					rung = 1
					break
				}
			}
		}
		out[i] = Peer{Human: e.human, Verb: e.verb, Path: e.path, Rung: rung}
	}
	return out
}

func (t *Table) Len() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return len(t.byID)
}

// peerWire is one entry of the snapshot's "peers" array. Field order and
// names are the wire contract scripts/statusline-presence.sh scans for by
// exact substring (`"human":"`), so both stay put.
type peerWire struct {
	Human string `json:"human"`
	Verb  string `json:"verb"`
	Path  string `json:"path"`
	Rung  int    `json:"rung,omitempty"`
}

// snapshotWire is the whole file. PolicyDegraded/PolicyProblem carry
// omitempty so a healthy snapshot — the common case, written once a second —
// stays exactly `{"peers":[...]}` with no trailing policy fields at all.
type snapshotWire struct {
	Peers          []peerWire `json:"peers"`
	PolicyDegraded bool       `json:"policy_degraded,omitempty"`
	PolicyProblem  string     `json:"policy_problem,omitempty"`
}

// WriteSnapshot writes the statusline's file atomically: a temp file, then
// rename, so the statusline (which polls once a second) never observes a
// partial write. problem is only written when non-empty.
func WriteSnapshot(path string, peers []Peer, problem string) error {
	sw := snapshotWire{Peers: make([]peerWire, len(peers))}
	for i, p := range peers {
		sw.Peers[i] = peerWire{Human: p.Human, Verb: p.Verb, Path: p.Path, Rung: p.Rung}
	}
	if problem != "" {
		sw.PolicyDegraded = true
		sw.PolicyProblem = problem
	}

	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	// The bash reader has no rule for `<`-style escapes, so this stays
	// off — matching the old hand-rolled writer, which never escaped `<`,
	// `>` or `&` either.
	enc.SetEscapeHTML(false)
	if err := enc.Encode(sw); err != nil {
		return err // fail open: a missing snapshot just blanks the statusline
	}
	// Encode appends a trailing newline; the file is defined as one line.
	data := bytes.TrimRight(buf.Bytes(), "\n")

	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
