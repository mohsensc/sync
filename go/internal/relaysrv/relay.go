package relaysrv

import (
	"log"
	"math"
	"path/filepath"
	"strings"
	"sync"

	"github.com/mohsensc/sync/go/internal/metrics"
)

// Conn is one connection to the relay: a websocket in the running server,
// or a fake in a test. Mirrors relay.py's Conn protocol. Send must never
// block and never panic — the transport owns backpressure, the relay just
// hands it bytes.
//
// Send takes pre-encoded bytes, not a Frame: the relay calls EncodeFrame
// exactly once per distinct payload (see Broadcast/PublishTo/reply below)
// and hands every recipient the same []byte, rather than each
// connection's own writer re-marshaling (and, under opaque mode,
// re-hashing) an identical frame. See EncodeFrame's doc comment.
type Conn interface {
	Agent() string
	SetAgent(string)
	Human() string
	SetHuman(string)
	Room() string
	SetRoom(string)
	Principal() string
	Token() string
	Unattended() bool
	Send([]byte)
	// Evict takes this connection's transport down, and nothing else. See
	// bindAgent's eviction loop and WsConn.Evict for why the relay-owned
	// state is deliberately left for the connection's own goroutine.
	Evict(reason string)
}

// Refusal is why a join was refused, in a shape the client can act on.
// Mirrors relay.py's Refusal.
type Refusal struct {
	Reason string
	Detail string
}

func (r Refusal) frame(room string) Frame {
	return Frame{"type": "join_refused", "room": room, "reason": r.Reason, "detail": r.Detail}
}

type identityRecord struct {
	agent, human string
}

type principalRecord struct {
	principal  string
	unattended bool
	grant      Grant
}

type timedActivity struct {
	t float64
	a Activity
}

// roomInfo is everything the relay tracks about a room besides the lease
// table (which lives sharded in Registry): membership and the presence
// buffer. Guarded by its own mutex, separate from the region shards, so
// join/leave and fan-out never contend with claim traffic in the same
// room.
//
// activity entries carry whichever agent/human onEvent resolved for them
// (the event's own, or the connection's as a fallback — see onEvent), not
// the owning connection, and one connection can produce several. That is
// fine unmodified: every entry ages out purely on elapsed time (presence()/
// presenceSnapshot()'s PresenceTTLS cutoff), with nothing keyed to whether
// the connection that wrote it is still open — a session that stops
// relaying just stops appearing, the same way a hook that stops firing
// always has.
type roomInfo struct {
	mu        sync.Mutex
	members   []Conn
	activity  []timedActivity
	lastTs    float64
	hasLastTs bool
}

// Relay is sole authority on leases and the only place protocol decisions
// are made. Mirrors relay.py's Relay class. Stateless across restarts by
// design: leases expire, so a relay restart degrades to "nobody has
// protection for 90 seconds", never to a wedged team.
type Relay struct {
	clock      Clock
	registry   *Registry
	negotiator *Negotiator
	roster     Roster
	metrics    *metrics.Registry

	roomsMu sync.RWMutex
	rooms   map[string]*roomInfo

	identityMu sync.Mutex
	identity   map[Conn]identityRecord
	principal  map[Conn]principalRecord
	// daemons is which live connections have identified themselves as a
	// stats reporter (see onStats) — the relay side of DaemonsConnected.
	// Keyed by Conn, guarded by identityMu alongside identity/principal:
	// same lifetime, same "one map entry per live connection" shape, no
	// reason for a lock of its own.
	daemons map[Conn]bool

	// statsMu/statsSeen is the last cumulative counters each live
	// connection reported in a "stats" frame (stats.go) — process-local
	// bookkeeping to fold a delta out of a cumulative report without a
	// per-connection label on any metric (see stats.go's package doc).
	// Its own lock: touched on every stats frame, which would otherwise
	// contend with identityMu's join/leave traffic for no reason.
	statsMu   sync.Mutex
	statsSeen map[Conn]daemonBaseline

	// Builtin plus org floor, and nothing else — see policy.go's package
	// doc comment. policyMu guards policyDigest, which is read and
	// written from Join/Handle on any goroutine; policy itself
	// (*PolicyFile) is already safe for concurrent use on its own.
	policy       *PolicyFile
	policyMu     sync.Mutex
	policyDigest string
}

func NewRelay(clock Clock, roster Roster, m *metrics.Registry) *Relay {
	r := &Relay{
		clock:     clock,
		roster:    roster,
		metrics:   m,
		rooms:     make(map[string]*roomInfo),
		identity:  make(map[Conn]identityRecord),
		principal: make(map[Conn]principalRecord),
		daemons:   make(map[Conn]bool),
		policy:    NewPolicyFileForRelay(clock, m),
	}
	r.registry = NewRegistry(clock, r, m)
	r.registry.SetDeadlineGate(r.armsDeadline)
	r.negotiator = NewNegotiator(r.registry)
	r.policyDigest = r.policy.Current().Digest
	if roster.Present() {
		log.Printf("roster %s: %d principal(s), default %s", roster.Source(), roster.PrincipalCount(), PriorityName(roster.DefaultTier()))
	} else {
		log.Printf("no principals roster (%s); every connection joins at %s", roster.Source(), PriorityName(PriorityNormal))
	}
	return r
}

