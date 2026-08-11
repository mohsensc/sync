// SPIKE: relay rewrite prototype. See docs/relay-spike.md for what this is,
// what it deliberately does not implement, and the numbers.
//
// Idiomatic Go on the hot path the brief asked for: a goroutine per
// connection, a bounded outbound channel per connection (drop-oldest when
// full, matching serve.py's SEND_QUEUE_MAX / drop-oldest policy), and
// incremental per-member fanout -- each broadcast marshals its frame once
// and every member's writer goroutine sends the same []byte, no whole-table
// diff and no per-recipient re-encode. That per-recipient re-encode (JSON +
// permessage-deflate, once per room member per lease change) is what
// profiling the Python relay found as the dominant real cost -- see
// docs/relay-spike.md's profiler section -- so it is the one thing this
// prototype is built to not do twice.
package main

import (
	"encoding/json"
	"flag"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	outboundCap = 512 // mirrors serve.py's SEND_QUEUE_MAX
	leaseTTL    = 90 * time.Second
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin:     func(r *http.Request) bool { return true },
}

// conn is one websocket connection: one goroutine reading it, one goroutine
// draining its outbound channel. Never touched from any other goroutine.
type conn struct {
	ws    *websocket.Conn
	out   chan []byte
	agent string
	human string
	room  string
	// closed guards double-close of `out` when the read and write loops
	// both notice the peer is gone at nearly the same time.
	closeOnce sync.Once
	done      chan struct{}
}

func newConn(ws *websocket.Conn) *conn {
	return &conn{ws: ws, out: make(chan []byte, outboundCap), done: make(chan struct{})}
}

// send queues a frame, dropping the oldest queued one if the channel is
// full rather than blocking the caller -- the caller is always the room's
// registry goroutine mid-broadcast, and one slow reader must never stall
// fan-out to the rest of the room.
func (c *conn) send(msg []byte) {
	select {
	case c.out <- msg:
	default:
		select {
		case <-c.out:
		default:
		}
		select {
		case c.out <- msg:
		default:
		}
	}
}

func (c *conn) closeDone() {
	c.closeOnce.Do(func() { close(c.done) })
}

type claim struct {
	agent     string
	human     string
	intent    string
	expiresAt time.Time
}

// room holds one room's membership and lease table. One mutex, because the
// hot operations (claim/release/broadcast) are all "touch a small map, then
// write to a handful of channels" -- nothing here does I/O under the lock.
type room struct {
	mu      sync.Mutex
	members map[*conn]struct{}
	claims  map[string]*claim // regionKey -> claim
}

type registry struct {
	mu    sync.Mutex
	rooms map[string]*room
}

func newRegistry() *registry {
	return &registry{rooms: make(map[string]*room)}
}

func (r *registry) roomFor(name string) *room {
	r.mu.Lock()
	defer r.mu.Unlock()
	rm, ok := r.rooms[name]
	if !ok {
		rm = &room{members: make(map[*conn]struct{}), claims: make(map[string]*claim)}
		r.rooms[name] = rm
	}
	return rm
}

func (rm *room) join(c *conn) {
	rm.mu.Lock()
	defer rm.mu.Unlock()
	rm.members[c] = struct{}{}
}

// leave drops the connection and releases whatever it held, same as
// relay.py's Relay.leave -> registry.release_all -- a dead connection must
// not hold protection.
func (rm *room) leave(c *conn) {
	rm.mu.Lock()
	agent := c.agent
	delete(rm.members, c)
	var freedKeys []string
	for key, cl := range rm.claims {
		if cl.agent == agent {
			freedKeys = append(freedKeys, key)
			delete(rm.claims, key)
		}
	}
	rm.mu.Unlock()

	for _, key := range freedKeys {
		rm.broadcast(leaseGoneFrame{Type: "lease", State: "released", Agent: agent, Region: regionFromKey(key)}, nil)
	}
}

// broadcast marshals once and fans out the same bytes to every member.
// This is the whole point of the prototype: one json.Marshal, N channel
// sends, versus the stock Python relay's N independent json.dumps +
// permessage-deflate calls for the same event (see docs/relay-spike.md).
func (rm *room) broadcast(frame any, exclude *conn) {
	msg := marshal(frame)
	rm.mu.Lock()
	targets := make([]*conn, 0, len(rm.members))
	for c := range rm.members {
		if c != exclude {
			targets = append(targets, c)
		}
	}
	rm.mu.Unlock()
	for _, c := range targets {
		c.send(msg)
	}
}

func (rm *room) snapshot() []leaseEntry {
	rm.mu.Lock()
	defer rm.mu.Unlock()
	now := time.Now()
	out := make([]leaseEntry, 0, len(rm.claims))
	for key, cl := range rm.claims {
		if cl.expiresAt.Before(now) {
			delete(rm.claims, key)
			continue
		}
		out = append(out, entryFor(key, cl, now))
	}
	return out
}

