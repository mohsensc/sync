package mcptools

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/mohsensc/sync/go/internal/mcprelay"
	"github.com/mohsensc/sync/go/internal/metrics"
	"github.com/mohsensc/sync/go/internal/wire"
)

// Port of the wire-facing half of python/tests/test_mcp_tools.py: a real
// websocket relay (not a mock of Tools' own dependency), exercising the
// tool surface's reply shapes and, in
// TestClaimViaOneToolsBlocksASecondIndependentConnection, that a claim
// made through this package actually reaches a second connection — the
// exact bug issue #12 fixed in Python.

type scriptedRelay struct {
	upgrader websocket.Upgrader

	mu   sync.Mutex
	held map[string]held
}

type held struct {
	agent, human, intent string
}

func newScriptedRelay() *scriptedRelay {
	return &scriptedRelay{held: make(map[string]held)}
}

func (r *scriptedRelay) handler(w http.ResponseWriter, req *http.Request) {
	conn, err := r.upgrader.Upgrade(w, req, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	var agent, human string
	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		var env wire.Envelope
		if err := json.Unmarshal(data, &env); err != nil {
			continue
		}
		switch env.Type {
		case "join":
			var j wire.Join
			json.Unmarshal(data, &j)
			agent, human = j.Agent, j.Human
			if err := conn.WriteJSON(wire.Leases{Type: "leases"}); err != nil {
				return
			}
		case "claim":
			var c wire.Claim
			json.Unmarshal(data, &c)
			reply := r.claim(c.Region.Path, agent, human, c.Intent)
			if err := conn.WriteJSON(reply); err != nil {
				return
			}
		case "release":
			var rl wire.ReleaseRequest
			json.Unmarshal(data, &rl)
			r.mu.Lock()
			delete(r.held, rl.Region.Path)
			r.mu.Unlock()
		case "move":
			var m wire.MoveRequest
			json.Unmarshal(data, &m)
			var reply map[string]any
			switch m.Move {
			case "HANDOFF":
				r.mu.Lock()
				delete(r.held, m.Region.Path)
				r.mu.Unlock()
				reply = map[string]any{"type": "move_result", "granted": false, "action": "handoff"}
			case "DEFER":
				reply = map[string]any{"type": "move_result", "granted": false, "action": "defer"}
			case "PROCEED":
				reply = map[string]any{"type": "move_result", "granted": true, "action": "proceed"}
			default:
				reply = map[string]any{"type": "move_result", "granted": false, "action": m.Move}
			}
			if err := conn.WriteJSON(reply); err != nil {
				return
			}
		}
	}
}

func (r *scriptedRelay) claim(path, agent, human, intent string) map[string]any {
	r.mu.Lock()
	defer r.mu.Unlock()
	h, taken := r.held[path]
	if !taken {
		r.held[path] = held{agent: agent, human: human, intent: intent}
		return map[string]any{"type": "claim_result", "granted": true}
	}
	if h.agent == agent {
		return map[string]any{"type": "claim_result", "granted": true}
	}
	return map[string]any{
		"type": "claim_result", "granted": false,
		"held_by": h.agent, "human": h.human, "intent": h.intent, "decision": "abort",
	}
}

func startScriptedRelay(t *testing.T) (url string, relay *scriptedRelay, stop func()) {
	t.Helper()
	relay = newScriptedRelay()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(relay.handler)}
	go srv.Serve(ln)
	return "ws://" + ln.Addr().String() + "/", relay, func() { srv.Close() }
}

func newTestTools(url, root, room, agent, human string) *Tools {
	tools, _ := newTestToolsWithMetrics(url, root, room, agent, human)
	return tools
}

// newTestToolsWithMetrics is newTestTools plus a handle on the registry it
// wired in, for tests that need to inspect what got recorded.
func newTestToolsWithMetrics(url, root, room, agent, human string) (*Tools, *metrics.Registry) {
	reg := metrics.New()
	conn := mcprelay.New(mcprelay.Config{
		URL: url, Room: room, Agent: agent, Human: human,
		ConnectTimeout: 2 * time.Second, RequestTimeout: 2 * time.Second,
		Metrics: reg,
	})
	return NewTools(conn, root, room, agent, human, reg), reg
}

