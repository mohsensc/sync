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
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"

	"github.com/mohsensc/sync/go/internal/leases"
	"github.com/mohsensc/sync/go/internal/metrics"
	"github.com/mohsensc/sync/go/internal/outbound"
	"github.com/mohsensc/sync/go/internal/policy"
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

	// WriteTimeout bounds a single outbound write. Without one, a relay
	// that keeps the socket open but stops reading parks writePump inside
	// WriteMessage forever once the kernel send buffer fills — see
	// writePump for why that wedges the whole client rather than just one
	// frame.
	WriteTimeout time.Duration

	// Outbound queue capacity, in messages. Bounded and drop-oldest — see
	// internal/outbound.
	OutboundCapacity int

	// TLS, consulted only when URL has a wss:// scheme. The zero value
	// verifies the relay's certificate against the system root pool —
	// the same thing any other TLS client on this machine trusts.
	//
	// TLSCAFile adds one more trusted PEM (cert or bundle) on top of that
	// pool — see #22's docs/tls-dev-cert.md — for a self-signed dev
	// relay. It does not disable verification; a relay presenting
	// anything else still fails the handshake.
	TLSCAFile string
	// TLSInsecureSkipVerify turns certificate verification off entirely.
	// The connection is still encrypted; it's just no longer proof of
	// which relay is on the other end, which is what verification is
	// for. Logged loudly on every Run — this is not meant to be a quiet
	// flag to flip and forget. Prefer TLSCAFile.
	TLSInsecureSkipVerify bool

	// Metrics is where connection-state and lease-cache-divergence numbers
	// go. Nil is a real, supported state — every call site here checks it
	// rather than the daemon inventing a private registry nobody reads;
	// see daemon.Options.Metrics's comment for the same call on the
	// decision path, which is the one place a nil check wasn't free
	// enough to leave in.
	Metrics *metrics.Registry
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
	if c.WriteTimeout == 0 {
		c.WriteTimeout = 10 * time.Second
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
	metrics  *metrics.Registry // nil is valid; every call site below checks it

	onPeer   func(wire.Presence)
	onPolicy func(floor policy.Table, source string)

	state atomic.Int32

	sent            atomic.Uint64
	received        atomic.Uint64
	connectAttempts atomic.Uint64
	drops           atomic.Uint64
	protocolErrors  atomic.Uint64

	// outboundDropped mirrors the last value read off c.outbound.Dropped(),
	// which is a running total, not a delta — same shape as
	// leases.Cache.believed shadowing the cache. Recorded here so SendText
	// can fold each new drop into metrics.Registry.OutboundDropped, which
	// (like every other counter in that package) only accepts increments.
	outboundDropped atomic.Uint64

	// mu guards lastError alone; every other piece of shared state on
	// Client is already an atomic. One string, set from Run's goroutine
	// and read from LastError by anything reporting status — not on the
	// decision path, not worth a channel-owned goroutine of its own (#20;
	// see docs/go-daemon.md's "every remaining mutex, checked on merit").
	mu        sync.Mutex
	lastError string

	// believed mirrors exactly the region keys this Client has told
	// leases.Cache about, plus enough of each entry (agent, expiry) to
	// answer "does this still matter" at the next reconcile. leases.Cache
	// exposes no way to enumerate what it holds — Conflict and OwnHandover
	// are both scoped to one path — and this Client is the cache's only
	// writer (dispatch's "lease"/"leases"/"claim_result" cases are the
	// whole of it), so keeping a shadow here in lockstep is exact, not an
	// approximation.
	//
	// Must always be a map this Client owns outright, never one handed to
	// leases.Cache.Replace: the "leases" case used to set
	// c.believed = table, the same map object passed to Replace, which
	// made believed the cache's live byRegion table under a completely
	// different lock than Cache.mu — a genuine race (-race caught it: a
	// later applyLease write here landing mid-Conflict-iteration over the
	// same memory), not a missing-lock one. See that case's own comment.
	//
	// dispatch only ever runs on the read pump's own goroutine, so
	// believedMu isn't load-bearing for that reason — it is here because
	// this is off the decision path, a mutex costs nothing anyone would
	// measure, and not resting correctness on "only one goroutine ever
	// calls this" is worth the two lines.
	believedMu sync.Mutex
	believed   map[string]leases.Lease
}

func New(cfg Config, lc *leases.Cache) *Client {
	cfg = cfg.withDefaults()
	return &Client{
		cfg:      cfg,
		outbound: outbound.New(cfg.OutboundCapacity),
		leases:   lc,
		metrics:  cfg.Metrics,
		believed: make(map[string]leases.Lease),
	}
}