// policyFrame is the org floor, as policy currently reads it. Only the
// floor travels — effects are the client's business, the relay cannot see
// a client's repo/user/session layers — but a floor composes with
// whatever the client resolved locally by taking the louder of the two.
// The bool return is whether an org file is actually configured: false
// means the frame carries the compiled-in builtin floor rather than
// nothing, because a relay always has *a* floor to state even when nobody
// wrote one down. That matters at the one seam this used to get wrong —
// see publishPolicyChange: an org file that gets deleted while daemons are
// joined has to relax them back to builtin, and there is no frame to do
// that with if this returns nothing just because org is now absent. It is
// the *caller's* job to decide whether "nothing configured" is worth a
// frame at all — see Join, which stays silent on it, matching
// test_golden_noop.py-equivalent coverage (golden_test.go /
// TestARelayWithNoOrgPolicySendsNoPolicyFrame) that locks down that a
// never-configured relay puts nothing extra on the wire. Mirrors relay.py's
// _policy_frame, extended for the transition case above.
func (r *Relay) policyFrame(policy Policy) (Frame, bool) {
	org := policy.layer(layerOrg)
	source := "builtin"
	if org != nil {
		source = "org:" + org.source
	}
	frame := Frame{
		"type":   "policy",
		"floor":  policy.floorTable("").names(),
		"source": source,
		"digest": policy.Digest,
	}
	if floors := policy.floorRules(); len(floors) > 0 {
		out := make([]any, len(floors))
		for i, f := range floors {
			out[i] = Frame{"match": f.Match, "effects": f.Effects, "layer": f.Layer}
		}
		frame["floors"] = out
	}
	return frame, org != nil
}

// publishPolicyChange pushes a new floor to every room whenever the
// resolved policy actually moved, org file present or not — including the
// transition where it just disappeared, which is the one this exists to
// catch (issue #2 of the system-seams audit): policyFrame used to return
// nil in that case, so this latched the new (relaxed) digest and then had
// nothing to broadcast, and every daemon that had already latched the old,
// stricter floor stayed on it forever with no error anywhere. One
// r.policy.Current() call, reused for both the digest that gets latched
// and the frame that gets built from it, so the two can never read two
// different stats a second apart and disagree about what "current" meant.
// PolicyFile.Current gates its own stat to once a second, so this costs a
// comparison per frame in the steady state. Mirrors relay.py's
// _publish_policy_change.
func (r *Relay) publishPolicyChange() bool {
	policy := r.policy.Current()
	r.policyMu.Lock()
	changed := policy.Digest != r.policyDigest
	if changed {
		r.policyDigest = policy.Digest
	}
	r.policyMu.Unlock()
	if !changed {
		return false
	}
	frame, _ := r.policyFrame(policy)
	log.Printf("org policy changed (%s); republishing the floor", shortDigest(policy.Digest))
	r.roomsMu.RLock()
	rooms := make([]string, 0, len(r.rooms))
	for name := range r.rooms {
		rooms = append(rooms, name)
	}
	r.roomsMu.RUnlock()
	for _, room := range rooms {
		r.Broadcast(room, frame, nil)
	}
	return true
}

func shortDigest(d string) string {
	if len(d) > 12 {
		return d[:12]
	}
	return d
}

// resolvePolicy mirrors relay.py's Relay.resolve_policy.
func (r *Relay) resolvePolicy(conn Conn, rung int, path string) Resolution {
	return r.policy.Current().Resolve(rung, path, r.unattendedOf(conn))
}

func (r *Relay) Clock() Clock { return r.clock }

// recordRegionShape is the live regression detector for the bug where a
// region was named by its absolute filesystem path and two checkouts of
// one repo therefore never collided (see metrics.RegionKey's doc
// comment). Reads the region straight off the raw inbound value with
// cleanRegionRaw — not CleanRegionDict — because CleanRegionDict hashes
// the path when this relay's own opaque mode is on, and a hash never
// looks absolute: classifying shape after that hashing would silently
// report "relative" forever regardless of what a client actually sent.
// If the region arrived already marked opaque (a client hashed it before
// this relay ever saw it), shape means nothing either way, so that case
// is skipped rather than misclassified as relative.
func (r *Relay) recordRegionShape(raw any) {
	d, ok := raw.(map[string]any)
	if !ok || d[OpaqueMark] == true {
		return
	}
	region, ok := cleanRegionRaw(raw)
	if !ok {
		return
	}
	shape := metrics.ShapeRelative
	if filepath.IsAbs(region.Path) {
		shape = metrics.ShapeAbsolute
	}
	r.metrics.RegionKey(shape)
}

func (r *Relay) roomOf(name string) *roomInfo {
	r.roomsMu.RLock()
	ri, ok := r.rooms[name]
	r.roomsMu.RUnlock()
	if ok {
		return ri
	}
	r.roomsMu.Lock()
	defer r.roomsMu.Unlock()
	ri, ok = r.rooms[name]
	if ok {
		return ri
	}
	ri = &roomInfo{}
	r.rooms[name] = ri
	return ri
}

// joinRoom resolves room and adds conn to its membership in one critical
// section under roomsMu (issue #175). roomOf on its own releases roomsMu
// before returning the *roomInfo, so a plain "roomOf then ri.mu.Lock() and
// append" — what Join used to do — leaves a window between the two where
// leaveAllRooms can see a freshly created, still-empty room and delete it
// out from under the joiner about to become its first member: the same
// orphaning bug #100 already paid for, on the relay's own membership map
// this time. Doing the resolve-or-create and the append under one
// roomsMu.Lock() closes it, and is what makes leaveAllRooms's own re-check
// under roomsMu actually mean something — membership can now only change
// under roomsMu, here or there, never in between.
func (r *Relay) joinRoom(room string, conn Conn) (first bool) {
	r.roomsMu.Lock()
	defer r.roomsMu.Unlock()
	ri, ok := r.rooms[room]
	if !ok {
		ri = &roomInfo{}
		r.rooms[room] = ri
	}
	ri.mu.Lock()
	before := len(ri.members)
	ri.members = append(ri.members, conn)
	ri.mu.Unlock()
	return before == 0
}