func TestWhoElseIsHereIsEmptyWhenAlone(t *testing.T) {
	url, _, stop := startScriptedRelay(t)
	defer stop()
	tools := newTestTools(url, "", "r1", "a1", "sara")
	defer tools.Close()

	peers := tools.WhoElseIsHere(context.Background())
	if len(peers) != 0 {
		t.Fatalf("got %+v, want none", peers)
	}
}

func TestClaimWorkGrantsAnUncontestedRegion(t *testing.T) {
	url, _, stop := startScriptedRelay(t)
	defer stop()
	tools := newTestTools(url, "", "r1", "a1", "sara")
	defer tools.Close()

	result := tools.ClaimWork(context.Background(), "src/db.py", strp("query"), "add index")
	if result["granted"] != true {
		t.Fatalf("got %+v", result)
	}
}

func TestClaimWorkIsRefusedAndNamesTheHolder(t *testing.T) {
	url, _, stop := startScriptedRelay(t)
	defer stop()
	holder := newTestTools(url, "", "r1", "a1", "sara")
	defer holder.Close()
	challenger := newTestTools(url, "", "r1", "a2", "dev")
	defer challenger.Close()

	if r := holder.ClaimWork(context.Background(), "src/db.py", strp("query"), "rewriting query"); r["granted"] != true {
		t.Fatalf("setup claim failed: %+v", r)
	}
	result := challenger.ClaimWork(context.Background(), "src/db.py", strp("query"), "add index")
	if result["granted"] != false || result["held_by"] != "a1" || result["intent"] != "rewriting query" {
		t.Fatalf("got %+v", result)
	}
}

