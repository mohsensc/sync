package mcprelay

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/mohsensc/sync/go/internal/wire"
)

// fakeRelay is just enough of serve.py + relay.py to drive Conn through a
// join, a claim/move/release round trip and a presence fan-out over a real
// websocket connection — same convention as relay/client_test.go's
// fakeRelay. Not a reimplementation of the relay's negotiation logic (see
// python/tests for that); a single-region table, enough to prove the wire
// shapes and the client's field mapping.
type fakeRelay struct {
	upgrader websocket.Upgrader

	mu          sync.Mutex
	held        map[string]string // region key -> holder agent
	conns       []*websocket.Conn // hijacked by gorilla; (*http.Server).Close doesn't touch these
	joined      chan wire.Join
	claims      chan wire.Claim
	moves       chan wire.MoveRequest
	released    chan wire.ReleaseRequest
	presence    []wire.PresenceSnapshotEntry // sent on every join's leases frame
	silentJoin  bool                         // never answer join (connect-timeout test)
	silentClaim bool                         // join normally, never answer claim (request-timeout test)
}

func newFakeRelay() *fakeRelay {
	return &fakeRelay{
		held:     make(map[string]string),
		joined:   make(chan wire.Join, 8),
		claims:   make(chan wire.Claim, 8),
		moves:    make(chan wire.MoveRequest, 8),
		released: make(chan wire.ReleaseRequest, 8),
	}
}

func (f *fakeRelay) handler(w http.ResponseWriter, r *http.Request) {
	conn, err := f.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	f.mu.Lock()
	f.conns = append(f.conns, conn)
	f.mu.Unlock()

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
			_ = json.Unmarshal(data, &j)
			f.joined <- j
			if f.silentJoin {
				continue
			}
			snapshot := wire.Leases{Type: "leases", Leases: nil, Presence: f.presence}
			if err := conn.WriteJSON(snapshot); err != nil {
				return
			}
		case "claim":
			var c wire.Claim
			_ = json.Unmarshal(data, &c)
			f.claims <- c
			if f.silentClaim {
				continue
			}
			if err := conn.WriteJSON(f.claimReply(c)); err != nil {
				return
			}
		case "move":
			var m wire.MoveRequest
			_ = json.Unmarshal(data, &m)
			f.moves <- m
			if err := conn.WriteJSON(map[string]any{
				"type": "move_result", "granted": true, "action": "split",
			}); err != nil {
				return
			}
		case "release":
			var rl wire.ReleaseRequest
			_ = json.Unmarshal(data, &rl)
			f.released <- rl
			f.mu.Lock()
			delete(f.held, rl.Region.Path)
			f.mu.Unlock()
			// No reply — see mcprelay.Conn.Release's doc comment.
		}
	}
}

func (f *fakeRelay) claimReply(c wire.Claim) map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	holder, taken := f.held[c.Region.Path]
	if !taken {
		f.held[c.Region.Path] = "the-caller" // whoever asked; good enough for these tests
		return map[string]any{"type": "claim_result", "granted": true}
	}
	return map[string]any{
		"type": "claim_result", "granted": false,
		"held_by": holder, "human": "sara", "intent": "already on it",
		"decision": "abort",
	}
}

// closeConns force-closes every hijacked websocket connection this relay
// has ever accepted — http.Server.Close alone leaves them open, since a
// hijacked connection isn't one it knows about, and this test package
// needs an actual "the relay just crashed" moment to exercise reconnect.
func (f *fakeRelay) closeConns() {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, c := range f.conns {
		c.Close()
	}
}

func startFakeRelay(t *testing.T, fr *fakeRelay) (url string, stop func()) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(fr.handler)}
	go srv.Serve(ln)
	return "ws://" + ln.Addr().String() + "/", func() { srv.Close() }
}

func testCfg(url string) Config {
	return Config{
		URL: url, Room: "r1", Agent: "a1", Human: "sara",
		ConnectTimeout: 2 * time.Second, RequestTimeout: 2 * time.Second,
	}
}

