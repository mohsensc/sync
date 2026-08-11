// Package presence is who is currently doing what, plus the snapshot file
// the statusline reads — the Go mirror of cpp/daemon/snapshot.{hpp,cpp}.
//
// The statusline (scripts/statusline-presence.sh) has no other source of
// truth and parses the file with hand-rolled bash, not a JSON library: it
// unescapes exactly `\\` and `\"` and nothing else. That is what
// cpp/daemon/snapshot.cpp's escape() produces, so the writer here builds
// the same bytes by hand rather than through encoding/json, which would
// additionally escape `<`, `>`, `&` and Unicode line separators that the
// bash side has no rule for.
package presence

import (
	"os"
	"sort"
	"strconv"
	"strings"
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
// silence. Safe for concurrent use.
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

// escape prefixes a backslash onto `"` and `\` and nothing else — the exact
// rule cpp/daemon/snapshot.cpp's escape() applies, and the exact rule
// scripts/statusline-presence.sh unescapes.
func escape(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, c := range []byte(s) {
		if c == '"' || c == '\\' {
			b.WriteByte('\\')
		}
		b.WriteByte(c)
	}
	return b.String()
}

// oneLine turns control bytes into spaces so a path with a newline in it
// cannot break the snapshot's one-line-of-JSON contract — same as
// snapshot.cpp's one_line().
func oneLine(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, c := range []byte(s) {
		if c < 0x20 {
			b.WriteByte(' ')
		} else {
			b.WriteByte(c)
		}
	}
	return b.String()
}

// WriteSnapshot writes the statusline's file atomically: a temp file, then
// rename, so the statusline (which polls once a second) never observes a
// partial write. problem is only written when non-empty — a healthy
// snapshot is byte for byte what it always was.
func WriteSnapshot(path string, peers []Peer, problem string) error {
	var b strings.Builder
	b.WriteString(`{"peers":[`)
	for i, p := range peers {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(`{"human":"`)
		b.WriteString(escape(p.Human))
		b.WriteString(`","verb":"`)
		b.WriteString(escape(p.Verb))
		b.WriteString(`","path":"`)
		b.WriteString(escape(p.Path))
		b.WriteString(`"`)
		if p.Rung > 0 {
			b.WriteString(`,"rung":`)
			b.WriteString(strconv.Itoa(p.Rung))
		}
		b.WriteString(`}`)
	}
	b.WriteString(`]`)
	if problem != "" {
		b.WriteString(`,"policy_degraded":true,"policy_problem":"`)
		b.WriteString(escape(oneLine(problem)))
		b.WriteString(`"`)
	}
	b.WriteString(`}`)

	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(b.String()), 0o644); err != nil {
		return err // fail open: a missing snapshot just blanks the statusline
	}
	return os.Rename(tmp, path)
}
