package relay

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/mohsensc/sync/go/internal/leases"
	"github.com/mohsensc/sync/go/internal/wire"
)

// fakeRelay is just enough of serve.py + relay.py to drive Client through a
// real join, a real leases snapshot and a real presence fan-out over an
// actual TCP + websocket connection. It is not a reimplementation of the
// Python relay's protocol logic — see python/tests for that coverage — only
// of the frames this test needs on the wire.
type fakeRelay struct {
	upgrader websocket.Upgrader
	joined   chan wire.Join
}

func newFakeRelay() *fakeRelay {
	return &fakeRelay{joined: make(chan wire.Join, 4)}
}

func (f *fakeRelay) handler(w http.ResponseWriter, r *http.Request) {
	conn, err := f.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		var env wire.Envelope
		if err := json.Unmarshal(data, &env); err != nil {
			continue
		}
		if env.Type != "join" {
			continue
		}
		var j wire.Join
		_ = json.Unmarshal(data, &j)
		f.joined <- j

		// Same order the real relay answers a join in: a leases snapshot
		// first, then whatever else this test wants to push.
		snapshot := wire.Leases{Type: "leases", Leases: []wire.LeaseFrame{
			{
				Agent:  "other-agent",
				Human:  "sara",
				Intent: "refactor sign_in",
				Region: wire.Region{Path: "src/auth.py"},
			},
		}}
		if err := conn.WriteJSON(snapshot); err != nil {
			return
		}

		peer := wire.Presence{
			Agent: "other-agent",
			Human: "sara",
			Verb:  "edit",
			Region: wire.Region{
				Path: "src/auth.py",
			},
		}
		peerFrame := map[string]any{
			"type":   "presence",
			"agent":  peer.Agent,
			"human":  peer.Human,
			"verb":   peer.Verb,
			"region": peer.Region,
		}
		if err := conn.WriteJSON(peerFrame); err != nil {
			return
		}

		// Then read whatever the client sends and just keep the connection
		// open until the test tears it down.
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}
}

func TestClientJoinsRoomAndReceivesFrames(t *testing.T) {
	fr := newFakeRelay()
	srv := httptest.NewServer(http.HandlerFunc(fr.handler))
	defer srv.Close()

	url := "ws://" + srv.Listener.Addr().String() + "/"

	lc := leases.New()
	peerCh := make(chan wire.Presence, 4)

	c := New(Config{
		URL:   url,
		Room:  "test-room",
		Agent: "go-daemon-test",
		Human: "mohsen",
	}, lc)
	c.OnPeer(func(p wire.Presence) { peerCh <- p })

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go c.Run(ctx)

	select {
	case j := <-fr.joined:
		if j.Room != "test-room" || j.Agent != "go-daemon-test" {
			t.Fatalf("unexpected join frame: %+v", j)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("relay never received a join frame")
	}

	select {
	case p := <-peerCh:
		if p.Agent != "other-agent" || p.Region.Path != "src/auth.py" {
			t.Fatalf("unexpected presence frame: %+v", p)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("client never delivered the presence frame")
	}

	// The leases snapshot sent right after join must have landed in the
	// cache the client was built with — this is the round trip that lets a
	// hook decision see a conflict a moment after the daemon joins.
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, ok := lc.ConflictForFile("src/auth.py", "go-daemon-test", time.Now().UnixMilli()); ok {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("leases snapshot from join never reached the cache")
		}
		time.Sleep(10 * time.Millisecond)
	}

	if !c.Open() {
		t.Fatalf("client state = %v, want Open", c.State())
	}
}

func TestClientReconnectsWithBackoff(t *testing.T) {
	// No listener at all: every dial fails, so this exercises the backoff
	// loop, not a live connection.
	lc := leases.New()
	c := New(Config{
		URL:        "ws://127.0.0.1:1", // refused immediately, no real service
		Room:       "test-room",
		Agent:      "go-daemon-test",
		BackoffMin: 10 * time.Millisecond,
		BackoffMax: 40 * time.Millisecond,
	}, lc)

	ctx, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
	defer cancel()
	c.Run(ctx)

	if c.ConnectAttempts() < 2 {
		t.Fatalf("connect attempts = %d, want at least 2 (backoff should have retried)", c.ConnectAttempts())
	}
	if c.State() != StateBackoff {
		t.Fatalf("state = %v, want StateBackoff", c.State())
	}
}

func TestMalformedLeasesFrameLeavesTableUntouched(t *testing.T) {
	lc := leases.New()
	lc.Upsert(leases.RegionKey("a.py", ""), leases.Lease{Agent: "other", ExpiresAtMs: 90_000})

	c := New(Config{URL: "ws://127.0.0.1:1", Room: "r", Agent: "a"}, lc)

	// A "leases" frame whose "leases" key is null, missing, or not an array
	// must never wipe the table — see relay_client.cpp's on_text.
	for _, frame := range []string{
		`{"type":"leases","leases":null}`,
		`{"type":"leases"}`,
		`{"type":"leases","leases":"not an array"}`,
	} {
		if err := c.dispatch([]byte(frame)); err != nil {
			t.Fatalf("dispatch(%s): %v", frame, err)
		}
		if _, ok := lc.ConflictForFile("a.py", "me", 0); !ok {
			t.Fatalf("frame %s wiped the lease table", frame)
		}
	}

	// A real, empty array is the one thing allowed to clear it.
	if err := c.dispatch([]byte(`{"type":"leases","leases":[]}`)); err != nil {
		t.Fatal(err)
	}
	if _, ok := lc.ConflictForFile("a.py", "me", 0); ok {
		t.Fatal("an empty leases array must clear the table")
	}
}

func TestOutboundSurvivesBeforeConnect(t *testing.T) {
	// SendText before Run/connect ever happens must not be lost: it goes
	// through the same bounded queue a connected client drains, so it is
	// delivered on the first successful connection.
	fr := newFakeRelay()
	srv := httptest.NewServer(http.HandlerFunc(fr.handler))
	defer srv.Close()
	url := "ws://" + srv.Listener.Addr().String() + "/"

	lc := leases.New()
	c := New(Config{URL: url, Room: "r", Agent: "a"}, lc)
	c.SendText(wire.Marshal(wire.Event{Type: "event", Source: "hook", Verb: "edit", Agent: "a", Region: wire.Region{Path: "x"}}))

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go c.Run(ctx)

	select {
	case <-fr.joined:
	case <-time.After(5 * time.Second):
		t.Fatal("relay never received a join frame")
	}

	deadline := time.Now().Add(5 * time.Second)
	for c.SentMessages() < 2 { // join + the queued event
		if time.Now().After(deadline) {
			t.Fatalf("queued event was never sent, sent=%d", c.SentMessages())
		}
		time.Sleep(10 * time.Millisecond)
	}
}
