package relaysrv

import (
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// Ported from python/tests/test_backpressure.py's clock-only tests (the
// ones at the bottom of that file, "the deadline itself, with no sockets
// in the way") — the earlier tests in that file need a real wedged OS
// socket and thousands of frames to reach one (WEDGE_BUDGET), which the
// real-socket load harness's slow_subscriber scenario already exercises
// (see docs/relay-parity.md). These three don't: a fake wsWriter (this
// package's answer to python's duck-typed _FakeWs) stands in for the
// socket, so the shed deadline is reached by moving a VirtualClock, not
// by producing real backlog.
//
// This is also what caught a real gap in the port: write() used to call
// WriteMessage directly and block on it with nothing watching the clock
// while it was in flight, so a genuinely wedged peer's writer goroutine
// never returned to check shedReason at all — the connection was never
// shed and the goroutine leaked for the life of the process. Fixed in
// server.go by racing the send against a real-time poll ticker that
// decides on the injectable clock, mirroring serve.py's _write.

type fakeWs struct {
	mu        sync.Mutex
	stuck     bool
	unstick   chan struct{}
	sent      [][]byte
	closeCode int
	closed    bool
	inFlight  int
}

func newFakeWs(stuck bool) *fakeWs {
	return &fakeWs{stuck: stuck, unstick: make(chan struct{})}
}

func (f *fakeWs) WriteMessage(_ int, data []byte) error {
	f.mu.Lock()
	f.inFlight++
	f.mu.Unlock()
	defer func() {
		f.mu.Lock()
		f.inFlight--
		f.mu.Unlock()
	}()
	if f.stuck {
		<-f.unstick // never fires on its own — a socket that never takes it
	}
	f.mu.Lock()
	f.sent = append(f.sent, data)
	f.mu.Unlock()
	return nil
}

func (f *fakeWs) WriteControl(_ int, _ []byte, _ time.Time) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closeCode == 0 {
		f.closeCode = 1013
	}
	return nil
}

func (f *fakeWs) Close() error {
	f.mu.Lock()
	already := f.closed
	f.closed = true
	f.mu.Unlock()
	if !already {
		close(f.unstick) // a real Close() takes the transport down under a blocked write too
	}
	return nil
}

func (f *fakeWs) sentCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.sent)
}

func (f *fakeWs) getCloseCode() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.closeCode
}

func presencePayload(n int) []byte {
	f := Frame{"type": "presence", "human": "h", "agent": "a", "verb": "edit",
		"region": Frame{"path": "src/f.py", "symbol": nil, "lines": nil}, "n": n}
	return EncodeFrame(f)
}

func waitUntil(t *testing.T, cond func() bool, what string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatal(what)
}

func TestAFrameThatWillNotLeaveIsShedOnClockSeconds(t *testing.T) {
	clock := NewVirtualClock(0)
	ws := newFakeWs(true)
	conn := NewWsConn(ws, clock)
	go conn.writeLoop()
	defer conn.shutdown()

	conn.Send(presencePayload(0))
	waitUntil(t, func() bool {
		conn.mu.Lock()
		defer conn.mu.Unlock()
		return conn.sendingSince != nil
	}, "the writer never got as far as the socket")

	// Real time passing here buys nothing, which is the point: the
	// deadline is clock seconds.
	time.Sleep(200 * time.Millisecond)
	if why := conn.shedReason(); why != "" {
		t.Fatalf("shed on wall time, not on the clock: %s", why)
	}
	if ws.getCloseCode() != 0 {
		t.Fatalf("expected no close yet")
	}

	clock.Advance(SendStallS)
	waitUntil(t, func() bool { return ws.getCloseCode() != 0 },
		"a frame stuck past SendStallS clock seconds was not shed")
	if ws.getCloseCode() != 1013 {
		t.Fatalf("got close code %d, want 1013", ws.getCloseCode())
	}
	select {
	case <-conn.closed:
	default:
		t.Fatalf("expected the connection to be marked closed")
	}
}

func TestTimeAloneShedsNobody(t *testing.T) {
	clock := NewVirtualClock(0)
	ws := newFakeWs(false)
	conn := NewWsConn(ws, clock)
	go conn.writeLoop()
	defer conn.shutdown()

	for n := 0; n < 10; n++ {
		conn.Send(presencePayload(n))
	}
	waitUntil(t, func() bool { return ws.sentCount() == 10 }, "the writer never drained")

	// A peer that keeps up is not on any deadline, however much time passes.
	clock.Advance(SendStallS * 100)
	if why := conn.shedReason(); why != "" {
		t.Fatalf("expected no shed reason for a healthy peer, got %s", why)
	}
	conn.Send(presencePayload(99))
	waitUntil(t, func() bool { return ws.sentCount() == 11 }, "a healthy peer stopped being served")
	if ws.getCloseCode() != 0 {
		t.Fatalf("expected no close for a healthy peer")
	}
	select {
	case <-conn.closed:
		t.Fatalf("expected the connection to still be open")
	default:
	}
}

func TestAShedWriterLeavesNoSendBehind(t *testing.T) {
	// The original leak, in miniature: a send nobody finishes and nobody
	// drops, even once the connection it belonged to is long gone.
	clock := NewVirtualClock(0)
	ws := newFakeWs(true)
	conn := NewWsConn(ws, clock)
	go conn.writeLoop()

	conn.Send(presencePayload(0))
	waitUntil(t, func() bool {
		ws.mu.Lock()
		defer ws.mu.Unlock()
		return ws.inFlight == 1
	}, "the writer never reached the socket")

	// shutdown() alone (what the session loop's defer does on any
	// ordinary disconnect) does not unstick a write already in flight —
	// only shed()'s ws.Close() does, reached here via the clock-driven
	// path, same as the stall test above.
	clock.Advance(SendStallS)
	waitUntil(t, func() bool {
		ws.mu.Lock()
		defer ws.mu.Unlock()
		return ws.inFlight == 0
	}, "the send outlived the writer that started it: an orphan write for a "+
		"connection that is already gone")
}

// TestWsConnSatisfiesRealWebsocketConn is a compile-time-adjacent check
// that the interface extraction (wsWriter) didn't drift from what
// *websocket.Conn actually exposes — session() in server.go depends on
// this holding without an explicit assertion anywhere else.
func TestWsConnSatisfiesRealWebsocketConn(t *testing.T) {
	var _ wsWriter = (*websocket.Conn)(nil)
}