// -- membership -----------------------------------------------------------

// Join puts a connection in a room. False means the join was refused, and
// the connection was already told which rule refused it. Mirrors
// relay.py's Relay.join field for field, including the identity- and
// grant-latching that closes priority laundering — see there for the full
// argument.
func (r *Relay) Join(room string, conn Conn) bool {
	if conn.Agent() == "" {
		return r.refuse(conn, room, Refusal{"no-agent-id", "the join frame carried no agent id; set one and join again"})
	}

	r.identityMu.Lock()
	declared := identityRecord{conn.Agent(), conn.Human()}
	latched, fresh := r.identity[conn]
	isFresh := !fresh
	if isFresh {
		r.identity[conn] = declared
	} else if declared != latched {
		conn.SetAgent(latched.agent)
		conn.SetHuman(latched.human)
		r.identityMu.Unlock()
		log.Printf("refused identity change on a live connection: %s -> %s", latched.agent, declared.agent)
		return r.refuse(conn, room, Refusal{"identity-latched",
			"this connection is " + latched.agent + " and stays " + latched.agent + "; open a second connection to join as somebody else"})
	}
	r.identityMu.Unlock()

	if refusal := r.latchGrant(conn, room); refusal != nil {
		if isFresh {
			r.identityMu.Lock()
			delete(r.identity, conn)
			r.identityMu.Unlock()
		}
		return r.refuse(conn, room, *refusal)
	}

	if refusal := r.bindAgent(conn); refusal != nil {
		if isFresh {
			r.identityMu.Lock()
			delete(r.principal, conn)
			delete(r.identity, conn)
			r.identityMu.Unlock()
		}
		return r.refuse(conn, room, *refusal)
	}

	// A room switch on a live connection is allowed (unlike an identity
	// change, refused above) but must not strand the old room's claims:
	// leaveAllRooms only drops membership, and Leave's own release only
	// ever runs for conn.Room() at session end, so the old room's claims
	// would otherwise sit there un-heartbeatable while the agent index
	// still (correctly, post-#173) shows the agent as live elsewhere.
	// ReleaseAll, not ReleaseAllSessionEnd: the identity isn't leaving,
	// just the room, so its wait-die age is preserved the same way an
	// abort preserves it, not reset like a voluntary release would.
	if oldRoom := conn.Room(); oldRoom != "" && oldRoom != room {
		r.registry.ReleaseAll(oldRoom, conn.Agent(), conn)
	}

	// One connection, one room membership.
	r.leaveAllRooms(conn)

	// Before the joiner is a member, so a change picked up here fans out
	// to the room that already exists and the joiner gets its own copy
	// below rather than two.
	r.publishPolicyChange()

	conn.SetRoom(room)
	if r.joinRoom(room, conn) {
		r.metrics.Rooms.Add(1)
	}

	r.sendLeaseSnapshot(conn, room)
	// Only when there is an org policy to state — see policyFrame's doc
	// comment on why a relay with nothing configured must stay silent.
	if frame, configured := r.policyFrame(r.policy.Current()); configured {
		conn.Send(EncodeFrame(frame))
	}
	return true
}

func removeConn(members []Conn, conn Conn) []Conn {
	out := members[:0]
	for _, m := range members {
		if m != conn {
			out = append(out, m)
		}
	}
	return out
}

// leaveAllRooms removes conn from whichever room currently holds it — at
// most one, by the one-connection-one-room invariant Join enforces — and
// decrements Rooms exactly when that removal leaves it with no members. A
// room emptied this way is also dropped from r.rooms outright (issue #175):
// unlike the registry side (see leases.go's SweepAll/reapRoomLocked), the
// relay has an authoritative, cheap membership count right here, so there
// is no reason to wait for a lazy sweep. Shared by Join's own membership
// cleanup and Leave, so the gauge transition and the delete are computed in
// exactly one place rather than at every call site that happens to mutate
// membership. Naturally idempotent: calling this again for a conn already
// removed from everywhere finds every room's length unchanged and deletes
// nothing, which matters because Leave itself can run twice for one
// connection (bindAgent's forced eviction, then the session's own defer on
// the same conn).
func (r *Relay) leaveAllRooms(conn Conn) {
	// Lock (not RLock) held for the whole walk: deleting from r.rooms
	// needs the write lock anyway, and taking it up front is what makes
	// "re-check len(ri.members)==0 while holding the lock" actually mean
	// something. That re-check is only trustworthy because joinRoom does
	// its resolve-or-create *and* its append to ri.members inside one
	// roomsMu.Lock() critical section too — membership can only ever
	// change under roomsMu, so nothing can hand a caller a membership slot
	// in a room this walk is deleting out from under it. (Before #175,
	// Join resolved via roomOf, which releases roomsMu, and appended
	// after — leaving exactly that window open; see joinRoom's doc
	// comment.) Blocking concurrent room *creation* and *lookup* for the
	// duration is the same trade leaveAllRooms already made; deletion
	// just needs it to cover lookups too.
	r.roomsMu.Lock()
	defer r.roomsMu.Unlock()
	for name, ri := range r.rooms {
		ri.mu.Lock()
		before := len(ri.members)
		ri.members = removeConn(ri.members, conn)
		after := len(ri.members)
		ri.mu.Unlock()
		if before > 0 && after == 0 {
			r.metrics.Rooms.Add(-1)
		}
		// Re-checking after==0 here, still holding roomsMu, is the whole
		// point: len(ri.members) can only change under roomsMu now (either
		// here or in roomOf's create path), so this read is never stale.
		if after == 0 {
			delete(r.rooms, name)
		}
	}
}

