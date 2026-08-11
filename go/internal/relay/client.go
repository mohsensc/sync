// Package relay is the daemon's one connection to the Python relay: join,
// reconnect with backoff, bounded outbound buffering, and dispatch of the
// frames documented in cpp/daemon/relay_client.hpp. It is the piece #18
// exists to replace — nhooyr.io/websocket or gorilla/websocket instead of
// 1,783 lines of hand-rolled RFC 6455.
//
// Every failure here is fail-open, same rule as the C++ client: no relay, a
// refused connection, a bad handshake, a mid-stream protocol error all end
// at backoff and a daemon that keeps answering hooks. Nothing in this
// package can block the hook socket — Run drives the connection from its
// own goroutine, which is this package's answer to the C++ client's
// non-blocking connect state machine: Go has no single-threaded event loop
// to avoid blocking, so the equivalent guarantee is "the relay connection
// lives on its own goroutine and touches the hook path only through
// channels and the lease cache's mutex."
package relay

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"

	"github.com/mohsensc/sync/go/internal/leases"
	"github.com/mohsensc/sync/go/internal/outbound"
	"github.com/mohsensc/sync/go/internal/wire"
)

// State mirrors the C++ client's state enum, narrowed to what a goroutine
// loop actually needs to report: whether frames are currently flowing.
type State int32

const (
	StateIdle State = iota
	StateConnecting
	StateOpen
	StateBackoff
)

type Config struct {
	URL   string
	Room  string
	Agent string
	Human string

	Principal  string
	Token      string
	Unattended bool

	BackoffMin time.Duration
	BackoffMax time.Duration

	// Fallback lease lifetime for a frame that names a holder but no
	// remaining time. Matches leases.LEASE_TTL_S on the relay.
	LeaseTTL time.Duration

	PingInterval time.Duration
	IdleTimeout  time.Duration

	// Outbound queue capacity, in messages. Bounded and drop-oldest — see
	// internal/outbound.
	OutboundCapacity int
}

func (c Config) withDefaults() Config {
	if c.BackoffMin == 0 {
		c.BackoffMin = 250 * time.Millisecond
	}
	if c.BackoffMax == 0 {
		c.BackoffMax = 30 * time.Second
	}
	if c.LeaseTTL == 0 {
		c.LeaseTTL = 90 * time.Second
	}
	if c.PingInterval == 0 {
		c.PingInterval = 30 * time.Second
	}
	if c.IdleTimeout == 0 {
		c.IdleTimeout = 90 * time.Second
	}
	if c.OutboundCapacity == 0 {
		c.OutboundCapacity = 1000
	}
	return c
}

// Client is the daemon's one connection to the relay. Safe for concurrent
// use: SendText and the counters may be called from any goroutine while Run
// drives the connection.
type Client struct {
	cfg      Config
	outbound *outbound.Queue
	leases   *leases.Cache

	onPeer   func(wire.Presence)
	onPolicy func(wire.Policy)

	state atomic.Int32

	sent            atomic.Uint64
	received        atomic.Uint64
	connectAttempts atomic.Uint64
	drops           atomic.Uint64
	protocolErrors  atomic.Uint64

	mu        sync.Mutex
	lastError string
}

func New(cfg Config, lc *leases.Cache) *Client {
	cfg = cfg.withDefaults()
	return &Client{
		cfg:      cfg,
		outbound: outbound.New(cfg.OutboundCapacity),
		leases:   lc,
	}
}

func (c *Client) OnPeer(cb func(wire.Presence)) { c.onPeer = cb }
func (c *Client) OnPolicy(cb func(wire.Policy)) { c.onPolicy = cb }
func (c *Client) State() State                  { return State(c.state.Load()) }
func (c *Client) Open() bool                    { return c.State() == StateOpen }
func (c *Client) SentMessages() uint64          { return c.sent.Load() }
func (c *Client) ReceivedMessages() uint64      { return c.received.Load() }
func (c *Client) ConnectAttempts() uint64       { return c.connectAttempts.Load() }
func (c *Client) ConnectionsLost() uint64       { return c.drops.Load() }
func (c *Client) ProtocolErrors() uint64        { return c.protocolErrors.Load() }

func (c *Client) LastError() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.lastError
}

func (c *Client) setError(why string) {
	c.mu.Lock()
	c.lastError = why
	c.mu.Unlock()
}

// SendText queues a message for the relay. Goes through the bounded
// outbound queue, so it survives an outage exactly like a hook event does —
// same rule as RelayClient::send_text.
func (c *Client) SendText(msg []byte) {
	c.outbound.Push(msg)
}

