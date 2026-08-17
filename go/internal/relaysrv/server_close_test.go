package relaysrv

import (
	"context"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/mohsensc/sync/go/internal/metrics"
)

// TestClientInitiatedCloseCompletesPromptly is a real-server regression
// test for a bug found while running the load harness against gorelay:
// session()'s read loop returned on a client-initiated close (gorilla's
// default close handler already echoes the close frame back), but
// nothing ever called ws.Close() on this end, so the underlying TCP
// connection was never closed. A client's own close() waits for the
// connection to actually go away at the transport level, not just for
// the frame exchange — every disconnect paid a client-side close_timeout
// (10s for Python's websockets library) instead of returning as soon as
// the close frames crossed. Confirmed directly against an unpatched
// gorelay before this fix landed.
func TestClientInitiatedCloseCompletesPromptly(t *testing.T) {
	relay := NewRelay(NewVirtualClock(0), InertRoster(), metrics.New())
	srv := &Server{Addr: "127.0.0.1:0", Relay: relay}
	addr, err := srv.Listen()
	if err != nil {
		t.Fatalf("Listen: %s", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go srv.Serve(ctx)

	ws, _, err := websocket.DefaultDialer.Dial("ws://"+addr+"/", nil)
	if err != nil {
		t.Fatalf("dial: %s", err)
	}
	if err := ws.WriteJSON(map[string]any{"type": "join", "room": "r", "agent": "a", "human": "h"}); err != nil {
		t.Fatal(err)
	}
	var reply map[string]any
	if err := ws.ReadJSON(&reply); err != nil {
		t.Fatal(err)
	}

	// The standard client-initiated close handshake: send a close frame,
	// then keep reading until the read side reports the connection
	// closed. A server that never closes its own end of the TCP
	// connection leaves this ReadMessage call parked until gorilla's own
	// (much longer) internal deadline, not gorelay's fault to wait out —
	// this test bounds it far tighter, at the scale a real fix produces.
	done := make(chan error, 1)
	go func() {
		if err := ws.WriteControl(websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""),
			time.Now().Add(2*time.Second)); err != nil {
			done <- err
			return
		}
		for {
			if _, _, err := ws.ReadMessage(); err != nil {
				done <- nil // any read error here is the expected close
				return
			}
		}
	}()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("close handshake errored: %s", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("client-initiated close did not complete within 2s — " +
			"the server-side connection is not being closed")
	}
}