func (r *Relay) refuse(conn Conn, room string, refusal Refusal) bool {
	conn.Send(EncodeFrame(refusal.frame(room)))
	return false
}

// latchGrant authenticates once, remembers forever. Mirrors relay.py's
// _latch_grant.
func (r *Relay) latchGrant(conn Conn, room string) *Refusal {
	principal := strings.TrimSpace(conn.Principal())
	unattended := conn.Unattended()

	r.identityMu.Lock()
	latched, ok := r.principal[conn]
	if !ok {
		grant := r.roster.Authenticate(principal, conn.Token())
		r.principal[conn] = principalRecord{principal, unattended, grant}
		r.identityMu.Unlock()
		if grant.Authenticated() {
			log.Printf("principal %s joined room %s at %s", grant.Principal, room, grant.TierName(unattended))
		}
		return nil
	}
	r.identityMu.Unlock()

	if principal != latched.principal || unattended != latched.unattended {
		log.Printf("refused principal change on a live connection: %s -> %s", latched.principal, principal)
		return &Refusal{"principal-latched",
			"this connection authenticated as " + orNobody(latched.principal) + " and cannot re-rate itself; open a second connection"}
	}
	return nil
}

func orNobody(s string) string {
	if s == "" {
		return "nobody"
	}
	return s
}

// bindAgent is the check that closes priority laundering: one agent id,
// one grant, for as long as anybody holds it. Mirrors relay.py's
// _bind_agent.
func (r *Relay) bindAgent(conn Conn) *Refusal {
	agent := conn.Agent()
	grant := r.grantOf(conn)
	tier := r.priorityOf(conn)
	heldByPeer := false

	r.identityMu.Lock()
	others := make([]Conn, 0, len(r.identity))
	for other := range r.identity {
		if other != conn {
			others = append(others, other)
		}
	}
	r.identityMu.Unlock()

	var toEvict []Conn
	for _, other := range others {
		r.identityMu.Lock()
		mine, ok := r.identity[other]
		r.identityMu.Unlock()
		if !ok || mine.agent != agent {
			continue
		}
		theirs := r.grantOf(other)
		if theirs.Principal == grant.Principal && r.priorityOf(other) == tier {
			heldByPeer = true
			continue
		}
		if theirs.Authenticated() {
			log.Printf("refused join: agent id %s is principal %s's, at %s", agent, theirs.Principal, PriorityName(r.priorityOf(other)))
			return &Refusal{"agent-id-taken",
				"agent id " + agent + " is already in use on this relay by another principal; pick a different one (set AGENT_PRESENCE_AGENT) and join again"}
		}
		log.Printf("agent id %s reclaimed by principal %s; dropping the unauthenticated connection holding it", agent, grant.Principal)
		toEvict = append(toEvict, other)
	}
	// Take the transport down and let each evicted connection's own
	// goroutine run Leave, rather than calling Leave on it from here.
	//
	// Calling it from here was a real race. Join doesn't hold one lock for
	// its whole body: a connection switching rooms sits between
	// leaveAllRooms and SetRoom/joinRoom with nothing held, and an evicting
	// goroutine landing in that window deleted its identity and principal
	// records, reset its room to "", and cleared its wait-die age via
	// ReleaseAllSessionEnd — the very age the room switch calls plain
	// ReleaseAll to preserve. The target then finished its own Join and
	// carried on as a working member of the new room with no identity
	// record at all, which is exactly the state this function exists to
	// prevent: the next collision check for that agent id can't see it.
	//
	// A closed socket ends the session through the one door that already
	// runs on the right goroutine (server.go's `defer relay.Leave(conn)`),
	// so relay-owned state is still only ever touched by its own
	// connection. That leaves a short window where the evicted connection
	// is still a member of its old room, bounded by socket teardown. That
	// window is safe because every target here is unauthenticated —
	// Authenticate zeroes Principal on failure, so two connections sharing
	// an id with matching principal and tier are caught by heldByPeer
	// above, and an authenticated `other` is refused outright — so there
	// is nothing privileged left for it to do as this agent id.
	for _, other := range toEvict {
		other.Evict("agent id " + agent + " reclaimed by another principal")
	}

	if !heldByPeer {
		r.dropStrandedClaims(agent, tier)
	}
	return nil
}

func (r *Relay) dropStrandedClaims(agent string, tier int) {
	stranded := r.registry.PriorityOf(agent, tier)
	if stranded == tier {
		return
	}
	log.Printf("agent id %s changed hands at %s while claims taken at %s were still live; dropping them", agent, PriorityName(tier), PriorityName(stranded))
	r.registry.ReleaseEverywhere(agent, nil)
}

func (r *Relay) grantOf(conn Conn) Grant {
	r.identityMu.Lock()
	defer r.identityMu.Unlock()
	latched, ok := r.principal[conn]
	if !ok {
		return Grant{Attended: PriorityNormal, Unattended: PriorityNormal, Reason: ReasonNoRoster}
	}
	return latched.grant
}

