package relaysrv

import (
	"context"
	"encoding/json"
	"log"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// Backpressure tuning. Identical values to serve.py's module constants —
// see there for the reasoning behind each number; these are not ours to
// pick independently, the daemons and the load harness on the other end
// are tuned against them.
const (
	SendQueueMax   = 512
	SendStallS     = 15.0
	SendSaturatedS = 10.0

	InboundRateHz     = 2000.0
	InboundBurst      = 4000.0
	InboundSaturatedS = 10.0

	MaxFrameBytes = 65536
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	// Loopback tool, no browser origin to police — same trust boundary
	// serve.py runs with (see docs/threat-model.md): anyone who can reach
	// the port can join any room.
	CheckOrigin: func(*http.Request) bool { return true },
}

// WsConn is one connection: goroutine per connection, one bounded outbound
// channel, one writer goroutine. Mirrors serve.py's WsConn — see there for
// the full argument on why sends are non-blocking and why a saturated
// peer gets disconnected rather than allowed to grow the relay's memory
// without bound.
type WsConn struct {
	ws    *websocket.Conn
	clock Clock

	mu    sync.Mutex
	agent string
	human string
	room  string

	principal  string
	token      string
	unattended bool

	out            chan []byte
	closeOnce      sync.Once
	closed         chan struct{}
	dropped        int
	saturatedSince *float64
	sendingSince   *float64

	// Inbound token bucket.
	tokens           float64
	tokenTs          float64
	inSaturatedSince *float64
	inboundDropped   int
	inMu             sync.Mutex
}

func NewWsConn(ws *websocket.Conn, clock Clock) *WsConn {
	now := clock.Now()
	c := &WsConn{
		ws:      ws,
		clock:   clock,
		out:     make(chan []byte, SendQueueMax),
		closed:  make(chan struct{}),
		tokens:  InboundBurst,
		tokenTs: now,
	}
	return c
}

func (c *WsConn) Agent() string     { c.mu.Lock(); defer c.mu.Unlock(); return c.agent }
func (c *WsConn) SetAgent(a string) { c.mu.Lock(); c.agent = a; c.mu.Unlock() }
func (c *WsConn) Human() string     { c.mu.Lock(); defer c.mu.Unlock(); return c.human }
func (c *WsConn) SetHuman(h string) { c.mu.Lock(); c.human = h; c.mu.Unlock() }
func (c *WsConn) Room() string      { c.mu.Lock(); defer c.mu.Unlock(); return c.room }
func (c *WsConn) SetRoom(r string)  { c.mu.Lock(); c.room = r; c.mu.Unlock() }
func (c *WsConn) Principal() string { c.mu.Lock(); defer c.mu.Unlock(); return c.principal }
func (c *WsConn) Token() string     { c.mu.Lock(); defer c.mu.Unlock(); return c.token }
func (c *WsConn) Unattended() bool  { c.mu.Lock(); defer c.mu.Unlock(); return c.unattended }

// Send queues an already-encoded frame. Never blocks, never panics, never
// waits on the peer: a full channel drops the oldest queued frame to make
// room, the same drop-oldest rule serve.py's deque enforces — a stale
// presence or lease frame is worth nothing next to the newest one.
//
// Takes bytes, not a Frame, on purpose: the caller (Relay.Broadcast et al)
// encodes once per distinct payload and fans the same bytes out to every
// recipient, so there is nothing left for this method to marshal — see
// EncodeFrame. A nil payload (an encode failure upstream) is dropped
// rather than queued.
//
// Go has no built-in bounded-channel-with-drop-oldest, so this is a
// non-blocking send that, on EAGAIN, drains exactly one queued frame and
// retries once. Both the channel send and the drain are non-blocking, so
// this can never park the caller (the relay's own goroutine, mid-fan-out)
// waiting on this connection's reader — the one property that has to
// hold, or one slow subscriber stalls every claim in the room.
func (c *WsConn) Send(payload []byte) {
	if payload == nil {
		return
	}
	select {
	case <-c.closed:
		return
	default:
	}
	select {
	case c.out <- payload:
		return
	default:
	}
	// Full: drop the oldest and make room for the newest, exactly once.
	select {
	case <-c.out:
		c.mu.Lock()
		c.dropped++
		if c.saturatedSince == nil {
			now := c.clock.Now()
			c.saturatedSince = &now
		}
		c.mu.Unlock()
	default:
	}
	select {
	case c.out <- payload:
	default:
		// Lost a race with the writer goroutine draining concurrently;
		// the queue had room again by the time we retried. Fine either
		// way — payload is simply not queued this time, matching the
		// spirit of drop-oldest under contention.
	}
}

func (c *WsConn) shedReason() string {
	now := c.clock.Now()
	c.mu.Lock()
	sendingSince, saturatedSince := c.sendingSince, c.saturatedSince
	c.mu.Unlock()
	if sendingSince != nil && now-*sendingSince >= SendStallS {
		return "one frame did not leave in the stall window"
	}
	if saturatedSince != nil && now-*saturatedSince >= SendSaturatedS {
		return "send queue full for over the saturation window"
	}
	return ""
}

// writeLoop drains the outbound channel to the socket. One per
// connection, exits when the channel is closed or the socket errors.
func (c *WsConn) writeLoop() {
	for {
		select {
		case payload, ok := <-c.out:
			if !ok {
				return
			}
			if len(c.out) == 0 {
				c.mu.Lock()
				c.saturatedSince = nil
				c.mu.Unlock()
			}
			if !c.write(payload) {
				return
			}
		case <-c.closed:
			return
		}
	}
}

func (c *WsConn) write(payload []byte) bool {
	now := c.clock.Now()
	c.mu.Lock()
	c.sendingSince = &now
	c.mu.Unlock()
	err := c.ws.WriteMessage(websocket.TextMessage, payload)
	c.mu.Lock()
	c.sendingSince = nil
	c.mu.Unlock()
	if err != nil {
		c.shutdown()
		return false
	}
	if why := c.shedReason(); why != "" {
		log.Printf("dropping subscriber %q (room %q): %s, %d frames shed", c.Agent(), c.Room(), why, c.dropped)
		c.shutdown()
		_ = c.ws.WriteControl(websocket.CloseMessage,
			websocket.FormatCloseMessage(1013, "subscriber too slow"),
			time.Now().Add(2*time.Second))
		_ = c.ws.Close()
		return false
	}
	return true
}

func (c *WsConn) shutdown() {
	c.closeOnce.Do(func() { close(c.closed) })
}

// -- inbound rate limiting -------------------------------------------------

func (c *WsConn) admitInbound() bool {
	c.inMu.Lock()
	defer c.inMu.Unlock()
	now := c.clock.Now()
	elapsed := now - c.tokenTs
	if elapsed < 0 {
		elapsed = 0
	}
	c.tokenTs = now
	c.tokens += elapsed * InboundRateHz
	if c.tokens > InboundBurst {
		c.tokens = InboundBurst
	}
	if c.tokens < 1.0 {
		c.inboundDropped++
		if c.inSaturatedSince == nil {
			t := now
			c.inSaturatedSince = &t
		}
		return false
	}
	c.tokens -= 1.0
	c.inSaturatedSince = nil
	return true
}

func (c *WsConn) inboundShedReason() string {
	c.inMu.Lock()
	defer c.inMu.Unlock()
	if c.inSaturatedSince == nil {
		return ""
	}
	if c.clock.Now()-*c.inSaturatedSince >= InboundSaturatedS {
		return "inbound rate exceeded budget for over the saturation window"
	}
	return ""
}

// -- session ----------------------------------------------------------------

func session(ws *websocket.Conn, relay *Relay) {
	ws.SetReadLimit(MaxFrameBytes)
	conn := NewWsConn(ws, relay.Clock())
	go conn.writeLoop()

	defer func() {
		relay.Leave(conn)
		conn.shutdown()
	}()

	for {
		_, raw, err := ws.ReadMessage()
		if err != nil {
			return
		}
		if !conn.admitInbound() {
			if why := conn.inboundShedReason(); why != "" {
				log.Printf("dropping connection %q (room %q): %s, %d frames dropped", conn.Agent(), conn.Room(), why, conn.inboundDropped)
				_ = ws.WriteControl(websocket.CloseMessage,
					websocket.FormatCloseMessage(1013, "too many requests"),
					time.Now().Add(2*time.Second))
				return
			}
			continue
		}

		var msg map[string]any
		if err := json.Unmarshal(raw, &msg); err != nil {
			continue
		}

		if t, _ := msg["type"].(string); t == "join" {
			roomVal, _ := msg["room"].(string)
			if roomVal == "" {
				continue
			}
			agent, _ := msg["agent"].(string)
			human, _ := msg["human"].(string)
			conn.SetAgent(agent)
			conn.SetHuman(human)
			conn.mu.Lock()
			if p, ok := msg["principal"].(string); ok {
				conn.principal = p
			} else {
				conn.principal = ""
			}
			if tok, ok := msg["token"].(string); ok {
				conn.token = tok
			} else {
				conn.token = ""
			}
			conn.unattended = msg["unattended"] == true
			conn.mu.Unlock()
			relay.Join(roomVal, conn)
			conn.mu.Lock()
			conn.token = ""
			conn.mu.Unlock()
			continue
		}

		reply := func() (f Frame) {
			defer func() {
				if rec := recover(); rec != nil {
					log.Printf("handler panic; connection preserved: %v", rec)
					f = nil
				}
			}()
			return relay.Handle(conn, msg)
		}()
		if reply != nil {
			conn.Send(EncodeFrame(reply))
		}
	}
}

// Server runs the relay's websocket listener until ctx is cancelled.
type Server struct {
	Addr  string
	Relay *Relay

	ln net.Listener
}

// Listen binds the socket and returns the bound address; call Serve to
// accept connections. Splitting bind from accept is what lets tests use
// port 0 and read back the real port before any client tries to connect.
func (s *Server) Listen() (string, error) {
	ln, err := net.Listen("tcp", s.Addr)
	if err != nil {
		return "", err
	}
	s.ln = ln
	return ln.Addr().String(), nil
}

func (s *Server) Serve(ctx context.Context) error {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		go session(ws, s.Relay)
	})
	srv := &http.Server{Handler: mux}
	errCh := make(chan error, 1)
	go func() { errCh <- srv.Serve(s.ln) }()
	select {
	case <-ctx.Done():
		_ = srv.Close()
		return nil
	case err := <-errCh:
		return err
	}
}