func TestReleaseFreesTheRegionForOthers(t *testing.T) {
	url, relay, stop := startScriptedRelay(t)
	defer stop()
	tools := newTestTools(url, "", "r1", "a1", "sara")
	defer tools.Close()

	tools.ClaimWork(context.Background(), "src/db.py", strp("query"), "add index")
	result := tools.Release(context.Background(), "src/db.py", strp("query"))
	if result["released"] != true {
		t.Fatalf("got %+v", result)
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		relay.mu.Lock()
		_, held := relay.held["src/db.py"]
		relay.mu.Unlock()
		if !held {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("release never reached the relay")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestRespondRefusesAnInventedMoveWithoutRaising(t *testing.T) {
	url, _, stop := startScriptedRelay(t)
	defer stop()
	tools := newTestTools(url, "", "r1", "a1", "sara")
	defer tools.Close()

	result := tools.Respond(context.Background(), "src/db.py", strp("query"), "ARGUE", "")
	if result["granted"] != false {
		t.Fatalf("got %+v", result)
	}
	moves, _ := result["valid_moves"].([]string)
	if len(moves) != 4 || moves[0] != "DEFER" || moves[3] != "PROCEED" {
		t.Fatalf("got %+v", result["valid_moves"])
	}
	if result["error"] != "unknown move: ARGUE" {
		t.Fatalf("got %+v", result["error"])
	}
}

func TestRespondAcceptsMovesCaseInsensitively(t *testing.T) {
	url, _, stop := startScriptedRelay(t)
	defer stop()
	holder := newTestTools(url, "", "r1", "a1", "sara")
	defer holder.Close()
	challenger := newTestTools(url, "", "r1", "a2", "dev")
	defer challenger.Close()

	holder.ClaimWork(context.Background(), "src/db.py", strp("query"), "x")
	result := challenger.Respond(context.Background(), "src/db.py", strp("query"), "  proceed  ", "unrelated")
	if result["granted"] != true || result["action"] != "proceed" || result["override"] != true {
		t.Fatalf("got %+v", result)
	}
	if _, hasErr := result["error"]; hasErr {
		t.Fatalf("got an error on a valid move: %+v", result)
	}
}

func TestRespondHandoffReleasesForASecondConnection(t *testing.T) {
	url, _, stop := startScriptedRelay(t)
	defer stop()
	holder := newTestTools(url, "", "r1", "a1", "sara")
	defer holder.Close()
	other := newTestTools(url, "", "r1", "a2", "dev")
	defer other.Close()

	holder.ClaimWork(context.Background(), "src/pay.py", strp("charge"), "work")
	result := holder.Respond(context.Background(), "src/pay.py", strp("charge"), "HANDOFF", "")
	if result["action"] != "handoff" {
		t.Fatalf("got %+v", result)
	}
	claimed := other.ClaimWork(context.Background(), "src/pay.py", strp("charge"), "hotfix")
	if claimed["granted"] != true {
		t.Fatalf("second connection could not claim after handoff: %+v", claimed)
	}
}

func TestClaimWorkErrorsInsteadOfHangingWhenTheRelayIsNotRunning(t *testing.T) {
	tools := newTestTools("ws://127.0.0.1:1", "", "r1", "a1", "sara")
	defer tools.Close()

	start := time.Now()
	result := tools.ClaimWork(context.Background(), "src/db.py", strp("query"), "add index")
	if result["granted"] != false {
		t.Fatalf("got %+v", result)
	}
	if _, ok := result["error"]; !ok {
		t.Fatalf("expected an error field, got %+v", result)
	}
	if time.Since(start) > 5*time.Second {
		t.Fatalf("took %v — should fail fast", time.Since(start))
	}
}

func TestReleaseAndWhoElseIsHereAlsoDontHangWithNoRelay(t *testing.T) {
	tools := newTestTools("ws://127.0.0.1:1", "", "r1", "a1", "sara")
	defer tools.Close()

	released := tools.Release(context.Background(), "src/db.py", strp("query"))
	if released["released"] != false {
		t.Fatalf("got %+v", released)
	}
	if _, ok := released["error"]; !ok {
		t.Fatalf("expected an error field, got %+v", released)
	}

	peers := tools.WhoElseIsHere(context.Background())
	if len(peers) != 0 {
		t.Fatalf("got %+v, want none", peers)
	}
}

// -- dispatch / server surface -----------------------------------------

func TestExactlyFourToolsAreExposed(t *testing.T) {
	got := ToolDescriptors()
	want := []string{"who_else_is_here", "claim_work", "release", "respond"}
	if len(got) != len(want) {
		t.Fatalf("got %d tools, want %d", len(got), len(want))
	}
	for i, name := range want {
		if got[i].Name != name {
			t.Fatalf("tool[%d] = %q, want %q", i, got[i].Name, name)
		}
	}
}

func TestDispatchRoutesToTheNamedTool(t *testing.T) {
	url, _, stop := startScriptedRelay(t)
	defer stop()
	tools := newTestTools(url, "", "r1", "a1", "sara")
	defer tools.Close()

	result, err := Dispatch(context.Background(), tools, "claim_work", map[string]any{
		"path": "src/db.py", "symbol": "query", "intent": "add index",
	})
	if err != nil {
		t.Fatal(err)
	}
	m, ok := result.(map[string]any)
	if !ok || m["granted"] != true {
		t.Fatalf("got %+v", result)
	}
}

func TestDispatchRejectsAnUnknownTool(t *testing.T) {
	tools := newTestTools("ws://127.0.0.1:1", "", "r1", "a1", "sara")
	defer tools.Close()

	if _, err := Dispatch(context.Background(), tools, "delete_everything", nil); err == nil {
		t.Fatal("expected an error for an unknown tool")
	}
}

// TestDispatchRejectsAMissingRequiredArgument guards against the schema's
// "required" list being decorative: nothing upstream of Dispatch enforces
// it (go-sdk's AddTool leaves that to the caller), so a claim_work call
// missing "path" must error here, not fall through to a claim on "".
func TestDispatchRejectsAMissingRequiredArgument(t *testing.T) {
	url, relay, stop := startScriptedRelay(t)
	defer stop()
	tools := newTestTools(url, "", "r1", "a1", "sara")
	defer tools.Close()

	cases := []struct {
		tool string
		args map[string]any
	}{
		{"claim_work", map[string]any{"intent": "no path given"}},
		{"claim_work", map[string]any{"path": "src/db.py"}},
		{"release", map[string]any{}},
		{"respond", map[string]any{"move": "DEFER"}},
		{"respond", map[string]any{"path": "src/db.py"}},
	}
	for _, c := range cases {
		if _, err := Dispatch(context.Background(), tools, c.tool, c.args); err == nil {
			t.Fatalf("%s%+v: expected an error for a missing required argument", c.tool, c.args)
		}
	}

	relay.mu.Lock()
	defer relay.mu.Unlock()
	if len(relay.held) != 0 {
		t.Fatalf("a rejected call must never reach the relay, got held=%+v", relay.held)
	}
}

func TestDispatchRejectsAWrongTypedRequiredArgument(t *testing.T) {
	tools := newTestTools("ws://127.0.0.1:1", "", "r1", "a1", "sara")
	defer tools.Close()

	_, err := Dispatch(context.Background(), tools, "claim_work", map[string]any{
		"path": 42, "intent": "x",
	})
	if err == nil {
		t.Fatal("expected an error for a non-string required argument")
	}
}

// -- crossing a real connection boundary --------------------------------
//
// The bug this suite exists to catch, structurally: a claim made through
// one Tools has to be visible to a totally independent connection, not
// just to the Tools instance that made it — the exact shape of issue #12.

func TestClaimViaOneToolsBlocksASecondIndependentConnection(t *testing.T) {
	url, _, stop := startScriptedRelay(t)
	defer stop()
	tools := newTestTools(url, "", "r1", "a1", "sara")
	defer tools.Close()

	granted := tools.ClaimWork(context.Background(), "src/auth.py", strp("sign_in"), "refactor to JWT")
	if granted["granted"] != true {
		t.Fatalf("setup claim failed: %+v", granted)
	}

	other := newTestTools(url, "", "r1", "a2", "dev")
	defer other.Close()
	reply := other.ClaimWork(context.Background(), "src/auth.py", strp("sign_in"), "rename param")
	if reply["granted"] != false || reply["held_by"] != "a1" || reply["intent"] != "refactor to JWT" {
		t.Fatalf("second connection was not blocked: %+v", reply)
	}
}

// -- region keys on the wire ---------------------------------------------
//
// The MCP server used to send whatever path a caller handed it straight to
// the relay, unnormalized. Two checkouts of one repo never share an
// absolute path, so the same file claimed from two clones landed under two
// different keys and never collided with each other at all.

func TestClaimWorkSendsARegionKeyRelativeToTheRepoRoot(t *testing.T) {
	url, relay, stop := startScriptedRelay(t)
	defer stop()
	root := t.TempDir()
	tools := newTestTools(url, root, "r1", "a1", "sara")
	defer tools.Close()

	abs := filepath.Join(root, "src", "db.py")
	result := tools.ClaimWork(context.Background(), abs, strp("query"), "add index")
	if result["granted"] != true {
		t.Fatalf("got %+v", result)
	}

	relay.mu.Lock()
	_, held := relay.held["src/db.py"]
	relay.mu.Unlock()
	if !held {
		t.Fatalf("relay did not see a repo-relative region key; held=%+v", relay.held)
	}
}

func TestClaimWorkFromOutsideTheRepoRootSendsACleanedAbsolutePath(t *testing.T) {
	url, relay, stop := startScriptedRelay(t)
	defer stop()
	tools := newTestTools(url, t.TempDir(), "r1", "a1", "sara")
	defer tools.Close()

	// A path with no shared name against the tool's root — a different
	// directory tree, with a redundant segment to prove Clean still runs.
	outside := filepath.Join(t.TempDir(), "notes", "..", "scratch.md")
	want := filepath.ToSlash(filepath.Clean(outside))

	result := tools.ClaimWork(context.Background(), outside, nil, "jot something down")
	if result["granted"] != true {
		t.Fatalf("got %+v", result)
	}

	relay.mu.Lock()
	_, held := relay.held[want]
	relay.mu.Unlock()
	if !held {
		t.Fatalf("relay did not see the cleaned absolute path %q; held=%+v", want, relay.held)
	}
}

func strp(s string) *string { return &s }