// armsDeadline decides whether conn's ask may cap somebody else's lease.
// Issue #167: room membership and roster membership are different gates,
// and only the authenticated one gets to shorten a teammate's lease. An ask
// that doesn't arm is still recorded as a contender — see contendLocked.
//
// Two things this deliberately is not:
//
//   - It is not conn.Principal(). That's the name off the join frame, which
//     an unauthenticated peer sets to whatever it likes; only the latched
//     Grant (grantOf) knows whether a token backed it, which is the whole
//     point of latching one at join.
//   - It is not roster.Present(). A room with no roster at all is every
//     connection unauthenticated, so gating on presence would delete the
//     anti-starvation bound (policy-design.md §5.2) for the zero-config
//     case it exists to serve. Enforcing() is the narrower question — see
//     its comment for the broken-roster case it also rules out.
//
// The Enforcing() check first is not just an early return: it means a room
// with no roster never reaches identityMu at all, so the ordinary
// zero-config deployment pays nothing for this. The lookup that follows
// runs under the registry's shard lock, one level down — the only place in
// the relay where those two locks nest, and only in that direction
// (identityMu's own critical sections are map reads and writes that never
// call into the registry, so there is no reverse edge to deadlock against).
func (r *Relay) armsDeadline(conn Conn) bool {
	if !r.roster.Enforcing() {
		return true
	}
	return r.grantOf(conn).Authenticated()
}

func (r *Relay) unattendedOf(conn Conn) bool {
	r.identityMu.Lock()
	defer r.identityMu.Unlock()
	latched, ok := r.principal[conn]
	return ok && latched.unattended
}

// PriorityOf is the tier this connection is entitled to. Never reads the
// message body — see relay.py's priority_of.
func (r *Relay) priorityOf(conn Conn) int {
	return r.grantOf(conn).Priority(r.unattendedOf(conn))
}

func (r *Relay) sendLeaseSnapshot(conn Conn, room string) {
	now := r.clock.Now()
	held := r.registry.ActiveClaims(room, conn)
	leases := make([]any, 0, len(held))
	for _, c := range held {
		f := leaseFrame(c, now)
		leases = append(leases, f)
	}
	conn.Send(EncodeFrame(Frame{"type": "leases", "leases": leases, "presence": r.presenceSnapshot(room)}))
}

// presenceSnapshot is recent hook-observed activity, for a joiner that
// missed it live. Mirrors relay.py's _presence_snapshot (PR #31 / issue
// #30).
func (r *Relay) presenceSnapshot(room string) []any {
	ri := r.roomOf(room)
	cutoff := r.clock.Now() - PresenceTTLS
	ri.mu.Lock()
	defer ri.mu.Unlock()
	kept := ri.activity[:0]
	for _, ta := range ri.activity {
		if ta.t > cutoff {
			kept = append(kept, ta)
		}
	}
	ri.activity = kept
	out := make([]any, 0, len(kept))
	for _, ta := range kept {
		out = append(out, Frame{
			"agent": ta.a.Agent, "human": ta.a.Human, "verb": ta.a.Verb,
			"region": regionPayload(ta.a.Region), "ts": ta.t,
		})
	}
	return out
}

// Leave removes a connection from the room it was in and releases its
// leases there. Mirrors relay.py's Relay.leave.
func (r *Relay) Leave(conn Conn) {
	room := conn.Room()
	r.leaveAllRooms(conn)

	r.identityMu.Lock()
	identity, hadIdentity := r.identity[conn]
	delete(r.identity, conn)
	delete(r.principal, conn)
	wasDaemon := r.daemons[conn]
	delete(r.daemons, conn)
	r.identityMu.Unlock()

	// Idempotent the same way the room cleanup above is: a conn Leave has
	// already run for is no longer in r.daemons, so a second call (forced
	// eviction followed by the session's own defer) decrements nothing.
	if wasDaemon {
		r.metrics.DaemonsConnected.Add(-1)
	}
	r.forgetDaemonBaseline(conn)

	if hadIdentity && room != "" {
		// Session end, not an abort: the connection is gone, so the age it
		// accrued shouldn't outlive it either (issue #163).
		r.registry.ReleaseAllSessionEnd(room, identity.agent, nil)
	}
	conn.SetRoom("")
}

// -- fan-out ----------------------------------------------------------------

// Broadcast sends payload to every member of room except exclude.
func (r *Relay) Broadcast(room string, payload Frame, exclude Conn) []Conn {
	ri := r.roomOf(room)
	ri.mu.Lock()
	targets := make([]Conn, 0, len(ri.members))
	for _, c := range ri.members {
		if c != exclude {
			targets = append(targets, c)
		}
	}
	ri.mu.Unlock()
	if len(targets) == 0 {
		return targets
	}
	// Encoded once for every recipient in this call, not once per
	// recipient — see EncodeFrame's doc comment.
	encoded := EncodeFrame(payload)
	// Timed past the empty-room return above on purpose: an empty fan-out
	// isn't a fan-out, and counting it would flood this histogram with
	// zeros from every quiet room, burying the rooms that actually have
	// members to reach.
	metrics.Observe(r.metrics.BroadcastFanout, func() {
		for _, c := range targets {
			c.Send(encoded)
		}
	})
	return targets
}

// Publish implements Publisher: fan-out from the lease table. The
// connection currently being served (actor) is skipped for its *own*
// leases only — it already gets its answer on the same socket. Mirrors
// relay.py's publish.
func (r *Relay) Publish(room string, frame Frame, actor Conn) {
	var exclude Conn
	if actor != nil && actor.Agent() == frameAgent(frame) {
		exclude = actor
	}
	r.Broadcast(room, frame, exclude)
}