func TestConnectFailsClosedWhenNoRelay(t *testing.T) {
	c := New(Config{
		URL: "ws://127.0.0.1:1", Room: "r1", Agent: "a1", Human: "sara",
		ConnectTimeout: 1 * time.Second, RequestTimeout: 1 * time.Second,
	})
	defer c.Close()

	start := time.Now()
	_, err := c.Claim(context.Background(), wire.Region{Path: "x"}, "y")
	if err == nil {
		t.Fatal("expected an error with no relay listening")
	}
	if _, ok := err.(*Unavailable); !ok {
		t.Fatalf("got %T, want *Unavailable", err)
	}
	if time.Since(start) > 5*time.Second {
		t.Fatalf("took %v — should fail fast on connection refused", time.Since(start))
	}
}

func TestJoinRefused(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	upgrader := websocket.Upgrader{}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		conn.ReadMessage() // the join frame
		conn.WriteJSON(map[string]any{
			"type": "join_refused", "room": "r1", "reason": "name-collision", "detail": "taken",
		})
	})}
	go srv.Serve(ln)
	defer srv.Close()

	c := New(testCfg("ws://" + ln.Addr().String() + "/"))
	defer c.Close()

	_, err = c.Claim(context.Background(), wire.Region{Path: "x"}, "y")
	if err == nil {
		t.Fatal("expected an error on a refused join")
	}
}

func TestClaimGrantedRoundTrip(t *testing.T) {
	fr := newFakeRelay()
	url, stop := startFakeRelay(t, fr)
	defer stop()

	c := New(testCfg(url))
	defer c.Close()

	reply, err := c.Claim(context.Background(), wire.Region{Path: "src/db.py"}, "add index")
	if err != nil {
		t.Fatal(err)
	}
	if reply["granted"] != true {
		t.Fatalf("got %+v, want granted", reply)
	}

	select {
	case j := <-fr.joined:
		if j.Room != "r1" || j.Agent != "a1" || j.Human != "sara" {
			t.Fatalf("unexpected join frame: %+v", j)
		}
	default:
		t.Fatal("relay never saw a join")
	}
	select {
	case cl := <-fr.claims:
		if cl.Region.Path != "src/db.py" || cl.Intent != "add index" {
			t.Fatalf("unexpected claim frame: %+v", cl)
		}
	default:
		t.Fatal("relay never saw the claim")
	}
}

func TestClaimRefusedNamesHolder(t *testing.T) {
	fr := newFakeRelay()
	fr.held["src/db.py"] = "a9"
	url, stop := startFakeRelay(t, fr)
	defer stop()

	c := New(testCfg(url))
	defer c.Close()

	reply, err := c.Claim(context.Background(), wire.Region{Path: "src/db.py"}, "add index")
	if err != nil {
		t.Fatal(err)
	}
	if reply["granted"] != false || reply["held_by"] != "a9" {
		t.Fatalf("got %+v", reply)
	}
}

