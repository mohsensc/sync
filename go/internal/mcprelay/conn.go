// Package mcprelay is the MCP tool surface's own connection to the relay —
// the Go mirror of python/src/agent_presence/relay_client.py's
// RelayConnection. It is not go/internal/relay: that package is the
// daemon's fire-and-forget pump, callbacks and a background reconnect loop,
// because a daemon has no caller waiting on a reply. This one is
// request/response — claim_work and respond need the specific answer to
// the specific frame they just sent — so it holds one connection open and
// serializes calls on it the same way RelayConnection's asyncio.Lock does,
// just with a sync.Mutex instead of an event loop.
//
// Every failure here becomes an *Unavailable, never a hang: an MCP server
// is long-lived, sitting idle between tool calls for as long as the
// session runs, and a tool call that blocks forever on a relay that will
// never answer is worse than one that errors — see relay_client.py's
// RelayUnavailable doc comment, ported verbatim.
package mcprelay

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/prometheus/client_golang/prometheus"

	"github.com/mohsensc/sync/go/internal/metrics"
	"github.com/mohsensc/sync/go/internal/wire"
)

// PresenceTTL mirrors leases.PRESENCE_TTL_S — the same cutoff the relay
// itself applies to its own presence table, so a joiner never appears to
// know about an agent that a subscriber who'd been there the whole time
// would already have aged out.
const PresenceTTL = 30 * time.Second

const (
	defaultConnectTimeout = 5 * time.Second
	defaultRequestTimeout = 5 * time.Second
)

// Unavailable is every way this package can fail: connect refused, join
// refused, a request that timed out. Never a raw *websocket.Conn error or
// an OS error past the caller's boundary — see the package doc.
type Unavailable struct{ msg string }

func (e *Unavailable) Error() string { return e.msg }

func unavailable(format string, args ...any) *Unavailable {
	return &Unavailable{fmt.Sprintf(format, args...)}
}

// Config is one MCP session's identity and its dial target — the ctor
// arguments RelayConnection.__init__ takes.
type Config struct {
	URL   string
	Room  string
	Agent string
	Human string

	Principal  string
	Token      string
	Unattended bool

	ConnectTimeout time.Duration
	RequestTimeout time.Duration

	// Metrics is where this session's connection state, reconnects and
	// claim roundtrip go. Required: this package has the same "no
	// endpoint, push over the connection already held" problem the
	// daemon does, and it reports through the one registry the process
	// holds rather than growing its own. The transport that drains this
	// registry over the wire is not this package's job — see
	// internal/metrics's package comment.
	Metrics *metrics.Registry
}

func (c Config) withDefaults() Config {
	if c.ConnectTimeout == 0 {
		c.ConnectTimeout = defaultConnectTimeout
	}
	if c.RequestTimeout == 0 {
		c.RequestTimeout = defaultRequestTimeout
	}
	return c
}

// Peer is one entry of who_else_is_here's answer — the shape
// RelayConnection.presence() already builds, ready to become the tool
// reply as-is. Symbol is nil for a whole-file touch, the same as the
// wire's region.symbol.
type Peer struct {
	Human  string
	Agent  string
	Verb   string
	Path   string
	Symbol *string
}

// presenceEntry is one row of the local cache, fed by the join snapshot's
// presence array (#31) and every live "presence" frame since.
type presenceEntry struct {
	seenAt            time.Time
	seq               int64
	human, verb, path string
	symbol            string
	hasSymbol         bool
}

// Conn is one MCP session's link to the relay. Safe for concurrent use,
// though nothing in this codebase calls it concurrently: one MCP session
// serves one tool call at a time.
//
// Connects lazily — nothing dials out until the first call — and any
// failure tears the connection down, so the next call starts clean instead
// of reusing a socket that may be half-dead. That is what makes a relay
// restart mid-session survivable: the next tool call after one just
// reconnects.
type Conn struct {
	cfg Config

	// Guards connectLocked and one request/reply round trip at a time —
	// the same job RelayConnection's asyncio.Lock does. Tool calls on one
	// MCP session are effectively sequential (stdio delivers one at a
	// time), but the mutex makes that a guarantee instead of an
	// assumption.
	mu            sync.Mutex
	ws            *websocket.Conn
	replies       chan map[string]any
	everConnected bool // guards Reconnects: the first join is not a "re"-connect

	presenceMu  sync.Mutex
	presence    map[string]presenceEntry
	presenceSeq int64
}