func frameAgent(f Frame) string {
	if v, ok := f["agent"]; ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return "\x00absent\x00"
}

// PublishTo implements Publisher: fan-out to one agent's connections in
// one room. Mirrors relay.py's publish_to.
func (r *Relay) PublishTo(room, agent string, frame Frame, actor Conn) {
	ri := r.roomOf(room)
	ri.mu.Lock()
	targets := make([]Conn, 0, 1)
	for _, c := range ri.members {
		if c.Agent() == agent && c != actor {
			targets = append(targets, c)
		}
	}
	ri.mu.Unlock()
	if len(targets) == 0 {
		return
	}
	// Usually one target (one agent, one connection), but two checkouts on
	// one laptop can share an id — encoded once regardless, same rule as
	// Broadcast.
	encoded := EncodeFrame(frame)
	for _, c := range targets {
		c.Send(encoded)
	}
}

// -- presence ---------------------------------------------------------------

func (r *Relay) presence(room string) []Activity {
	ri := r.roomOf(room)
	cutoff := r.clock.Now() - PresenceTTLS
	ri.mu.Lock()
	defer ri.mu.Unlock()
	kept := ri.activity[:0]
	for _, ta := range ri.activity {
		if ta.t > cutoff {
			kept = append(kept, ta)
		}
	}
	ri.activity = kept
	out := make([]Activity, 0, len(kept))
	for _, ta := range kept {
		out = append(out, ta.a)
	}
	return out
}

// -- ingest -------------------------------------------------------------

// Handle dispatches one inbound frame (not "join", which Join handles
// directly). Mirrors relay.py's Relay.handle + _dispatch.
func (r *Relay) Handle(conn Conn, msg map[string]any) Frame {
	// Live reload, on the only clock the relay has. PolicyFile gates its
	// own stat at one a second, so this costs a comparison per frame in
	// the steady state. The broadcast goes out before the frame is
	// dispatched so the answer this connection is about to get and the
	// floor the room is holding cannot disagree. Mirrors relay.py's
	// Relay.handle.
	r.publishPolicyChange()
	return r.dispatch(conn, msg)
}

func (r *Relay) dispatch(conn Conn, msg map[string]any) Frame {
	room := conn.Room()
	if room == "" {
		return nil
	}
	kind, _ := msg["type"].(string)
	if kind == "event" {
		return r.onEvent(room, conn, msg)
	}
	if kind == "stats" {
		// No region, no rung — just a daemon's own counters folded into
		// ours. The room=="" guard above already means a client that
		// never joined never reaches here, which is what keeps this from
		// being a way to post metrics without authenticating first.
		r.onStats(conn, msg)
		return nil
	}
	switch kind {
	case "claim", "contend", "release", "heartbeat", "move":
	default:
		return nil
	}

	r.recordRegionShape(msg["region"])
	region, ok := CleanRegionDict(msg["region"])
	if !ok {
		return nil
	}

	switch kind {
	case "claim":
		return r.onClaim(room, conn, msg, region)
	case "contend":
		r.onContend(room, conn, region)
		return nil
	case "release":
		r.registry.Release(room, conn.Agent(), region, conn)
		return nil
	case "heartbeat":
		r.registry.Heartbeat(room, conn.Agent(), region, conn)
		return nil
	case "move":
		r.recordRegionShape(msg["split_region"])
		var splitScope *Region
		if sc, ok := CleanRegionDict(msg["split_region"]); ok {
			splitScope = &sc
		}
		move, _ := msg["move"].(string)
		outcome := r.negotiator.Apply(room, conn.Agent(), region, move, CleanIntent(msg["reason"]), splitScope, r.priorityOf(conn), conn.Human(), conn)
		reply := Frame{"type": "move_result", "granted": outcome.Granted, "action": outcome.Action}
		if outcome.Error != "" {
			reply["error"] = outcome.Error
		}
		return reply
	}
	return nil
}