func entryFor(key string, cl *claim, now time.Time) leaseEntry {
	r := regionFromKey(key)
	return leaseEntry{
		Agent: cl.agent, Human: cl.human, Intent: cl.intent,
		Priority: "normal", Region: r,
		ExpiresInMs: cl.expiresAt.Sub(now).Milliseconds(),
	}
}

func regionFromKey(key string) region {
	for i := 0; i < len(key); i++ {
		if key[i] == 0 {
			path := key[:i]
			sym := key[i+1:]
			if sym == "" {
				return region{Path: path}
			}
			return region{Path: path, Symbol: &sym}
		}
	}
	return region{Path: key}
}

// tryClaim mirrors LeaseRegistry.acquire's shape (grant / renew / refuse),
// not its content: no wait-die, no tiers, no handover. Good enough for the
// fan-out cost this spike is measuring -- see docs/relay-spike.md.
func (rm *room) tryClaim(key string, agent, human, intent string, now time.Time) (granted bool, heldBy string, entry leaseEntry) {
	rm.mu.Lock()
	defer rm.mu.Unlock()
	if existing, ok := rm.claims[key]; ok && existing.expiresAt.After(now) {
		if existing.agent != agent {
			return false, existing.agent, leaseEntry{}
		}
		existing.expiresAt = now.Add(leaseTTL)
		existing.intent = intent
		return true, "", entryFor(key, existing, now)
	}
	cl := &claim{agent: agent, human: human, intent: intent, expiresAt: now.Add(leaseTTL)}
	rm.claims[key] = cl
	return true, "", entryFor(key, cl, now)
}

func (rm *room) release(key, agent string) bool {
	rm.mu.Lock()
	defer rm.mu.Unlock()
	cl, ok := rm.claims[key]
	if !ok || cl.agent != agent {
		return false
	}
	delete(rm.claims, key)
	return true
}

func (rm *room) heartbeat(key, agent string, now time.Time) (bool, leaseEntry) {
	rm.mu.Lock()
	defer rm.mu.Unlock()
	cl, ok := rm.claims[key]
	if !ok || cl.agent != agent {
		return false, leaseEntry{}
	}
	cl.expiresAt = now.Add(leaseTTL)
	return true, entryFor(key, cl, now)
}

func handleConn(reg *registry, ws *websocket.Conn) {
	c := newConn(ws)
	defer func() {
		c.closeDone()
		ws.Close()
	}()

	go writeLoop(c)

	var rm *room
	for {
		_, data, err := ws.ReadMessage()
		if err != nil {
			break
		}
		var env envelope
		if json.Unmarshal(data, &env) != nil {
			continue
		}
		switch env.Type {
		case "join":
			var j joinFrame
			if json.Unmarshal(data, &j) != nil {
				continue
			}
			c.agent, c.human, c.room = j.Agent, j.Human, j.Room
			rm = reg.roomFor(j.Room)
			rm.join(c)
			c.send(marshal(leasesSnapshot{Type: "leases", Leases: rm.snapshot()}))
		case "claim":
			if rm == nil {
				continue
			}
			var cf claimFrame
			if json.Unmarshal(data, &cf) != nil {
				continue
			}
			key := regionKey(cf.Region)
			now := time.Now()
			granted, heldBy, entry := rm.tryClaim(key, c.agent, c.human, cf.Intent, now)
			c.send(marshal(claimResult{Type: "claim_result", Granted: granted, HeldBy: heldBy, Region: cf.Region}))
			if granted {
				rm.broadcast(leaseHeldFrame{Type: "lease", State: "held", leaseEntry: entry}, c)
			}
		case "release":
			if rm == nil {
				continue
			}
			var rf releaseFrame
			if json.Unmarshal(data, &rf) != nil {
				continue
			}
			key := regionKey(rf.Region)
			if rm.release(key, c.agent) {
				rm.broadcast(leaseGoneFrame{Type: "lease", State: "released", Agent: c.agent, Region: rf.Region}, c)
			}
		case "heartbeat":
			if rm == nil {
				continue
			}
			var hf heartbeatFrame
			if json.Unmarshal(data, &hf) != nil {
				continue
			}
			key := regionKey(hf.Region)
			now := time.Now()
			ok, entry := rm.heartbeat(key, c.agent, now)
			if ok {
				rm.broadcast(leaseHeldFrame{Type: "lease", State: "held", leaseEntry: entry}, c)
			}
		}
	}

	if rm != nil {
		rm.leave(c)
	}
}

func writeLoop(c *conn) {
	for {
		select {
		case msg := <-c.out:
			c.ws.SetWriteDeadline(time.Now().Add(15 * time.Second))
			if err := c.ws.WriteMessage(websocket.TextMessage, msg); err != nil {
				return
			}
		case <-c.done:
			return
		}
	}
}

func main() {
	addr := flag.String("addr", "127.0.0.1:8799", "listen address")
	flag.Parse()

	reg := newRegistry()
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		go handleConn(reg, ws)
	})
	log.Printf("go relay prototype listening on %s", *addr)
	if err := http.ListenAndServe(*addr, nil); err != nil {
		log.Fatal(err)
	}
}