func (c *Client) OnPeer(cb func(wire.Presence))                       { c.onPeer = cb }
func (c *Client) OnPolicy(cb func(floor policy.Table, source string)) { c.onPolicy = cb }
func (c *Client) State() State                                        { return State(c.state.Load()) }
func (c *Client) Open() bool                                          { return c.State() == StateOpen }
func (c *Client) SentMessages() uint64                                { return c.sent.Load() }
func (c *Client) ReceivedMessages() uint64                            { return c.received.Load() }
func (c *Client) ConnectAttempts() uint64                             { return c.connectAttempts.Load() }
func (c *Client) ConnectionsLost() uint64                             { return c.drops.Load() }
func (c *Client) ProtocolErrors() uint64                              { return c.protocolErrors.Load() }

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
	c.recordOutboundDropped()
}

// recordOutboundDropped folds outbound.Queue's cumulative drop count into
// metrics.Registry.OutboundDropped as a delta. Push may be called
// concurrently from several goroutines (SendText has no single-caller
// rule), so this CASes rather than swaps: two callers racing on a stale
// "prev" must not both count the same drop, or double it.
func (c *Client) recordOutboundDropped() {
	if c.metrics == nil {
		return
	}
	total := uint64(c.outbound.Dropped())
	for {
		prev := c.outboundDropped.Load()
		if total <= prev {
			return
		}
		if c.outboundDropped.CompareAndSwap(prev, total) {
			c.metrics.OutboundDropped.Add(float64(total - prev))
			return
		}
	}
}

// Run drives the connect/backoff loop until ctx is cancelled. Intended to be
// started in its own goroutine by the caller; see daemon.Run.
func (c *Client) Run(ctx context.Context) {
	isWSS := strings.HasPrefix(c.cfg.URL, "wss://")
	if !strings.HasPrefix(c.cfg.URL, "ws://") && !isWSS {
		// Neither scheme silently downgraded nor silently upgraded — same
		// rule parse_relay_url in relay_client.cpp applied to ws://.
		c.setError(fmt.Sprintf("relay url must start with ws:// or wss://, got %q", c.cfg.URL))
		c.state.Store(int32(StateBackoff))
		return
	}

	dialer := websocket.DefaultDialer
	if isWSS {
		tlsConfig, err := c.buildTLSConfig()
		if err != nil {
			// Fail-open like every other error in this loop: a bad CA
			// file means "never connects," not "crash the daemon."
			c.setError(err.Error())
			c.state.Store(int32(StateBackoff))
			return
		}
		d := *websocket.DefaultDialer
		d.TLSClientConfig = tlsConfig
		dialer = &d
	}

	// everConnected and downSince exist only to word the log line right:
	// the first successful dial of a fresh process is "connected", every
	// one after a drop is "reconnected after N ms" — the number an
	// operator actually wants after a relay outage, which nothing in this
	// package used to print at all.
	var everConnected bool
	downSince := time.Now()

	backoff := time.Duration(0)
	for {
		if ctx.Err() != nil {
			return
		}

		c.state.Store(int32(StateConnecting))
		c.connectAttempts.Add(1)
		log.Printf("relay: connecting to %s", c.cfg.URL)
		conn, resp, err := dialer.DialContext(ctx, c.cfg.URL, nil)
		if err != nil {
			if resp != nil {
				resp.Body.Close()
			}
			reason := "connect failed: " + err.Error()
			c.setError(reason)
			c.state.Store(int32(StateBackoff))
			backoff = c.nextBackoff(backoff)
			log.Printf("relay: %s — backing off %v before retrying", reason, backoff)
			if !c.sleepBackoff(ctx, backoff) {
				return
			}
			continue
		}

		c.state.Store(int32(StateOpen))
		connectedAt := time.Now()
		if c.metrics != nil {
			c.metrics.DaemonConnected.Set(1)
		}
		if everConnected {
			log.Printf("relay: reconnected to %s after %d ms", c.cfg.URL, time.Since(downSince).Milliseconds())
			if c.metrics != nil {
				c.metrics.Reconnects.Inc()
			}
		} else {
			log.Printf("relay: connected to %s", c.cfg.URL)
			everConnected = true
		}
		err = c.runConnection(ctx, conn)
		c.drops.Add(1)
		reason := err.Error()
		c.setError(reason)
		c.state.Store(int32(StateBackoff))
		if c.metrics != nil {
			c.metrics.DaemonConnected.Set(0)
		}
		downSince = time.Now()

		// Reset the backoff only for a connection that actually lasted.
		// Resetting on a successful *dial* meant a relay that completes the
		// handshake and then ends the session every time — join_refused, a
		// mid-restart drain, any policy path that closes after accept
		// instead of refusing before it — was hammered at BackoffMin
		// forever, since every failure computed nextBackoff(0) and
		// nextBackoff returns the floor for a zero input. The doubling its
		// own comment describes never happened.
		//
		// A duration, not "did we receive a frame": join_refused is itself
		// a received frame, so that heuristic would reset the backoff on
		// exactly the case this fixes.
		if time.Since(connectedAt) >= minDurableConnection {
			backoff = 0
		}
		backoff = c.nextBackoff(backoff)
		log.Printf("relay: connection lost: %s — backing off %v before retrying", reason, backoff)
		if !c.sleepBackoff(ctx, backoff) {
			return
		}
	}
}