// Run drives the connect/backoff loop until ctx is cancelled. Intended to be
// started in its own goroutine by the caller; see daemon.Run.
func (c *Client) Run(ctx context.Context) {
	if !strings.HasPrefix(c.cfg.URL, "ws://") {
		// wss is rejected rather than silently downgraded — same rule as
		// parse_relay_url in relay_client.cpp. TLS is #22, not this wave.
		c.setError("only ws:// is supported (see #22 for wss)")
		c.state.Store(int32(StateBackoff))
		return
	}

	backoff := time.Duration(0)
	for {
		if ctx.Err() != nil {
			return
		}

		c.state.Store(int32(StateConnecting))
		c.connectAttempts.Add(1)
		conn, resp, err := websocket.DefaultDialer.DialContext(ctx, c.cfg.URL, nil)
		if err != nil {
			if resp != nil {
				resp.Body.Close()
			}
			c.setError("connect failed: " + err.Error())
			c.state.Store(int32(StateBackoff))
			backoff = c.nextBackoff(backoff)
			if !c.sleepBackoff(ctx, backoff) {
				return
			}
			continue
		}

		c.state.Store(int32(StateOpen))
		backoff = 0
		err = c.runConnection(ctx, conn)
		c.drops.Add(1)
		c.setError(err.Error())
		c.state.Store(int32(StateBackoff))

		backoff = c.nextBackoff(backoff)
		if !c.sleepBackoff(ctx, backoff) {
			return
		}
	}
}

// nextBackoff mirrors RelayClient::drop's doubling: min on the first
// failure, doubled and capped at max after that.
func (c *Client) nextBackoff(cur time.Duration) time.Duration {
	if cur == 0 {
		return c.cfg.BackoffMin
	}
	next := cur * 2
	if next > c.cfg.BackoffMax {
		return c.cfg.BackoffMax
	}
	return next
}

func (c *Client) sleepBackoff(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

// runConnection owns one live connection: sends join, then runs a read pump
// and a write pump until either fails or ctx is cancelled. Returns the
// reason the connection ended, never nil.
func (c *Client) runConnection(ctx context.Context, conn *websocket.Conn) error {
	defer conn.Close()

	conn.SetReadDeadline(time.Now().Add(c.cfg.IdleTimeout))
	// Gorilla answers an inbound ping with a pong automatically via its
	// default ping handler; this only needs to keep the idle deadline
	// moving on liveness traffic that isn't a data frame.
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(c.cfg.IdleTimeout))
		return nil
	})

	if err := conn.WriteMessage(websocket.TextMessage, c.buildJoin()); err != nil {
		return err
	}
	c.sent.Add(1)

	errCh := make(chan error, 2)
	stop := make(chan struct{})
	var once sync.Once
	closeStop := func() { once.Do(func() { close(stop) }) }

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		defer closeStop()
		errCh <- c.readPump(conn)
	}()
	go func() {
		defer wg.Done()
		defer closeStop()
		errCh <- c.writePump(conn, stop)
	}()

	go func() {
		select {
		case <-ctx.Done():
			closeStop()
			conn.Close()
		case <-stop:
		}
	}()

	wg.Wait()
	close(errCh)

	// Both pumps report exactly one value each. Which lands first in the
	// channel is a genuine race, not just a matter of send order: when ctx
	// is cancelled, the watcher goroutine closes `stop` directly, which can
	// wake writePump's select (a nil, graceful exit) before readPump's
	// blocked ReadMessage call has actually returned the error the closed
	// conn produced. So take whichever of the two is non-nil rather than
	// just the first value — a graceful nil must never mask the real
	// reason the connection ended.
	var reason error
	for err := range errCh {
		if err != nil {
			reason = err
		}
	}
	if reason == nil {
		if err := ctx.Err(); err != nil {
			reason = err
		} else {
			reason = errConnectionClosed
		}
	}
	return reason
}

var errConnectionClosed = errors.New("relay: connection closed")

func (c *Client) buildJoin() []byte {
	j := wire.Join{
		Type:       "join",
		Room:       c.cfg.Room,
		Agent:      c.cfg.Agent,
		Human:      c.cfg.Human,
		Unattended: c.cfg.Unattended,
	}
	// Only when there is something to say — same rule as send_join in
	// relay_client.cpp: an unconfigured install puts exactly the bytes on
	// the wire it always did.
	if c.cfg.Principal != "" {
		j.Principal = c.cfg.Principal
		j.Token = c.cfg.Token
	}
	return wire.Marshal(j)
}

func (c *Client) readPump(conn *websocket.Conn) error {
	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			return err
		}
		conn.SetReadDeadline(time.Now().Add(c.cfg.IdleTimeout))
		c.received.Add(1)
		if err := c.dispatch(data); err != nil {
			c.protocolErrors.Add(1)
			return err
		}
	}
}

// writePump is the connection's only writer: gorilla permits at most one
// concurrent WriteMessage caller, so the join, every ping and every queued
// frame all flow through this one goroutine.
func (c *Client) writePump(conn *websocket.Conn, stop <-chan struct{}) error {
	pingT := time.NewTicker(c.cfg.PingInterval)
	defer pingT.Stop()
	// Bounded outbound is drained on a short tick rather than a
	// condition variable: the daemon's hook path never waits on this
	// goroutine either way, and a 50ms drain latency is invisible next to a
	// 90s lease TTL.
	drainT := time.NewTicker(50 * time.Millisecond)
	defer drainT.Stop()

	for {
		select {
		case <-stop:
			return nil
		case <-pingT.C:
			if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return err
			}
		case <-drainT.C:
			for _, msg := range c.outbound.Drain() {
				if err := conn.WriteMessage(websocket.TextMessage, msg); err != nil {
					return err
				}
				c.sent.Add(1)
			}
		}
	}
}

