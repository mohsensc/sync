package relaysrv

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"log"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/mohsensc/sync/go/internal/metrics"
)

var errTLSPairRequired = errors.New("TLSCert and TLSKey must be given together")

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

	// How often a writer that is parked on a socket looks at the clock,
	// in real wall time — not a threshold itself, SendStallS/SendSaturatedS
	// are, and they're read off the injectable clock; this is only the
	// resolution the writer notices them at. Matches serve.py's SEND_POLL_S.
	SendPollInterval = 50 * time.Millisecond

	// How often the background sweep walks every shard of every room to
	// prune and broadcast expired leases, regardless of whether anything
	// touched that shard. See leases.go's SweepAll and issue #47 — the
	// per-call sweep in pruneExpired only ever reaches the shard a request
	// touches, so an idle shard's expiry needs something off the hot path
	// to notice it promptly. One second matches the granularity a human
	// or a daemon actually cares about; it is not the hot-path lock this
	// sharding exists to avoid, since each tick takes and releases one
	// shard's own mutex in turn rather than one lock spanning all of them.
	ExpirySweepInterval = 1 * time.Second
)

// Frame-dropped reasons this connection can report, a fixed vocabulary
// for metrics.FrameDropped's reason label — metrics.go doesn't export one
// (see its package doc on why a label domain has to stay bounded no
// matter what a call site happens to have lying around for a log line),
// so this package defines its own and uses it consistently rather than
// passing shedReason's human-readable sentences straight through.
const (
	dropReasonQueueFull = "queue_full"
	dropReasonStall     = "stall"
	dropReasonSaturated = "saturated"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	// Loopback tool, no browser origin to police — same trust boundary
	// serve.py runs with (see docs/threat-model.md): anyone who can reach
	// the port can join any room.
	CheckOrigin: func(*http.Request) bool { return true },
}

// wsWriter is the subset of *websocket.Conn the writer goroutine below
// needs. An interface, not the concrete type, so a test can substitute a
// peer whose write blocks until poked — the same role python's duck-typed
// `_FakeWs` plays in test_backpressure.py's pure-VirtualClock tests (no
// real socket, no wedge-budget blast) — see backpressure_test.go.
// *websocket.Conn satisfies this with no wrapper needed.
type wsWriter interface {
	WriteMessage(messageType int, data []byte) error
	WriteControl(messageType int, data []byte, deadline time.Time) error
	Close() error
}