// New builds a Conn. It does not dial out — see Conn's doc comment.
func New(cfg Config) *Conn {
	return &Conn{cfg: cfg.withDefaults(), presence: make(map[string]presenceEntry)}
}

// Close tears down the connection, if one is open. Safe to call more than
// once.
func (c *Conn) Close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.teardownLocked()
}

func (c *Conn) teardownLocked() {
	if c.ws != nil {
		c.ws.Close()
		c.ws = nil
		c.cfg.Metrics.DaemonConnected.Set(0)
	}
	// The old reply channel is simply abandoned, not closed: a reader
	// goroutine still draining the connection that just died writes into
	// it with a non-blocking send (see readLoop) and nothing ever reads it
	// again. Closing it here would race that goroutine's send against this
	// close and panic.
	c.replies = nil
}

// connectLocked connects and joins if not already connected. Caller holds
// mu.
func (c *Conn) connectLocked(ctx context.Context) error {
	if c.ws != nil {
		return nil
	}

	dialCtx, cancel := context.WithTimeout(ctx, c.cfg.ConnectTimeout)
	defer cancel()
	ws, resp, err := websocket.DefaultDialer.DialContext(dialCtx, c.cfg.URL, nil)
	if err != nil {
		if resp != nil {
			resp.Body.Close()
		}
		return unavailable("could not reach the relay at %s: %v", c.cfg.URL, err)
	}

	if err := c.sendJoin(ws); err != nil {
		ws.Close()
		return unavailable("relay at %s did not answer the join: %v", c.cfg.URL, err)
	}

	ws.SetReadDeadline(time.Now().Add(c.cfg.ConnectTimeout))
	reply, err := c.readJoinReply(ws)
	if err != nil {
		ws.Close()
		return unavailable("relay at %s did not answer the join: %v", c.cfg.URL, err)
	}
	ws.SetReadDeadline(time.Time{})

	if t, _ := reply["type"].(string); t == "join_refused" {
		ws.Close()
		return unavailable("relay refused the join (%v): %v", reply["reason"], reply["detail"])
	}

	// The join snapshot's presence array (#31), if the relay carries one —
	// folded into the same cache a live "presence" frame lands in, so
	// who_else_is_here sees activity from before this connection joined.
	c.applyPresenceSnapshot(reply)

	c.ws = ws
	replies := make(chan map[string]any, 1)
	c.replies = replies
	go c.readLoop(ws, replies)

	// DaemonConnected is shared with the daemon's own use of it: 1 for as
	// long as this session holds a live relay connection. Reconnects only
	// fires the second time and later — the session's first join isn't a
	// re-establishment of anything.
	c.cfg.Metrics.DaemonConnected.Set(1)
	if c.everConnected {
		c.cfg.Metrics.Reconnects.Inc()
	}
	c.everConnected = true
	return nil
}

func (c *Conn) sendJoin(ws *websocket.Conn) error {
	j := wire.Join{
		Type: "join", Room: c.cfg.Room, Agent: c.cfg.Agent, Human: c.cfg.Human,
		Unattended: c.cfg.Unattended,
	}
	if c.cfg.Principal != "" {
		j.Principal = c.cfg.Principal
	}
	if c.cfg.Token != "" {
		j.Token = c.cfg.Token
	}
	if err := ws.SetWriteDeadline(time.Now().Add(c.cfg.ConnectTimeout)); err != nil {
		return err
	}
	return ws.WriteJSON(j)
}

