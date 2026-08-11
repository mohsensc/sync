package presence

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestTouchReportsChangeOnlyWhenSomethingMoved(t *testing.T) {
	tbl := NewTable(1000)
	if !tbl.Touch("a1", "mohsen", "edit", "x.py", 0) {
		t.Fatal("first sighting must always be a change")
	}
	if tbl.Touch("a1", "mohsen", "edit", "x.py", 1) {
		t.Fatal("a repeat of the same thing must not be a change")
	}
	if !tbl.Touch("a1", "mohsen", "edit", "y.py", 2) {
		t.Fatal("a different path must be a change")
	}
}

func TestExpireDropsQuietAgents(t *testing.T) {
	tbl := NewTable(1000)
	tbl.Touch("a1", "mohsen", "edit", "x.py", 0)
	if tbl.Expire(500) {
		t.Fatal("must not expire before the ttl")
	}
	if !tbl.Expire(1000) {
		t.Fatal("must expire at the ttl")
	}
	if tbl.Len() != 0 {
		t.Fatal("expired agent must be gone")
	}
}

func TestPeersPreservesFirstSeenOrder(t *testing.T) {
	tbl := NewTable(1000)
	tbl.Touch("a3", "third", "edit", "c.py", 0)
	tbl.Touch("a1", "first", "edit", "a.py", 1)
	tbl.Touch("a2", "second", "edit", "b.py", 2)
	tbl.Touch("a1", "first", "edit", "a2.py", 3) // repeat touch must not reshuffle

	peers := tbl.Peers()
	got := []string{peers[0].Human, peers[1].Human, peers[2].Human}
	want := []string{"third", "first", "second"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v want %v", got, want)
		}
	}
}

func TestWriteSnapshotEscapingMatchesWhatTheStatuslineUnescapes(t *testing.T) {
	path := filepath.Join(t.TempDir(), "snap.json")
	peers := []Peer{{Human: `sara "the fox" \work`, Verb: "edit", Path: "a.py"}}
	if err := WriteSnapshot(path, peers, ""); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	// Must be valid JSON a real parser can read...
	var decoded map[string]any
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("not valid json: %s: %v", data, err)
	}
	// ...and for input like this — no control bytes, nothing HTML-unsafe —
	// encoding/json's escaping (backslash before " and before \) happens to
	// be exactly what scripts/statusline-presence.sh unescapes, which is why
	// that script needed no changes to go with this file switching writers.
	want := `{"peers":[{"human":"sara \"the fox\" \\work","verb":"edit","path":"a.py"}]}`
	if string(data) != want {
		t.Fatalf("got  %s\nwant %s", data, want)
	}
}

func TestWriteSnapshotProblemFieldOnlyWhenNonEmpty(t *testing.T) {
	dir := t.TempDir()
	healthy := filepath.Join(dir, "healthy.json")
	if err := WriteSnapshot(healthy, nil, ""); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(healthy)
	if string(data) != `{"peers":[]}` {
		t.Fatalf("a healthy snapshot must carry no policy fields at all: %s", data)
	}

	// A newline in the problem text is escaped, not collapsed to a space:
	// encoding/json keeps the file one line on its own, so there is no
	// reason left to lose a byte of the original message doing it by hand.
	degraded := filepath.Join(dir, "degraded.json")
	if err := WriteSnapshot(degraded, nil, "cache is bad\nwith a newline"); err != nil {
		t.Fatal(err)
	}
	data, _ = os.ReadFile(degraded)
	want := `{"peers":[],"policy_degraded":true,"policy_problem":"cache is bad\nwith a newline"}`
	if string(data) != want {
		t.Fatalf("got  %s\nwant %s", data, want)
	}
	if bytes.Contains(data, []byte{'\n'}) {
		t.Fatalf("a raw newline broke the one-line contract: %s", data)
	}
}

func TestWriteSnapshotIsAtomic(t *testing.T) {
	path := filepath.Join(t.TempDir(), "snap.json")
	if err := WriteSnapshot(path, []Peer{{Human: "a"}}, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path + ".tmp"); !os.IsNotExist(err) {
		t.Fatal("the .tmp file must be renamed away, not left behind")
	}
}

// --- rung 1: reading what somebody else is editing ------------------------

func TestPeersMarksRung1WhenAnotherAgentEditsTheSamePath(t *testing.T) {
	tbl := NewTable(1000)
	tbl.Touch("reader", "dev", "read", "auth.py", 0)
	tbl.Touch("editor", "sara", "edit", "auth.py", 0)

	peers := tbl.Peers()
	byHuman := map[string]Peer{}
	for _, p := range peers {
		byHuman[p.Human] = p
	}
	if byHuman["dev"].Rung != 1 {
		t.Fatalf("reader must be marked rung 1, got %+v", byHuman["dev"])
	}
	if byHuman["sara"].Rung != 0 {
		t.Fatalf("the editor itself is not what rung 1 is about: got %+v", byHuman["sara"])
	}
}

func TestPeersDoesNotMarkRungWithoutAConflict(t *testing.T) {
	tbl := NewTable(1000)
	tbl.Touch("reader", "dev", "read", "auth.py", 0)
	tbl.Touch("editor", "sara", "edit", "other.py", 0) // different file

	for _, p := range tbl.Peers() {
		if p.Rung != 0 {
			t.Fatalf("no conflict here, got %+v", p)
		}
	}
}

func TestPeersDoesNotMarkTwoReadersAsRung1(t *testing.T) {
	tbl := NewTable(1000)
	tbl.Touch("a1", "dev", "read", "auth.py", 0)
	tbl.Touch("a2", "sara", "read", "auth.py", 0)

	for _, p := range tbl.Peers() {
		if p.Rung != 0 {
			t.Fatalf("rung 1 needs an editor, not another reader: got %+v", p)
		}
	}
}

func TestPeersDoesNotCollideAnAgentWithItself(t *testing.T) {
	// One agent, one entry: it cannot be "the other agent editing" for its
	// own read, even though the same id is the only one in the table.
	tbl := NewTable(1000)
	tbl.Touch("solo", "dev", "read", "auth.py", 0)

	peers := tbl.Peers()
	if len(peers) != 1 || peers[0].Rung != 0 {
		t.Fatalf("a lone reader is never rung 1: got %+v", peers)
	}
}

func TestWriteSnapshotOmitsRungWhenZero(t *testing.T) {
	path := filepath.Join(t.TempDir(), "snap.json")
	if err := WriteSnapshot(path, []Peer{{Human: "sara", Verb: "edit", Path: "a.py"}}, ""); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(path)
	want := `{"peers":[{"human":"sara","verb":"edit","path":"a.py"}]}`
	if string(data) != want {
		t.Fatalf("got  %s\nwant %s", data, want)
	}
}

func TestWriteSnapshotIncludesRungWhenSet(t *testing.T) {
	path := filepath.Join(t.TempDir(), "snap.json")
	if err := WriteSnapshot(path, []Peer{{Human: "dev", Verb: "read", Path: "a.py", Rung: 1}}, ""); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(path)
	want := `{"peers":[{"human":"dev","verb":"read","path":"a.py","rung":1}]}`
	if string(data) != want {
		t.Fatalf("got  %s\nwant %s", data, want)
	}
}
