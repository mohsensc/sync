package relaysrv

import (
	"context"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/mohsensc/sync/go/internal/metrics"
)

// TestServeShutdownClosesSessionsGracefully is the server-side counterpart
// to TestClientInitiatedCloseCompletesPromptly: that one covers a client
// hanging up on the server, this one covers the server hanging up on every
// client at once. Before this fix, cancelling Serve's context only called
// srv.Close() — which never touches an already-hijacked websocket — so a
// relay restart looked like an abrupt RST/EOF to every connected daemon
// instead of a clean 1001. See issue #97.
func TestServeShutdownClosesSessionsGracefully(t *testing.T) {
	relay := NewRelay(NewVirtualClock(0), InertRoster(), metrics.New())
	srv := &Server{Addr: "127.0.0.1:0", Relay: relay}
	addr, err := srv.Listen()
	if err != nil {
		t.Fatalf("Listen: %s", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	serveDone := make(chan error, 1)
	go func() { serveDone <- srv.Serve(ctx) }()

	ws, _, err := websocket.DefaultDialer.Dial("ws://"+addr+"/", nil)
	if err != nil {
		t.Fatalf("dial: %s", err)
	}
	defer ws.Close()

	// session() tracks the connection right after Upgrade, but that
	// happens in the goroutine Serve's handler spawns — the dial above
	// only proves the handshake reached this end, not that tracking has
	// run yet. Poll rather than sleep a fixed guess.
	waitUntil := time.Now().Add(2 * time.Second)
	for {
		srv.connsMu.Lock()
		tracked := len(srv.conns)
		srv.connsMu.Unlock()
		if tracked > 0 {
			break
		}
		if time.Now().After(waitUntil) {
			t.Fatal("server never tracked the connection")
		}
		time.Sleep(10 * time.Millisecond)
	}

	cancel() // simulate a relay restart

	readDone := make(chan error, 1)
	go func() {
		_, _, err := ws.ReadMessage()
		readDone <- err
	}()

	select {
	case err := <-readDone:
		closeErr, ok := err.(*websocket.CloseError)
		if !ok {
			t.Fatalf("expected a close frame, got %v (%T) — client saw a RST/EOF instead of a clean close", err, err)
		}
		if closeErr.Code != websocket.CloseGoingAway {
			t.Fatalf("expected close code %d, got %d", websocket.CloseGoingAway, closeErr.Code)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("client never observed a close frame on server shutdown")
	}

	select {
	case <-serveDone:
	case <-time.After(3 * time.Second):
		t.Fatal("Serve did not return after shutdown")
	}
}

// wedgedWs models a peer so unresponsive that nothing this connection's
// end does ever returns on its own — WriteControl never lands, Close
// never completes. Real sockets don't get this stuck (a two-byte close
// frame fits in the kernel send buffer regardless of whether the peer is
// reading), so this is the only way to exercise the case closeConns has
// to survive: a single wedged connection that would otherwise hang a
// relay restart forever.
type wedgedWs struct{}

func (wedgedWs) WriteMessage(int, []byte) error            { select {} }
func (wedgedWs) WriteControl(int, []byte, time.Time) error { select {} }
func (wedgedWs) Close() error                              { select {} }

// TestServeShutdownBoundedByUnresponsivePeer checks that closeConns
// returns within its overall bound even when a tracked connection never
// completes its close handshake — the whole reason shutdown fans the
// close out concurrently and waits on a timer instead of on each
// connection in turn.
func TestServeShutdownBoundedByUnresponsivePeer(t *testing.T) {
	relay := NewRelay(NewVirtualClock(0), InertRoster(), metrics.New())
	srv := &Server{Relay: relay}
	for i := 0; i < 3; i++ {
		srv.trackConn(NewWsConn(wedgedWs{}, relay.Clock(), relay.metrics))
	}

	done := make(chan struct{})
	start := time.Now()
	go func() {
		srv.closeConns()
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(shutdownDeadline + time.Second):
		t.Fatal("closeConns did not return within its bound despite an unresponsive peer")
	}
	if elapsed := time.Since(start); elapsed > shutdownDeadline+time.Second {
		t.Fatalf("closeConns took %s, expected roughly shutdownDeadline (%s)", elapsed, shutdownDeadline)
	}
}