func (c *Client) dispatch(data []byte) error {
	var env wire.Envelope
	if err := json.Unmarshal(data, &env); err != nil {
		// Malformed input is dropped, never fatal — same rule the Python
		// relay applies to frames it can't parse either.
		return nil
	}

	switch env.Type {
	case "presence":
		var p wire.Presence
		if err := json.Unmarshal(data, &p); err != nil || p.Agent == "" {
			return nil
		}
		if c.onPeer != nil {
			c.onPeer(p)
		}
	case "leases":
		// Only a real array replaces the table. Garbage or a missing/null
		// "leases" key means a frame we don't understand, and wiping every
		// lease on it would turn one bad frame into a room with no
		// protection — same check as on_text's handling of a "leases"
		// frame in relay_client.cpp (`arr->front() != '['`).
		var raw struct {
			Leases json.RawMessage `json:"leases"`
		}
		if err := json.Unmarshal(data, &raw); err != nil {
			return nil
		}
		trimmed := bytes.TrimSpace(raw.Leases)
		if len(trimmed) == 0 || trimmed[0] != '[' {
			return nil
		}
		var entries []wire.LeaseFrame
		if err := json.Unmarshal(trimmed, &entries); err != nil {
			return nil
		}
		table := make(map[string]leases.Lease, len(entries))
		for _, e := range entries {
			key, lease, ok := c.toLease(e)
			if ok {
				table[key] = lease
			}
		}
		c.leases.Replace(table)
	case "lease":
		var e wire.LeaseFrame
		if err := json.Unmarshal(data, &e); err != nil {
			return nil
		}
		c.applyLease(e)
	case "claim_result":
		var e wire.LeaseFrame
		if err := json.Unmarshal(data, &e); err != nil {
			return nil
		}
		c.applyClaimResult(e)
	case "policy":
		var p wire.Policy
		if err := json.Unmarshal(data, &p); err != nil || len(p.Floor) != 5 {
			// A frame this daemon half-understands must leave the floor
			// where it was — see on_text's handling of a malformed
			// "policy" frame in relay_client.cpp.
			return nil
		}
		if c.onPolicy != nil {
			c.onPolicy(p)
		}
	case "join_refused":
		var r wire.JoinRefused
		if err := json.Unmarshal(data, &r); err == nil {
			log.Printf("relay: join refused for room %s: %s (%s)", r.Room, r.Reason, r.Detail)
		}
	}
	return nil
}

// toLease turns one wire lease entry into a cache entry, or reports it
// unusable. Mirrors upsert_lease's shape, minus the handover bookkeeping
// (own_handover / lost-region notes) that leases.Cache does not carry in
// wave 1 — see that package's doc comment.
func (c *Client) toLease(e wire.LeaseFrame) (string, leases.Lease, bool) {
	if e.Region.Path == "" || e.Agent == "" {
		return "", leases.Lease{}, false
	}
	symbol := ""
	if e.Region.Symbol != nil {
		symbol = *e.Region.Symbol
	}
	ttl := c.cfg.LeaseTTL
	if e.ExpiresInMs != nil {
		ttl = time.Duration(*e.ExpiresInMs) * time.Millisecond
	}
	if ttl < 0 {
		ttl = 0
	}
	lease := leases.Lease{
		Agent:       e.Agent,
		Human:       e.Human,
		Intent:      e.Intent,
		Priority:    e.Priority,
		ExpiresAtMs: nowMs() + ttl.Milliseconds(),
		Waiting:     e.Waiting,
	}
	return leases.RegionKey(e.Region.Path, symbol), lease, true
}

func (c *Client) applyLease(e wire.LeaseFrame) {
	if e.Region.Path == "" {
		return
	}
	symbol := ""
	if e.Region.Symbol != nil {
		symbol = *e.Region.Symbol
	}
	key := leases.RegionKey(e.Region.Path, symbol)

	switch e.State {
	case "released", "expired", "handover":
		// Erase only when the frame names the agent that currently holds
		// it — an unattributed erase must never delete a handover's
		// grant. See erase_lease's comment in relay_client.cpp for why
		// getting this wrong is the silent-loss bug this daemon exists to
		// prevent.
		c.leases.EraseIfHeldBy(key, e.Agent)
		return
	}

	k, lease, ok := c.toLease(e)
	if !ok {
		return
	}
	c.leases.Upsert(k, lease)
}

func (c *Client) applyClaimResult(e wire.LeaseFrame) {
	holder := e.HeldBy
	if e.Granted {
		holder = c.cfg.Agent
	}
	if holder == "" {
		return
	}
	priority := e.HolderPriority
	if e.Granted {
		priority = e.Priority
	}
	e.Agent = holder
	e.Priority = priority
	k, lease, ok := c.toLease(e)
	if !ok {
		return
	}
	c.leases.Upsert(k, lease)
}

// nowMs is wall time, not monotonic. Known deviation from the C++ side: see
// docs/go-daemon.md's clock-source note.
func nowMs() int64 {
	return time.Now().UnixMilli()
}