func TestReleaseSendsAndGetsNoReply(t *testing.T) {
	fr := newFakeRelay()
	url, stop := startFakeRelay(t, fr)
	defer stop()

	c := New(testCfg(url))
	defer c.Close()

	if err := c.Release(context.Background(), wire.Region{Path: "src/db.py"}); err != nil {
		t.Fatal(err)
	}
	select {
	case rl := <-fr.released:
		if rl.Region.Path != "src/db.py" {
			t.Fatalf("unexpected release frame: %+v", rl)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("relay never saw the release")
	}
}

func TestMoveRoundTrip(t *testing.T) {
	fr := newFakeRelay()
	url, stop := startFakeRelay(t, fr)
	defer stop()

	c := New(testCfg(url))
	defer c.Close()

	reply, err := c.Move(context.Background(), wire.Region{Path: "src/db.py", Symbol: strPtr("helper")}, "SPLIT", "")
	if err != nil {
		t.Fatal(err)
	}
	if reply["granted"] != true || reply["action"] != "split" {
		t.Fatalf("got %+v", reply)
	}
	select {
	case m := <-fr.moves:
		if m.Move != "SPLIT" || m.Region.Path != "src/db.py" {
			t.Fatalf("unexpected move frame: %+v", m)
		}
	default:
		t.Fatal("relay never saw the move")
	}
}

func TestRequestTimesOutInsteadOfHanging(t *testing.T) {
	fr := newFakeRelay()
	fr.silentClaim = true
	url, stop := startFakeRelay(t, fr)
	defer stop()

	c := New(Config{
		URL: url, Room: "r1", Agent: "a1", Human: "sara",
		ConnectTimeout: 2 * time.Second, RequestTimeout: 300 * time.Millisecond,
	})
	defer c.Close()

	start := time.Now()
	_, err := c.Claim(context.Background(), wire.Region{Path: "x"}, "y")
	elapsed := time.Since(start)
	if err == nil {
		t.Fatal("expected a timeout error")
	}
	if elapsed > 5*time.Second {
		t.Fatalf("took %v — a silent relay must not hang a tool call", elapsed)
	}
}

func TestPresenceFromJoinSnapshot(t *testing.T) {
	fr := newFakeRelay()
	fr.presence = []wire.PresenceSnapshotEntry{
		{Agent: "a9", Human: "priya", Verb: "edit",
			Region: wire.Region{Path: "src/before.py"}, Ts: 1000},
	}
	url, stop := startFakeRelay(t, fr)
	defer stop()

	c := New(testCfg(url))
	defer c.Close()

	peers, err := c.Presence(context.Background(), "a1")
	if err != nil {
		t.Fatal(err)
	}
	if len(peers) != 1 || peers[0].Agent != "a9" || peers[0].Human != "priya" || peers[0].Path != "src/before.py" {
		t.Fatalf("got %+v", peers)
	}
	if peers[0].Symbol != nil {
		t.Fatalf("expected a nil symbol for a whole-file touch, got %v", *peers[0].Symbol)
	}
}

func TestPresenceExcludesSelfAndRespectsLivePresenceFrame(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	upgrader := websocket.Upgrader{}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		conn.ReadMessage()
		conn.WriteJSON(wire.Leases{Type: "leases"})
		conn.WriteJSON(map[string]any{
			"type": "presence", "agent": "a2", "human": "dev", "verb": "edit",
			"region": map[string]any{"path": "src/live.py", "symbol": "sign_in"},
		})
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	})}
	go srv.Serve(ln)
	defer srv.Close()

	c := New(testCfg("ws://" + ln.Addr().String() + "/"))
	defer c.Close()

	var peers []Peer
	deadline := time.Now().Add(3 * time.Second)
	for {
		peers, err = c.Presence(context.Background(), "a1")
		if err != nil {
			t.Fatal(err)
		}
		if len(peers) > 0 || time.Now().After(deadline) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if len(peers) != 1 || peers[0].Agent != "a2" {
		t.Fatalf("got %+v", peers)
	}
	if peers[0].Symbol == nil || *peers[0].Symbol != "sign_in" {
		t.Fatalf("got symbol %v, want sign_in", peers[0].Symbol)
	}

	// exclude=a2 must drop it even though it's live.
	self, err := c.Presence(context.Background(), "a2")
	if err != nil {
		t.Fatal(err)
	}
	if len(self) != 0 {
		t.Fatalf("got %+v, want excluded", self)
	}
}

func TestReconnectAfterTeardown(t *testing.T) {
	fr := newFakeRelay()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	srv := &http.Server{Handler: http.HandlerFunc(fr.handler)}
	go srv.Serve(ln)

	c := New(testCfg("ws://" + addr + "/"))
	defer c.Close()

	if _, err := c.Claim(context.Background(), wire.Region{Path: "src/first.py"}, "one"); err != nil {
		t.Fatal(err)
	}

	// A relay crash: the connection goes away without either side sending
	// a close frame.
	srv.Close()
	fr.closeConns()

	if _, err := c.Claim(context.Background(), wire.Region{Path: "src/during-outage.py"}, "two"); err == nil {
		t.Fatal("expected an error while the relay is down")
	}

	// Bring a relay back up on the same address — the next call has to
	// reconnect, not stay wedged on the dead socket.
	ln2, err := net.Listen("tcp", addr)
	if err != nil {
		t.Skipf("could not rebind %s (port not released yet): %v", addr, err)
	}
	fr2 := newFakeRelay()
	srv2 := &http.Server{Handler: http.HandlerFunc(fr2.handler)}
	go srv2.Serve(ln2)
	defer srv2.Close()

	deadline := time.Now().Add(3 * time.Second)
	var lastErr error
	for time.Now().Before(deadline) {
		reply, err := c.Claim(context.Background(), wire.Region{Path: "src/after-restart.py"}, "three")
		if err == nil {
			if reply["granted"] != true {
				t.Fatalf("got %+v", reply)
			}
			return
		}
		lastErr = err
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("never reconnected after the relay came back: %v", lastErr)
}

func strPtr(s string) *string { return &s }