// buildTLSConfig turns the config's TLS options into what gorilla's dialer
// wants. Called once per Run, not per reconnect attempt — the CA file (or
// the skip-verify decision) doesn't change mid-process, and the loud
// warning below belongs at startup, not on every backoff retry.
func (c *Client) buildTLSConfig() (*tls.Config, error) {
	if c.cfg.TLSInsecureSkipVerify {
		// Deliberately not gated behind a log level: this is the one
		// warning in the package meant to be impossible to miss.
		log.Printf("relay: TLS CERTIFICATE VERIFICATION DISABLED — connecting to %s "+
			"without checking who's on the other end. Traffic is still encrypted, "+
			"but anyone who can intercept the connection can impersonate the relay. "+
			"This is for local development only; see docs/tls-dev-cert.md for the "+
			"non-insecure option (AGENT_PRESENCE_RELAY_CA).", c.cfg.URL)
		return &tls.Config{InsecureSkipVerify: true}, nil
	}
	if c.cfg.TLSCAFile == "" {
		// System root pool, same as any other TLS client on this
		// machine — the default this issue asks for.
		return nil, nil
	}
	pem, err := os.ReadFile(c.cfg.TLSCAFile)
	if err != nil {
		return nil, fmt.Errorf("relay: cannot read TLS CA file %s: %w", c.cfg.TLSCAFile, err)
	}
	pool, err := x509.SystemCertPool()
	if err != nil || pool == nil {
		pool = x509.NewCertPool()
	}
	if !pool.AppendCertsFromPEM(pem) {
		return nil, fmt.Errorf("relay: no PEM certificate found in %s", c.cfg.TLSCAFile)
	}
	return &tls.Config{RootCAs: pool}, nil
}