// readJoinReply reads frames until one of the two the join provokes — a
// lease snapshot or a refusal. A relay with an org policy file queues a
// "policy" frame right behind the join reply, so the first frame off the
// wire is not guaranteed to be the one wanted — same loop as
// RelayConnection._join.
func (c *Conn) readJoinReply(ws *websocket.Conn) (map[string]any, error) {
	for {
		_, data, err := ws.ReadMessage()
		if err != nil {
			return nil, err
		}
		var msg map[string]any
		if err := json.Unmarshal(data, &msg); err != nil {
			continue
		}
		if t, _ := msg["type"].(string); t == "leases" || t == "join_refused" {
			return msg, nil
		}
	}
}

// readLoop is the connection's one reader, live for as long as ws is.
// Fan-out frames (leases/presence) update the local cache directly;
// request replies (claim_result/move_result) go to whoever is waiting in
// request. Everything else — lease, policy, ack, negotiate,
// redundant_work, join_refused — nothing on this connection asks for
// today, same as relay_client.py's read_loop.
func (c *Conn) readLoop(ws *websocket.Conn, replies chan map[string]any) {
	for {
		_, data, err := ws.ReadMessage()
		if err != nil {
			return
		}
		var msg map[string]any
		if err := json.Unmarshal(data, &msg); err != nil {
			continue
		}
		switch t, _ := msg["type"].(string); t {
		case "leases":
			// A full snapshot, sent again after a relay restart as well as
			// on join. Its presence array is folded the same way either
			// time — see applyPresenceSnapshot.
			c.applyPresenceSnapshot(msg)
		case "presence":
			agent, _ := msg["agent"].(string)
			c.upsertPresence(agent, msg, time.Now())
		case "claim_result", "move_result":
			select {
			case replies <- msg:
			default:
				// Only one request is ever in flight per connection — mu
				// guarantees that — so this never actually has anywhere to
				// go stale, but a reply nobody is waiting for must never
				// block the reader.
			}
		}
	}
}

// request sends a frame and waits for the one reply it provokes, tearing
// the connection down on any failure so the next call starts clean.
//
// roundtrip, when not nil, is observed once — only on the branch where a
// reply actually arrived. The clock starts after connectLocked returns,
// not around the whole call: a lazy first dial+join is setup, not part of
// "time from sending a claim to the relay's verdict", and a request that
// timed out or was cancelled never got a verdict to time.
func (c *Conn) request(ctx context.Context, payload any, roundtrip prometheus.Histogram) (map[string]any, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if err := c.connectLocked(ctx); err != nil {
		return nil, err
	}
	start := time.Now()

	if err := c.ws.SetWriteDeadline(time.Now().Add(c.cfg.RequestTimeout)); err != nil {
		c.teardownLocked()
		return nil, unavailable("relay at %s did not answer: %v", c.cfg.URL, err)
	}
	if err := c.ws.WriteJSON(payload); err != nil {
		c.teardownLocked()
		return nil, unavailable("relay at %s did not answer: %v", c.cfg.URL, err)
	}

	timer := time.NewTimer(c.cfg.RequestTimeout)
	defer timer.Stop()
	select {
	case reply := <-c.replies:
		if roundtrip != nil {
			roundtrip.Observe(time.Since(start).Seconds())
		}
		return reply, nil
	case <-timer.C:
		c.teardownLocked()
		return nil, unavailable("relay at %s did not answer: request timed out", c.cfg.URL)
	case <-ctx.Done():
		c.teardownLocked()
		return nil, unavailable("relay at %s did not answer: %v", c.cfg.URL, ctx.Err())
	}
}

// Claim sends a "claim" frame and returns the "claim_result" reply, raw —
// the caller (mcptools.Tools) reshapes it into the tool's answer.
func (c *Conn) Claim(ctx context.Context, region wire.Region, intent string) (map[string]any, error) {
	return c.request(ctx, wire.Claim{Type: "claim", Region: region, Intent: intent}, c.cfg.Metrics.ClaimRoundtrip)
}

// Move sends a "move" frame — a negotiation move — and returns the
// "move_result" reply, raw. Not what ClaimRoundtrip measures — that
// histogram's help text is specifically about a claim's verdict — so this
// passes no histogram to observe.
func (c *Conn) Move(ctx context.Context, region wire.Region, move, reason string) (map[string]any, error) {
	return c.request(ctx, wire.MoveRequest{Type: "move", Region: region, Move: move, Reason: reason}, nil)
}