func (r *Relay) onEvent(room string, conn Conn, msg map[string]any) Frame {
	r.recordRegionShape(msg["region"])
	clean := RedactEvent(msg)
	now := r.clock.Now()

	// ts is a client-declared timestamp, opted into by whichever daemon
	// stamped this event before it reached us — not this relay's own, and
	// not required. Lease TTL (90s) and presence TTL (30s) are both
	// wall-clock with no clock discipline anywhere in this system, so this
	// is the only place that would ever notice two hosts disagreeing about
	// what time it is. math.Abs because every bucket boundary on this
	// histogram is positive; a clock running fast and one running slow by
	// the same amount should land in the same bucket.
	if ts, ok := clean["ts"].(float64); ok && ts > 0 {
		r.metrics.PeerClockSkew.Observe(math.Abs(now - ts))
	}

	ri := r.roomOf(room)
	ri.mu.Lock()
	ri.lastTs = now
	ri.hasLastTs = true
	ri.mu.Unlock()

	// Read as either concrete type, because RedactEvent returns both.
	// It builds the region as the named Frame type (regionPayloadUnmarked),
	// but under opaque mode it then walks the whole frame through
	// applyOpaqueMap, which rebuilds every nested map as a bare
	// map[string]any. A type assertion matches the concrete type, not the
	// interface it satisfies, so asserting Frame alone succeeded in the
	// clear and failed silently under opaque mode — leaving a nil Frame and
	// an empty-path Region, which then fed collision classification, the
	// room's activity log (so a joiner's presence snapshot showed path "")
	// and the org policy lookup. Opaque mode is supposed to hash the path,
	// not erase it.
	region := regionFromPayload(asFrame(clean["region"]))
	verb, _ := clean["verb"].(string)
	// Hooks never carry one; only an MCP-sourced event does, and only that
	// kind can reach rung 4.
	intent := CleanIntent(clean["intent"])

	// A daemon relays hook events for every session on the machine down one
	// connection, joined once under its own identity — so an event's own
	// agent/human, when it supplies one, is who actually did this, and the
	// connection's joined identity is only the fallback for a hook (which
	// never carries either) or a client too old to send them. This is the
	// *display* identity only: presence storage, the live broadcast below,
	// and Classify's collision detection all read it, because they are all
	// the same presence surface, seen at different times. Claims, leases,
	// negotiation and wait-die below this point stay on conn.Agent()/
	// conn.Human() exactly as before — an event frame is not a credential,
	// and letting a forged agent field move a lease would be a very
	// different bug than the one this is fixing.
	agent := cleanString(clean["agent"])
	if agent == "" {
		agent = conn.Agent()
	}
	human := cleanString(clean["human"])
	if human == "" {
		human = conn.Human()
	}

	event := AgentEvent{Room: room, Human: human, Agent: agent, Kind: "touch",
		Source: ParseSource(cleanString(clean["source"])), Verb: verb, Region: region, Ts: now}

	others := r.presence(room)
	rung := Classify(event, others, intent)

	ri.mu.Lock()
	ri.activity = append(ri.activity, timedActivity{now, Activity{
		Agent: agent, Human: human, Verb: verb, Region: region,
		Intent: intent, Source: event.Source,
	}})
	ri.mu.Unlock()

	r.Broadcast(room, Frame{
		"type": "presence", "agent": agent, "human": human,
		"verb": verb, "region": clean["region"], "rung": rung, "ts": now,
	}, conn)

	// Policy decides how loudly this rung is told. It does not decide the
	// rung, and it never reaches the lease table: Classify above and
	// Negotiator.Open below run exactly as they did before, whatever the
	// effect turns out to be. Mirrors relay.py's _on_event.
	resolution := r.resolvePolicy(conn, rung, region.Path)
	effect := resolution.Effect
	r.metrics.Decision(rung, string(effect))

	// Rung 4 always asks the negotiator, whatever its effect says: the
	// effect governs how loudly a *text match* is reported, not whether
	// there is a lease underneath.
	if !InterruptsAt(rung, &effect) && rung != 4 {
		return Frame{"type": "ack", "rung": rung, "effect": string(effect)}
	}

	brief := r.negotiator.Open(room, conn.Agent(), r.registry.AgeOf(conn.Agent()), region, r.priorityOf(conn), conn.Human(), conn)
	if brief == nil {
		if rung == 4 && effect != EffectSilent {
			if red := redundantPeer(event, others, intent); red != nil {
				r.metrics.RedundantWork.Inc()
				frame := Frame{
					"type": "redundant_work", "rung": 4,
					"effect": string(effect), "effect_source": string(resolution.WinningLayer),
				}
				for k, v := range redundancyPayload(*red) {
					frame[k] = v
				}
				return frame
			}
		}
		return Frame{"type": "ack", "rung": rung, "effect": string(effect)}
	}
	frame := Frame{
		"type": "negotiate", "rung": rung,
		"holder_agent": brief.HolderAgent, "holder_human": brief.HolderHuman,
		"holder_intent": brief.HolderIntent, "moves": moves,
		"decision":        string(brief.Decision),
		"effect":          string(effect),
		"effect_source":   string(resolution.WinningLayer),
		"priority":        PriorityName(brief.RequesterPriority),
		"holder_priority": PriorityName(brief.HolderPriority),
	}
	if brief.HandoverAt != nil {
		// HolderOf first (it prunes on the way in) so the clamp below reads
		// the same ExpiresAt the pushed lease frame does, not a stale one —
		// and so a claim that just expired under us leaves held nil rather
		// than clamping against a lease that's already gone. Unclamped in
		// that case: brief.HandoverAt is still the only number in hand, and
		// a vanished lease and the region being genuinely free of contention
		// are indistinguishable to a requester regardless of what this frame
		// claims.
		held := r.registry.HolderOf(room, region, conn)
		handoverMs := msRemaining(*brief.HandoverAt, now)
		if held != nil {
			handoverMs = clampedHandoverMs(*brief.HandoverAt, held.ExpiresAt, now)
		}
		frame["handover_in_ms"] = handoverMs
		frame["handover_to"] = brief.HandoverTo
		if brief.HandoverTo == conn.Agent() {
			frame["retry_in_ms"] = frame["handover_in_ms"]
			frame["reserved_for_ms"] = int(ReservationS * 1000)
		}
		if held != nil {
			lf := leaseFrame(*held, now)
			lf["type"] = "lease"
			lf["state"] = "held"
			conn.Send(EncodeFrame(lf))
		}
	}
	return frame
}

// redundancyPayload is a rung 4 hit, in the shape both channels hand
// back. Mirrors relay.py's redundancy_payload.
func redundancyPayload(red Redundancy) Frame {
	score := float64(int(red.Score*1000+0.5)) / 1000.0
	return Frame{
		"agent": red.Agent, "human": red.Human, "intent": red.Intent,
		"region": regionPayload(red.Region), "score": score,
		"moves": moves, "advisory": true,
	}
}