// WsConn is one connection: goroutine per connection, one bounded outbound
// channel, one writer goroutine. Mirrors serve.py's WsConn — see there for
// the full argument on why sends are non-blocking and why a saturated
// peer gets disconnected rather than allowed to grow the relay's memory
// without bound.
type WsConn struct {
	ws      wsWriter
	clock   Clock
	metrics *metrics.Registry

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

func NewWsConn(ws wsWriter, clock Clock, m *metrics.Registry) *WsConn {
	now := clock.Now()
	c := &WsConn{
		ws:      ws,
		clock:   clock,
		metrics: m,
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
		c.metrics.FrameDropped(dropReasonQueueFull)
	default:
	}
	select {
	case c.out <- payload:
	default:
		// Lost a race with the writer goroutine draining concurrently;
		// the queue had room again by the time we retried. Fine either
		// way — payload is simply not queued this time, matching the
		// spirit of drop-oldest under contention. Still a frame that
		// didn't reach the queue, so it's still worth counting.
		c.metrics.FrameDropped(dropReasonQueueFull)
	}
}

// shedReason reports both a bounded reason code (for metrics.FrameDropped
// — see the dropReason constants above) and the human-readable detail
// shed's log line already carried, so adding the metric didn't mean
// inventing a second way to describe the same two conditions.
func (c *WsConn) shedReason() (reason, detail string) {
	now := c.clock.Now()
	c.mu.Lock()
	sendingSince, saturatedSince := c.sendingSince, c.saturatedSince
	c.mu.Unlock()
	if sendingSince != nil && now-*sendingSince >= SendStallS {
		return dropReasonStall, "one frame did not leave in the stall window"
	}
	if saturatedSince != nil && now-*saturatedSince >= SendSaturatedS {
		return dropReasonSaturated, "send queue full for over the saturation window"
	}
	return "", ""
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

// write puts one frame on the socket. False means this writer is finished.
//
// The send runs in its own goroutine and this watches it on a real-time
// poll ticker rather than just awaiting it directly, because SendStallS
// is measured on the injectable clock (so a test reaches it with
// clock.Advance, never a real wait) and a socket that has actually
// stopped draining does not return from WriteMessage on its own —
// nothing times it out. Without this, a genuinely wedged peer's writer
// goroutine blocks inside WriteMessage forever: shedReason is never
// reached, the connection is never shed, and the goroutine leaks for the
// life of the process — the exact class of leak this design exists to
// prevent, just moved from "one task per frame" (the pre-fix Python bug)
// to "stuck inside the one send this connection will ever finish."
// Mirrors serve.py's _write, including polling on wall time but deciding
// on clock time — see SendPollInterval.
func (c *WsConn) write(payload []byte) bool {
	now := c.clock.Now()
	c.mu.Lock()
	c.sendingSince = &now
	c.mu.Unlock()

	done := make(chan error, 1)
	go func() { done <- c.ws.WriteMessage(websocket.TextMessage, payload) }()

	ticker := time.NewTicker(SendPollInterval)
	defer ticker.Stop()
	for {
		select {
		case err := <-done:
			c.mu.Lock()
			c.sendingSince = nil
			c.mu.Unlock()
			if err != nil {
				c.shutdown()
				return false
			}
			if reason, why := c.shedReason(); why != "" {
				c.shed(reason, why)
				return false
			}
			return true
		case <-ticker.C:
			if reason, why := c.shedReason(); why == "" {
				continue
			} else {
				c.mu.Lock()
				c.sendingSince = nil
				c.mu.Unlock()
				// The send in `done` is abandoned, not cancelled — Go has
				// no way to interrupt a goroutine mid-syscall. shed's
				// ws.Close() below takes the underlying connection down,
				// which is what makes that abandoned WriteMessage return
				// (with an error nobody reads, since `done` is buffered
				// 1): the goroutine still exits, it just does so once the
				// close lands rather than on this call's own timeline.
				c.shed(reason, why)
				return false
			}
		}
	}
}

// shed hangs up on a subscriber that is not keeping up: marks the
// connection closed, best-effort tells the peer why over the socket, then
// takes the transport down under it so a peer that will not even read a
// close frame cannot keep this goroutine (or the one still blocked in
// write's WriteMessage, if that's why shed was called) parked forever.
func (c *WsConn) shed(reason, why string) {
	c.mu.Lock()
	dropped := c.dropped
	c.mu.Unlock()
	log.Printf("dropping subscriber %q (room %q): %s, %d frames shed", c.Agent(), c.Room(), why, dropped)
	c.shutdown()
	c.metrics.FrameDropped(reason)
	_ = c.ws.WriteControl(websocket.CloseMessage,
		websocket.FormatCloseMessage(1013, "subscriber too slow"),
		time.Now().Add(2*time.Second))
	_ = c.ws.Close()
}

func (c *WsConn) shutdown() {
	c.closeOnce.Do(func() { close(c.closed) })
}

// Close sends a close frame with the given code/reason and then takes the
// transport down — the graceful counterpart to shed's too-slow hangup,
// used for a server-initiated shutdown (see Server.closeConns) rather
// than a saturated peer. Safe to call from outside the writer goroutine
// while writeLoop/write may still be mid-WriteMessage on the same
// connection: WriteControl and Close are the two *websocket.Conn methods
// gorilla documents as callable concurrently with any other method, so
// this doesn't need to route through the outbound channel the way a data
// frame would.
func (c *WsConn) Close(code int, reason string) {
	c.shutdown()
	_ = c.ws.WriteControl(websocket.CloseMessage,
		websocket.FormatCloseMessage(code, reason),
		time.Now().Add(closeDeadline))
	_ = c.ws.Close()
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
		c.metrics.FrameRejectedInbound()
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

func (s *Server) session(ws *websocket.Conn) {
	relay := s.Relay
	ws.SetReadLimit(MaxFrameBytes)
	conn := NewWsConn(ws, relay.Clock(), relay.metrics)
	go conn.writeLoop()

	relay.metrics.RelayConnections.Add(1)
	s.trackConn(conn)

	defer func() {
		s.untrackConn(conn)
		relay.metrics.RelayConnections.Add(-1)
		relay.Leave(conn)
		conn.shutdown()
		// ReadMessage's default close handler already echoes a close
		// frame back to a peer that initiated the handshake (that's
		// gorilla's documented default behavior), but nothing closes the
		// underlying TCP connection on this end once the read loop
		// exits — not on a clean close, not on an error, not on a shed.
		// A client's own close() waits out its close_timeout for the
		// connection to actually go away at the transport level, not
		// just for the frame exchange, so every disconnect paid that
		// timeout instead of returning immediately. Confirmed directly:
		// a client-initiated close against an unpatched gorelay took a
		// consistent 10.0s (websockets' default close_timeout) instead
		// of completing as soon as the close frames crossed.
		_ = ws.Close()
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

	// TLSCert/TLSKey terminate wss:// instead of ws:// when both are set,
	// mirroring serve.py's build_tls_context: same PEM cert-chain-plus-key
	// shape, loaded once at Listen time. Unset by default — plaintext
	// ws:// on loopback is still the zero-config path. See main.go for the
	// flag/env names, which match the Python relay's exactly so an
	// operator's existing invocation means the same thing against either
	// binary.
	TLSCert string
	TLSKey  string

	ln net.Listener

	// connsMu/conns is every WsConn currently accepted, tracked purely so
	// the sweep ticker in Serve can sample SendQueueDepth as the max
	// queue length live in the process — one shared gauge, not a
	// per-connection one (see the metrics package doc comment on why
	// there's deliberately no per-daemon label). Added/removed at the
	// same two points RelayConnections is, in session.
	connsMu sync.Mutex
	conns   map[*WsConn]struct{}
}

// closeDeadline bounds one connection's close handshake: how long
// WriteControl gets to land the close frame before Close gives up and
// takes the socket down anyway. Mirrors shed's own control-frame deadline.
const closeDeadline = 2 * time.Second

// shutdownDeadline bounds Serve's whole shutdown path. closeConns fans the
// per-connection close handshake out to every tracked session
// concurrently, so one stuck peer only ever costs closeDeadline — this is
// the backstop for everything else (many sessions, a wedged goroutine)
// that could otherwise push a relay restart past what an operator is
// willing to wait.
const shutdownDeadline = 5 * time.Second

func (s *Server) trackConn(c *WsConn) {
	s.connsMu.Lock()
	if s.conns == nil {
		s.conns = make(map[*WsConn]struct{})
	}
	s.conns[c] = struct{}{}
	s.connsMu.Unlock()
}

func (s *Server) untrackConn(c *WsConn) {
	s.connsMu.Lock()
	delete(s.conns, c)
	s.connsMu.Unlock()
}

// sampleSendQueueDepth sets SendQueueDepth to the deepest outbound queue
// any live connection is carrying right now, zero when nobody is. A
// prometheus Gauge has no compare-and-swap, so "the slowest consumer" has
// to be computed here, over every connection, rather than each one
// Set-ing its own length and clobbering its neighbours' — len() on a
// channel is a lock-free read, safe to call from this goroutine while
// writeLoop drains the same channel from its own.
func (s *Server) sampleSendQueueDepth() {
	s.connsMu.Lock()
	deepest := 0
	for c := range s.conns {
		if n := len(c.out); n > deepest {
			deepest = n
		}
	}
	s.connsMu.Unlock()
	s.Relay.metrics.SendQueueDepth.Set(float64(deepest))
}

// closeConns sends every currently-tracked session a 1001 (going away)
// close frame and takes its transport down, so a relay restart reads to
// every connected daemon as a clean disconnect instead of the RST an
// unclosed hijacked connection gets when the process exits underneath it
// — see issue #97. One goroutine per connection so a peer that never
// reads its close frame only costs closeDeadline, and the wait for all of
// them is itself capped at shutdownDeadline so a pile of stuck peers
// can't hang a restart either.
func (s *Server) closeConns() {
	s.connsMu.Lock()
	conns := make([]*WsConn, 0, len(s.conns))
	for c := range s.conns {
		conns = append(conns, c)
	}
	s.connsMu.Unlock()

	var wg sync.WaitGroup
	wg.Add(len(conns))
	for _, c := range conns {
		go func(c *WsConn) {
			defer wg.Done()
			c.Close(websocket.CloseGoingAway, "relay shutting down")
		}(c)
	}

	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(shutdownDeadline):
	}
}

// Listen binds the socket and returns the bound address; call Serve to
// accept connections. Splitting bind from accept is what lets tests use
// port 0 and read back the real port before any client tries to connect.
func (s *Server) Listen() (string, error) {
	if (s.TLSCert == "") != (s.TLSKey == "") {
		return "", errTLSPairRequired
	}
	if s.TLSCert != "" {
		cert, err := tls.LoadX509KeyPair(s.TLSCert, s.TLSKey)
		if err != nil {
			return "", err
		}
		// MinVersion pinned rather than left at the stdlib default for the
		// same reason serve.py picks PROTOCOL_TLS_SERVER instead of a bare
		// socket: TLS 1.2+ is the modern floor, not a version to leave to
		// whatever this Go toolchain shipped with.
		cfg := &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12}
		ln, err := tls.Listen("tcp", s.Addr, cfg)
		if err != nil {
			return "", err
		}
		s.ln = ln
		return ln.Addr().String(), nil
	}
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
		go s.session(ws)
	})
	srv := &http.Server{Handler: mux}
	errCh := make(chan error, 1)
	go func() { errCh <- srv.Serve(s.ln) }()

	sweep := time.NewTicker(ExpirySweepInterval)
	defer sweep.Stop()
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case <-sweep.C:
				s.Relay.registry.SweepAll()
				s.sampleSendQueueDepth()
			}
		}
	}()

	select {
	case <-ctx.Done():
		// srv.Close() first: it stops the listener immediately and, by
		// contract, never touches an already-hijacked connection. Doing
		// closeConns() first left the listener open for up to
		// shutdownDeadline while it drained sessions, so a client dialing
		// in that window wasn't in the snapshot closeConns fanned out to
		// and got the raw RST this whole fix exists to remove.
		_ = srv.Close()
		s.closeConns()
		return nil
	case err := <-errCh:
		return err
	}
}

// MetricsServer builds the /metrics scrape endpoint, unstarted — call
// ListenAndServe (or ListenAndServeTLS) on it. Returns nil when addr is
// empty: there is deliberately no default address (see metrics.Registry.
// Handler's doc comment) — an endpoint that shows up on a well-known port
// without anyone asking is a way to leak a room's shape to whoever shares
// the network, so serving it at all is an operator's explicit choice, not
// a fallback this package reaches for on its own.
//
// Registers only "/metrics" on its own ServeMux, never Server's own "/"
// websocket handler, and gives it read/write/idle timeouts a plain
// &http.Server{} doesn't have by default — a scrape client that opens the
// connection and never finishes the request is otherwise a way to wedge
// a listener open indefinitely, on an endpoint whose only job is to
// answer fast.
func MetricsServer(addr string, reg *metrics.Registry) *http.Server {
	if addr == "" {
		return nil
	}
	mux := http.NewServeMux()
	mux.Handle("/metrics", reg.Handler())
	return &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadTimeout:       5 * time.Second,
		ReadHeaderTimeout: 5 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       30 * time.Second,
	}
}