// Release sends a "release" frame. No reply travels for one — the room
// hears about it, not the releaser — so this only has to land the send.
func (c *Conn) Release(ctx context.Context, region wire.Region) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if err := c.connectLocked(ctx); err != nil {
		return err
	}
	if err := c.ws.SetWriteDeadline(time.Now().Add(c.cfg.RequestTimeout)); err != nil {
		c.teardownLocked()
		return unavailable("relay at %s dropped the release: %v", c.cfg.URL, err)
	}
	if err := c.ws.WriteJSON(wire.ReleaseRequest{Type: "release", Region: region}); err != nil {
		c.teardownLocked()
		return unavailable("relay at %s dropped the release: %v", c.cfg.URL, err)
	}
	return nil
}

// Presence answers who_else_is_here: peers seen on this connection since
// it joined (including, since #31, whoever the join snapshot already knew
// about), minus exclude and anything older than PresenceTTL — the same
// cutoff the relay applies server-side to its own table.
func (c *Conn) Presence(ctx context.Context, exclude string) ([]Peer, error) {
	c.mu.Lock()
	err := c.connectLocked(ctx)
	c.mu.Unlock()
	if err != nil {
		return nil, err
	}

	cutoff := time.Now().Add(-PresenceTTL)
	c.presenceMu.Lock()
	defer c.presenceMu.Unlock()

	type ordered struct {
		presenceEntry
		agent string
	}
	all := make([]ordered, 0, len(c.presence))
	for agent, e := range c.presence {
		if agent == exclude || e.seenAt.Before(cutoff) {
			continue
		}
		all = append(all, ordered{e, agent})
	}
	// Map iteration order is random in Go; first-seen order is not, and
	// matches the insertion-order dict relay_client.py's cache is.
	sort.Slice(all, func(i, j int) bool { return all[i].seq < all[j].seq })

	out := make([]Peer, len(all))
	for i, e := range all {
		p := Peer{Human: e.human, Agent: e.agent, Verb: e.verb, Path: e.path}
		if e.hasSymbol {
			s := e.symbol
			p.Symbol = &s
		}
		out[i] = p
	}
	return out, nil
}

// applyPresenceSnapshot folds a "leases" frame's presence array into the
// cache — relay_client.py's _apply_presence_snapshot, run on both the join
// reply and any later full-table resend.
func (c *Conn) applyPresenceSnapshot(msg map[string]any) {
	arr, _ := msg["presence"].([]any)
	if len(arr) == 0 {
		return
	}
	now := time.Now()
	for _, item := range arr {
		entry, ok := item.(map[string]any)
		if !ok {
			continue
		}
		agent, _ := entry["agent"].(string)
		c.upsertPresence(agent, entry, now)
	}
}

// upsertPresence records one agent's latest touch, stamped with this
// connection's own clock at arrival — same as relay_client.py does for
// both the snapshot and a live frame: the relay's own "ts" is on its
// clock, not this process's.
func (c *Conn) upsertPresence(agent string, entry map[string]any, now time.Time) {
	if agent == "" {
		return
	}
	human, _ := entry["human"].(string)
	verb, _ := entry["verb"].(string)
	path, symbol, hasSymbol := regionOf(entry)

	c.presenceMu.Lock()
	defer c.presenceMu.Unlock()
	seq, existed := c.presenceSeq, false
	if prev, ok := c.presence[agent]; ok {
		seq, existed = prev.seq, true
	}
	if !existed {
		c.presenceSeq++
	}
	c.presence[agent] = presenceEntry{
		seenAt: now, seq: seq,
		human: human, verb: verb, path: path, symbol: symbol, hasSymbol: hasSymbol,
	}
}

func regionOf(entry map[string]any) (path, symbol string, hasSymbol bool) {
	r, _ := entry["region"].(map[string]any)
	if r == nil {
		return "", "", false
	}
	path, _ = r["path"].(string)
	if sv, ok := r["symbol"].(string); ok {
		return path, sv, true
	}
	return path, "", false
}