// declaredWork is every live MCP-declared intent in the room. Live claims,
// not presence activity, because a claim is the only thing an agent ever
// attaches an intent to. Mirrors relay.py's Relay.declared_work.
func (r *Relay) declaredWork(room string) []Activity {
	claims := r.registry.ActiveClaims(room, nil)
	out := make([]Activity, 0, len(claims))
	for _, c := range claims {
		if c.Intent == "" {
			continue
		}
		out = append(out, Activity{Agent: c.Agent, Human: c.Human, Verb: "edit", Region: c.Scope, Intent: c.Intent, Source: SourceMCP})
	}
	return out
}

// checkRedundancy is is somebody else already doing this, somewhere else
// in the tree? Both declaration channels (the wire claim frame and the
// MCP claim_work tool) land here. Mirrors relay.py's Relay.check_redundancy.
func (r *Relay) checkRedundancy(room, agent, human string, region Region, intent string) *Redundancy {
	peers := r.declaredWork(room)
	probe := AgentEvent{Room: room, Human: human, Agent: agent, Kind: "claim", Source: SourceMCP, Verb: "edit", Region: region, Ts: r.clock.Now()}
	if Classify(probe, peers, intent) != 4 {
		return nil
	}
	return redundantPeer(probe, peers, intent)
}

func regionFromPayload(d Frame) Region {
	path, _ := d["path"].(string)
	r := Region{Path: path}
	if sym, ok := d["symbol"].(string); ok {
		r.Symbol = &sym
	}
	r.Lines = cleanLines(d["lines"])
	return r
}

func (r *Relay) onContend(room string, conn Conn, region Region) {
	held, _ := r.registry.Contend(room, region, conn.Agent(), conn.Human(), r.priorityOf(conn), nil, conn)
	if held == nil {
		return
	}
	f := leaseFrame(*held, r.clock.Now())
	f["type"] = "lease"
	f["state"] = "held"
	conn.Send(EncodeFrame(f))
}

func (r *Relay) onClaim(room string, conn Conn, msg map[string]any, region Region) Frame {
	intent := CleanIntent(msg["intent"])
	result := r.registry.Acquire(room, conn.Human(), conn.Agent(), region, intent, nil, r.priorityOf(conn), conn)
	now := r.clock.Now()

	if result.Ok {
		granted := Frame{"type": "claim_result", "granted": true}
		for k, v := range leaseFrame(*result.Claim, now) {
			granted[k] = v
		}
		// The lease is granted either way. Rung 4 is not contention — the
		// paths are disjoint — it is the news that somebody else already
		// declared this work, delivered while the agent is still
		// deciding what to do. Same volume knob as the event path.
		rung4Effect := r.resolvePolicy(conn, 4, region.Path).Effect
		r.metrics.Decision(4, string(rung4Effect))
		if rung4Effect != EffectSilent {
			if red := r.checkRedundancy(room, conn.Agent(), conn.Human(), region, intent); red != nil {
				r.metrics.RedundantWork.Inc()
				granted["rung"] = 4
				granted["redundant"] = redundancyPayload(*red)
			}
		}
		return granted
	}

	requesterPriority := r.registry.PriorityOf(conn.Agent(), r.priorityOf(conn))

	if result.Decision == decisionAbort {
		r.registry.ReleaseAll(room, conn.Agent(), conn)
	}

	// A refused claim is a rung 3 by definition: a relay-granted lease on
	// a contending region. The effect is advisory here — the daemon's
	// own table is what blocks the edit — but it is what the MCP and web
	// surfaces render, so it travels.
	resolution := r.resolvePolicy(conn, 3, region.Path)
	r.metrics.Decision(3, string(resolution.Effect))

	reply := Frame{
		"type": "claim_result", "granted": false,
		"decision":      string(result.Decision),
		"effect":        string(resolution.Effect),
		"effect_source": string(resolution.WinningLayer),
		"priority":      PriorityName(requesterPriority),
		"region":        regionPayload(region),
	}

	held := result.HeldBy
	if held == nil {
		kept := result.ReservedBy
		reply["held_by"] = kept.Agent
		reply["human"] = kept.Human
		reply["intent"] = "taking over this region"
		reply["holder_priority"] = PriorityName(kept.Priority)
		reply["reserved"] = true
		reply["reserved_from"] = kept.FromAgent
		reply["reserved_from_human"] = kept.FromHuman
		reply["expires_in_ms"] = msRemaining(kept.ExpiresAt, now)
		reply["expires_at"] = kept.ExpiresAt
		reply["retry_in_ms"] = msRemaining(kept.ExpiresAt, now)
		return reply
	}

	reply["held_by"] = held.Agent
	reply["human"] = held.Human
	reply["intent"] = held.Intent
	reply["holder_priority"] = PriorityName(held.Priority)
	reply["expires_in_ms"] = msRemaining(held.ExpiresAt, now)
	reply["expires_at"] = held.ExpiresAt

	winner := held.Winner
	if held.HandoverAt != nil && winner != nil {
		handoverMs := clampedHandoverMs(*held.HandoverAt, held.ExpiresAt, now)
		reply["handover_in_ms"] = handoverMs
		reply["handover_at"] = *held.HandoverAt
		reply["handover_to"] = winner.Agent
		reply["handover_to_human"] = winner.Human
		reply["handover_to_priority"] = PriorityName(winner.Priority)
		reply["waiting"] = held.Waiting
		if winner.Agent == conn.Agent() {
			reply["retry_in_ms"] = handoverMs
			reply["reserved_for_ms"] = int(ReservationS * 1000)
		}
	}
	return reply
}