// nextBackoff mirrors RelayClient::drop's doubling: min on the first
// failure, doubled and capped at max after that.
// minDurableConnection is how long a connection has to last before it
// counts as "this relay works", clearing the accrued backoff. Anything
// shorter is treated as a failed attempt that happened to get past the
// handshake.
const minDurableConnection = time.Second

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
// writePump sets a write deadline before every write. Without one, a relay
// that keeps the socket open but stops reading — an overloaded relay, a
// half-open connection after a NAT or load-balancer hiccup, a machine
// waking from sleep — parks this goroutine inside WriteMessage for good
// once the kernel send buffer fills.
//
// That wedges the entire client, not just one frame. readPump's own
// deadline fires, so it returns and closes `stop`; the ctx watcher then
// takes its `<-stop` branch and returns without closing the connection;
// and the `defer conn.Close()` that would have unblocked this write only
// runs after wg.Wait(), which is waiting on this goroutine. The socket and
// this goroutine leak for the life of the process, Run never reaches its
// backoff path, and because state and DaemonConnected only flip after
// runConnection returns, the daemon goes on reporting StateOpen and
// connected=1 forever — squarely against this package's promise that every
// failure ends at backoff.
//
// The join write in runConnection is deliberately left without one: it
// runs before either pump exists, so a block there cannot deadlock against
// wg.Wait, and the dial's own handshake timeout already bounds getting
// that far.
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
			conn.SetWriteDeadline(time.Now().Add(c.cfg.WriteTimeout))
			if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return err
			}
		case <-drainT.C:
			// Peek, not Drain: a message only leaves the queue once
			// WriteMessage actually accepts it. A write error here used to
			// hit an already-emptied queue, so the failed frame and
			// everything queued behind it (Drain had already taken the
			// whole batch) were gone for good, with nothing left to retry
			// on reconnect — the opposite of the contract SendText
			// promises. Leaving the message queued until it is confirmed
			// sent means a mid-write failure just stops here and picks up
			// again, in order, next tick after reconnect.
			//
			// Bounded to this tick's starting depth, same as Drain's
			// snapshot was: SendText can run concurrently with this loop
			// (no single-writer rule on it), and without a bound a steady
			// stream of pushes would keep this case from ever returning to
			// select — late pings, an unresponsive stop channel.
			for n := c.outbound.Len(); n > 0; n-- {
				msg, seq, ok := c.outbound.Peek()
				if !ok {
					break // drop-oldest can shrink the queue out from under us
				}
				conn.SetWriteDeadline(time.Now().Add(c.cfg.WriteTimeout))
				if err := conn.WriteMessage(websocket.TextMessage, msg); err != nil {
					return err
				}
				c.sent.Add(1)
				// Pop(seq) is a no-op, not an error, if drop-oldest already
				// evicted this exact frame between the write above and
				// here — it was still written, just also counted as a
				// drop; see outbound.Queue.Pop.
				c.outbound.Pop(seq)
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
		shadow := make(map[string]leases.Lease, len(entries))
		for _, e := range entries {
			key, lease, ok := c.toLease(e)
			if ok {
				table[key] = lease
				shadow[key] = lease
			}
		}
		c.recordDivergence(table)
		c.leases.Replace(table)
		// The snapshot just became truth; the shadow matches it exactly
		// until the next lease/leases/claim_result frame moves it again.
		// Built as its own map here, deliberately not `c.believed = table`:
		// Replace hands table to leases.Cache as its live backing store,
		// and the two maps being the same object let a later applyLease
		// write land inside the cache's own table mid-Conflict, under a
		// completely different lock than the one protecting it there —
		// a real bug -race caught, not a false positive.
		c.believedMu.Lock()
		c.believed = shadow
		c.believedMu.Unlock()
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
		// Starts from BuiltinFloor, same as on_text: an unknown effect
		// name at one rung leaves that rung at the builtin floor rather
		// than at whatever the previous "policy" frame set it to.
		floor := policy.BuiltinFloor
		for i, name := range p.Floor {
			if e, ok := policy.ParseEffect(name); ok {
				floor[i] = e
			}
		}
		if c.onPolicy != nil {
			c.onPolicy(floor, p.Source)
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
// unusable. Mirrors upsert_lease's shape, including the handover deadline
// carried on the lease itself — see leases.Lease's HasHandover note for why
// it holds a bit instead of C++'s -1 sentinel.
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
		// The scope this lease was claimed at, so a later edit decision
		// on this path can tell "same symbol" from "disjoint symbol"
		// without re-deriving it from the key — see leases.Cache.Conflict.
		Symbol: symbol,
	}
	// A duration on the wire, an absolute monotonic-ish instant here —
	// same rule as expires_in_ms above. Absent means nobody has asked for
	// the region, the common case.
	if e.HandoverInMs != nil {
		left := int64(*e.HandoverInMs)
		if left < 0 {
			left = 0
		}
		lease.HasHandover = true
		lease.HandoverAtMs = nowMs() + left
		lease.HandoverTo = e.HandoverTo
		lease.HandoverToHuman = e.HandoverToHuman
		lease.HandoverToPriority = e.HandoverToPriority
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
		// Mirror the exact same guard on the shadow: an unattributed
		// erase must not silently believe a lease is gone either.
		c.believedMu.Lock()
		if l, ok := c.believed[key]; ok && l.Agent == e.Agent {
			delete(c.believed, key)
		}
		c.believedMu.Unlock()
		if e.State == "handover" && e.Agent == c.cfg.Agent {
			// It was ours. Remember who has it now — this is the only
			// frame that ever explains why a region stopped being this
			// agent's, and the agent itself is not reading the socket;
			// its hook is, on its next edit.
			c.leases.NoteHandover(e.Region.Path, leases.HandoverNote{
				To: e.To, ToHuman: e.ToHuman, ToPriority: e.ToPriority, AtMs: nowMs(),
			})
		}
		return
	}

	k, lease, ok := c.toLease(e)
	if !ok {
		return
	}
	c.leases.Upsert(k, lease, nowMs())
	c.believedMu.Lock()
	c.believed[k] = lease
	c.believedMu.Unlock()
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
	c.leases.Upsert(k, lease, nowMs())
	c.believedMu.Lock()
	c.believed[k] = lease
	c.believedMu.Unlock()
}

// recordDivergence sets ap_lease_cache_divergence to the number of leases
// this daemon still believed in, at the moment a fresh snapshot arrived,
// that the snapshot does not list — the reconcile point named in the
// gauge's help text. Only unexpired entries count: after a long outage
// every held lease has aged past its own ExpiresAtMs, the relay's snapshot
// legitimately drops them the same way, and Conflict already skips them on
// expiry even before a prune sweep removes them (see leases.Cache.Conflict's
// stale-but-harmless check) — counting those would fire the gauge loudest
// exactly when nothing is blocking on anything.
func (c *Client) recordDivergence(fresh map[string]leases.Lease) {
	if c.metrics == nil {
		return
	}
	now := nowMs()
	c.believedMu.Lock()
	defer c.believedMu.Unlock()
	var diverged float64
	for key, l := range c.believed {
		if l.ExpiresAtMs <= now {
			continue
		}
		if _, ok := fresh[key]; !ok {
			diverged++
		}
	}
	c.metrics.LeaseCacheDiverge.Set(diverged)
}

// nowMs is wall time, not monotonic. Known deviation from the C++ side: see
// docs/go-daemon.md's clock-source note.
func nowMs() int64 {
	return time.Now().UnixMilli()
}
