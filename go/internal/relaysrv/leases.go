package relaysrv

import (
	"os"
	"strconv"
	"sync"

	"github.com/mohsensc/sync/go/internal/metrics"
)

// Timings. Identical values to python's leases.py — these are the numbers
// the wire protocol and the daemons on the other end are tuned against, not
// ours to pick independently.
const (
	LeaseTTLSDefault = 90.0
	PresenceTTLS     = 30.0
	HeartbeatS       = 30.0
	HandoverGraceS   = 90.0
	FairShareGraceS  = 900.0
	ReservationS     = 10.0
	carryMax         = 512
	shardsPerRoom    = 16
)

// LeaseTTLS is a var, not the constant above, only so the load harness can
// shorten it the same way tests/load/_relay_boot.py patches python's module
// constant before serve imports anything — a scenario that wants to watch a
// lease expire cannot wait 90 seconds per lease. AP_LOAD_LEASE_TTL_S unset
// (the default) leaves it exactly as shipped.
var LeaseTTLS = leaseTTLFromEnv()

func leaseTTLFromEnv() float64 {
	raw := os.Getenv("AP_LOAD_LEASE_TTL_S")
	if raw == "" {
		return LeaseTTLSDefault
	}
	v, err := strconv.ParseFloat(raw, 64)
	if err != nil {
		return LeaseTTLSDefault
	}
	return v
}

// Reservation is a region held open for the agent a handover freed it for.
type Reservation struct {
	Room      string
	Scope     Region
	Agent     string
	Human     string
	Priority  int
	ExpiresAt float64
	FromAgent string
	FromHuman string
}

// AcquireResult mirrors python's leases.AcquireResult. Claim and HeldBy are
// views, not the live claims: see claimView.
type AcquireResult struct {
	Ok         bool
	Claim      *claimView
	HeldBy     *claimView
	Decision   waitDieDecision
	ReservedBy *Reservation
	HandoverAt *float64
	Inherited  *Reservation
}

// Frame is a wire frame body, keyed exactly like the JSON the Python relay
// emits. Built as a plain map because the frame shapes are heterogeneous by
// type and the only contract that matters is the field names on the wire.
type Frame map[string]any

// Publisher is how the lease registry tells a room what changed. Mirrors
// the back-reference _PublishingRegistry holds to Relay in relay.py.
type Publisher interface {
	Publish(room string, frame Frame, actor Conn)
	PublishTo(room, agent string, frame Frame, actor Conn)
}

// carryKey identifies a claim's identity for the dodge-the-deadline check
// in handOver/resumeCarry. Keyed on room, path, symbol and agent — same
// unit same_region() contends on, and the same fields claimKey below uses.
// Lines is display-only, never region identity (see types.go), so it can't
// be part of this key: a holder that releases and re-claims with a
// different (or absent) line range is still the literal same claim
// reappearing, and must inherit the deadline it's trying to dodge.
type carryKey struct {
	room, path, symbol, agent string
}

type carryEntry struct {
	winner   Contender
	deadline *float64
}

// shard is one lock domain: every claim and reservation whose region's path
// hashes here, for one room. Sharding by path (not by the full region) is
// load-bearing: same_region says a whole-file claim (symbol == nil)
// contends with every symbol on that path, so any two regions that could
// possibly conflict share a path and are therefore guaranteed to land in
// the same shard. Sharding any finer would let a whole-file claim and a
// symbol claim on the same path race in different locks and both grant.
type shard struct {
	mu           sync.Mutex
	claims       map[string]*Claim // key: path + "\x00" + symbolKey
	reservations []*Reservation
	carry        map[carryKey]carryEntry
	// dead is set, under mu, by reapRoomLocked once it has verified (also
	// under mu, across every shard of the room at once) that the room is
	// genuinely empty and removed it from Registry.rooms. A caller that
	// fetched this shard's *roomShards before the reap and is only now
	// getting mu sees dead and must not write here — the room is gone from
	// the map, so nothing will ever sweep or read this shard again. It
	// re-resolves through roomOf instead, which recreates the room fresh.
	// See lockLiveShard.
	dead bool
}

func newShard() *shard {
	return &shard{
		claims: make(map[string]*Claim),
		carry:  make(map[carryKey]carryEntry),
	}
}

func claimKey(scope Region) string {
	return scope.Path + "\x00" + symbolKey(scope)
}

// agentEntry is the global (cross-room, cross-shard) wait-die bookkeeping
// for one agent id. Split out from the sharded claim storage because
// age_of/priority_of are deliberately *not* room- or shard-scoped in the
// Python relay — an agent's session, and the wait-for relation, can span
// rooms. See leases.py's age_of docstring.
type agentEntry struct {
	liveCount int
	// Valid iff liveCount > 0: every live claim an agent holds carries the
	// same acquiredAt/tier by construction (see Registry.Acquire), so there
	// is nothing to take a min/max of.
	claimAge  float64
	claimTier int
	// The lease-expiry / requester-age fix from PR #37 (issue #35): an agent
	// between claims is not brand new, so its age latches to the first
	// moment it was seen holding nothing rather than resetting to "now"
	// every time.
	//
	// Three endings write here, and they mean three different things
	// (issue #163): a voluntary release (agentClaimRemovedByRelease) clears
	// firstSeenSet and lets ageOf re-latch to "now" on its next call — the
	// transaction concluded on its own terms, so there's nothing to
	// preserve. An involuntary one that isn't the agent's choice — lazy
	// expiry or a wait-die abort (agentClaimRemoved) — latches firstSeen to
	// the age the agent already had, so an abort-retry keeps the priority
	// it earned instead of reading as brand new. A session ending
	// (agentSessionEnded) deletes the entry outright: the identity itself
	// is going away with the connection, so nothing should be there to
	// latch onto when it reconnects.
	firstSeen    float64
	firstSeenSet bool
}

// Registry is the Go relay's lease table: sharded per room by region path,
// with a small global index for the one thing that has to stay global
// (wait-die age and tier per agent). Mirrors python's
// leases.LeaseRegistry + relay.py's _PublishingRegistry combined — fan-out
// is emitted at each mutation site rather than diffed after the fact,
// because each shard already scopes a mutation to the handful of claims
// that could possibly have changed, so there is nothing left to diff that
// isn't already known at the call site.
type Registry struct {
	clock   Clock
	pub     Publisher
	metrics *metrics.Registry

	roomsMu sync.RWMutex
	rooms   map[string]*roomShards

	agentMu sync.Mutex
	agents  map[string]*agentEntry
}

type roomShards struct {
	shards [shardsPerRoom]*shard
}

func NewRegistry(clock Clock, pub Publisher, m *metrics.Registry) *Registry {
	return &Registry{
		clock:   clock,
		pub:     pub,
		metrics: m,
		rooms:   make(map[string]*roomShards),
		agents:  make(map[string]*agentEntry),
	}
}

func fnv32(s string) uint32 {
	var h uint32 = 2166136261
	for i := 0; i < len(s); i++ {
		h ^= uint32(s[i])
		h *= 16777619
	}
	return h
}

func (r *Registry) roomOf(room string) *roomShards {
	r.roomsMu.RLock()
	rs, ok := r.rooms[room]
	r.roomsMu.RUnlock()
	if ok {
		return rs
	}
	r.roomsMu.Lock()
	defer r.roomsMu.Unlock()
	rs, ok = r.rooms[room]
	if ok {
		return rs
	}
	rs = &roomShards{}
	for i := range rs.shards {
		rs.shards[i] = newShard()
	}
	r.rooms[room] = rs
	return rs
}

func (r *Registry) shardFor(room, path string) *shard {
	rs := r.roomOf(room)
	return rs.shards[fnv32(path)%shardsPerRoom]
}

// lockLiveShard resolves room/path to a shard and returns it locked,
// guaranteed live at the instant it's handed back. Every room-scoped,
// shard-locking operation in this file goes through it rather than raw
// shardFor+Lock — only Acquire can actually put a *new* claim into a shard
// that had none (every other operation only touches claims already there,
// and a room SweepAll judged empty enough to reap can't contain one of
// those), but making that the *only* path that resolves-and-locks a shard
// means the invariant is structural, not a convention five other call
// sites have to remember to honor. A future call site added here gets the
// same safety for free instead of a chance to reintroduce the race.
//
// The race this closes: a caller's shardFor(room, path) can return a
// *roomShards that a concurrent SweepAll reaps — deletes from
// Registry.rooms — in the window between that lookup and the caller taking
// the shard's own mu. Without a check, a write there lands in a shard
// nothing will ever sweep or read again: the same "claim survives, room
// the map remembers doesn't" bug #100 already paid for. reapRoomLocked
// only ever sets dead while holding every shard's mu at once, so a shard
// is never marked dead out from under a caller that already holds its
// lock — a caller either gets mu before the reap (and, if it writes, that
// makes the shard non-empty, so the reap aborts) or after it (and sees
// dead, and retries through roomOf, which recreates the room if it's
// really gone).
func (r *Registry) lockLiveShard(room, path string) *shard {
	for {
		s := r.shardFor(room, path)
		s.mu.Lock()
		if !s.dead {
			return s
		}
		s.mu.Unlock()
	}
}

// -- agent index --------------------------------------------------------

// ageOf is the agent's wait-die age. Mutates on first sight of an
// empty-handed agent (latches firstSeen), exactly like python's age_of
// post-#37.
func (r *Registry) ageOf(agent string) float64 {
	r.agentMu.Lock()
	defer r.agentMu.Unlock()
	e := r.agents[agent]
	if e != nil && e.liveCount > 0 {
		return e.claimAge
	}
	if e != nil && e.firstSeenSet {
		return e.firstSeen
	}
	now := r.clock.Now()
	if e == nil {
		e = &agentEntry{}
		r.agents[agent] = e
	}
	e.firstSeen = now
	e.firstSeenSet = true
	return now
}

func (r *Registry) AgeOf(agent string) float64 { return r.ageOf(agent) }

func (r *Registry) priorityOf(agent string, def int) int {
	r.agentMu.Lock()
	defer r.agentMu.Unlock()
	e := r.agents[agent]
	if e != nil && e.liveCount > 0 {
		return e.claimTier
	}
	return def
}

func (r *Registry) PriorityOf(agent string, def int) int { return r.priorityOf(agent, def) }

// KeyOf is this agent's position in the one total order — exposed for
// tests, mirroring leases.py's key_of.
func (r *Registry) KeyOf(agent string, def int) orderKey {
	return newOrderKey(r.priorityOf(agent, def), r.ageOf(agent), agent)
}

func (r *Registry) agentClaimAdded(agent string, acquiredAt float64, tier int) {
	r.agentMu.Lock()
	defer r.agentMu.Unlock()
	e := r.agents[agent]
	if e == nil {
		e = &agentEntry{}
		r.agents[agent] = e
	}
	e.liveCount++
	e.claimAge = acquiredAt
	e.claimTier = tier
	e.firstSeenSet = false
}

// agentClaimRemoved decrements liveCount and, if that leaves the agent
// holding nothing, latches firstSeen to the age it already had. Used by
// lazy expiry and by ReleaseAll's wait-die-abort caller (relay.go's
// onClaim) — neither is a transaction the agent concluded on its own
// terms, so both preserve the age rather than letting ageOf re-latch to
// "now": an abort-retry that got reset here never gets old enough to be
// told wait (see ageOf). Do NOT call this for a session ending — that's
// agentSessionEnded, which clears the entry instead of preserving it, or
// an agent's priority would survive a disconnect/reconnect forever. See
// agentEntry's doc comment for the full three-way split.
func (r *Registry) agentClaimRemoved(agent string, now float64) {
	r.agentMu.Lock()
	defer r.agentMu.Unlock()
	e := r.agents[agent]
	if e == nil {
		return
	}
	if e.liveCount > 0 {
		e.liveCount--
	}
	if e.liveCount == 0 {
		e.firstSeen = e.claimAge
		e.firstSeenSet = true
	}
}

// agentClaimRemovedByRelease is agentClaimRemoved's counterpart for a
// single-region *voluntary* release (the wire "release" frame, or
// HANDOFF) — the one door a claim can leave through that really is the
// transaction concluding on its own terms. If that leaves the agent
// holding nothing anywhere, its accrued age is cleared, not reset to
// `now` here: ageOf re-latches lazily, on its own next call, exactly like
// python's release() popping `_first_seen` rather than setting it.
func (r *Registry) agentClaimRemovedByRelease(agent string, now float64) {
	r.agentMu.Lock()
	defer r.agentMu.Unlock()
	e := r.agents[agent]
	if e == nil {
		return
	}
	if e.liveCount > 0 {
		e.liveCount--
	}
	if e.liveCount == 0 {
		e.firstSeenSet = false
	}
}

// agentIdentityReset is release_everywhere's other half: the id has
// changed hands, so its accrued age must not carry over to whoever takes
// the name next, any more than its tier does.
func (r *Registry) agentIdentityReset(agent string) {
	r.agentMu.Lock()
	defer r.agentMu.Unlock()
	delete(r.agents, agent)
}

// agentSessionEnded is ReleaseAllSessionEnd's other half, shaped exactly
// like agentIdentityReset: the connection is gone, not merely between
// claims, so there's no retry coming that should inherit the age it had.
// This is what keeps agentClaimRemoved's preserved age (see its doc
// comment) from turning into "the first agent to ever connect outranks
// the room forever" — that failure only shows up if session end reuses
// the abort/expiry path instead of clearing outright.
//
// But it must not clear out from under a claim this same agent id still
// holds somewhere else — a second connection sharing the id (bindAgent
// permits that for a matching principal/tier), or a room this session
// left without releasing (should no longer happen after Join's own fix,
// but this is the entry's last line of defense either way). liveCount is
// already the global, cross-room count agentClaimAdded/Removed maintain
// for exactly this reason (issue #173): only a session ending with
// nothing left live anywhere should erase the identity.
func (r *Registry) agentSessionEnded(agent string) {
	r.agentMu.Lock()
	defer r.agentMu.Unlock()
	if e := r.agents[agent]; e != nil && e.liveCount > 0 {
		return
	}
	delete(r.agents, agent)
}

// -- shard-local helpers, caller holds s.mu ------------------------------

// pruneExpired removes expired claims from this shard, hands each one over
// (reserving the region for its winner if a deadline fired) and publishes
// the departure. Mirrors leases.py's _live() plus relay.py's override of
// it from PR #37/#35 (issue #34): lazy expiry is not exclusive to a write,
// so every shard operation prunes on the way in, not just the mutating
// ones, or an expiry discovered by a read (holder_of, active_claims) never
// gets broadcast at all.
func (r *Registry) pruneExpired(room string, s *shard, now float64, actor Conn) {
	for key, c := range s.claims {
		if c.ExpiresAt > now {
			continue
		}
		winner := c.handoverWinner()
		delete(s.claims, key)
		r.agentClaimRemoved(c.Agent, now)
		reservation := r.handOver(s, c, now)
		// departureFrame only says "expired" when handOver didn't just
		// upgrade this departure to a handover (see its own doc comment) —
		// recording both here would double-count a departure the wire
		// only ever describes one way. handOver records its own outcome.
		if reservation == nil {
			r.metrics.Lease(metrics.OutcomeExpired)
		}
		frame := departureFrame(c.Room, c.Human, c.Agent, c.Scope, now, "expired", winner, reservation)
		r.pub.Publish(room, frame, actor)
	}
}

// handOver is called with s.mu held, for a claim that just left the table
// (expired here, or released/replaced by the caller). If its renewal
// deadline is what ended it, reserve the region for the contender it was
// capped for. The carry bookkeeping here is what stops a holder dodging
// its deadline by releasing and re-taking a region a second before it
// fires.
func (r *Registry) handOver(s *shard, c *Claim, now float64) *Reservation {
	winner := c.handoverWinner()
	if winner == nil {
		return nil
	}
	if c.HandoverAt == nil || *c.HandoverAt > now {
		key := carryKey{c.Room, c.Scope.Path, symbolKey(c.Scope), c.Agent}
		s.carry[key] = carryEntry{winner: *winner, deadline: c.HandoverAt}
		if len(s.carry) > carryMax {
			for k, v := range s.carry {
				if v.deadline == nil || *v.deadline <= now {
					delete(s.carry, k)
				}
			}
		}
		return nil
	}
	res := &Reservation{
		Room: c.Room, Scope: c.Scope, Agent: winner.Agent, Human: winner.Human,
		Priority: winner.Priority, ExpiresAt: now + ReservationS,
		FromAgent: c.Agent, FromHuman: c.Human,
	}
	s.reservations = append(s.reservations, res)
	// The one place a handover actually happens, whichever caller's claim
	// triggered it (lazy expiry, an explicit release, a session ending) —
	// recording here once covers all of them, rather than guessing at the
	// outcome back at each call site from what departureFrame decided to
	// call it.
	r.metrics.Lease(metrics.OutcomeHandover)
	return res
}

func (r *Registry) resumeCarry(s *shard, c *Claim, now float64) {
	if len(s.carry) == 0 {
		return
	}
	key := carryKey{c.Room, c.Scope.Path, symbolKey(c.Scope), c.Agent}
	carried, ok := s.carry[key]
	if !ok {
		return
	}
	delete(s.carry, key)
	if carried.deadline == nil || *carried.deadline <= now {
		return
	}
	c.NoteContender(carried.winner)
	d := *carried.deadline
	c.HandoverAt = &d
	if d < c.ExpiresAt {
		c.ExpiresAt = d
	}
}

func liveReservations(s *shard, now float64) []*Reservation {
	if len(s.reservations) == 0 {
		return s.reservations
	}
	kept := s.reservations[:0:0]
	for _, res := range s.reservations {
		if res.ExpiresAt > now {
			kept = append(kept, res)
		}
	}
	s.reservations = kept
	return kept
}

func reservationForLocked(s *shard, region Region, now float64) *Reservation {
	for _, res := range liveReservations(s, now) {
		if SameRegion(res.Scope, region) {
			return res
		}
	}
	return nil
}

func consumeReservationLocked(s *shard, region Region, agent string, now float64) *Reservation {
	live := liveReservations(s, now)
	if len(live) == 0 {
		return nil
	}
	var taken *Reservation
	kept := live[:0:0]
	for _, res := range live {
		if SameRegion(res.Scope, region) && res.Agent == agent {
			if taken == nil {
				taken = res
			}
			continue
		}
		kept = append(kept, res)
	}
	s.reservations = kept
	return taken
}

func holderOfLocked(s *shard, region Region) *Claim {
	for _, c := range s.claims {
		if SameRegion(c.Scope, region) {
			return c
		}
	}
	return nil
}

func renewTo(c *Claim, now float64) float64 {
	want := now + LeaseTTLS
	if c.HandoverAt == nil {
		return want
	}
	if *c.HandoverAt < want {
		return *c.HandoverAt
	}
	return want
}

// contendLocked records that agent wants held's region, capping the
// holder's renewal. Mirrors leases.py's _contend.
func contendLocked(held *Claim, agent, human string, tier int, decision waitDieDecision, now float64) {
	existing, ok := held.Contenders[agent]
	firstAsked := now
	if ok {
		firstAsked = existing.FirstAskedAt
	}
	held.NoteContender(Contender{Agent: agent, Human: human, Priority: tier, FirstAskedAt: firstAsked})

	grace := FairShareGraceS
	if decision == decisionWait {
		grace = HandoverGraceS
	}
	deadline := now + grace
	if held.HandoverAt == nil || deadline < *held.HandoverAt {
		held.HandoverAt = &deadline
	}
	if *held.HandoverAt < held.ExpiresAt {
		held.ExpiresAt = *held.HandoverAt
	}
}

// -- public, room-scoped operations --------------------------------------

func (r *Registry) HolderOf(room string, region Region, actor Conn) *claimView {
	s := r.lockLiveShard(room, region.Path)
	defer s.mu.Unlock()
	now := r.clock.Now()
	r.pruneExpired(room, s, now, actor)
	return viewPtr(holderOfLocked(s, region))
}

func (r *Registry) ReservationFor(room string, region Region, actor Conn) *Reservation {
	s := r.lockLiveShard(room, region.Path)
	defer s.mu.Unlock()
	now := r.clock.Now()
	r.pruneExpired(room, s, now, actor)
	return reservationForLocked(s, region, now)
}

// ActiveClaims is every live claim in a room. Only called at join
// (snapshot) and in tests: it walks every shard, which is fine off the hot
// path but would not be if it ran per claim.
func (r *Registry) ActiveClaims(room string, actor Conn) []claimView {
	rs := r.roomOf(room)
	now := r.clock.Now()
	var out []claimView
	for _, s := range rs.shards {
		s.mu.Lock()
		r.pruneExpired(room, s, now, actor)
		for _, c := range s.claims {
			out = append(out, viewOf(c))
		}
		s.mu.Unlock()
	}
	return out
}

// SweepAll walks every shard of every room and prunes+publishes expired
// claims, regardless of whether anything touched that shard recently.
// Mirrors python leases.py's _live(), which re-sweeps the whole table
// (every room, every claim) on every single relay call. This registry
// shards per room by path hash specifically so a hot region's traffic
// doesn't serialize behind a cold one's (see the package doc comment on
// shard), so pruneExpired alone only ever reaches the shard the call in
// progress touched — an idle shard's expiry can otherwise sit
// unbroadcast until something else touches that same region or a member
// joins and runs ActiveClaims. Issue #47.
//
// Run from a background ticker (see server.go), never from a request
// path: this takes and releases each shard's own mutex once, in turn,
// which is the same lock discipline ActiveClaims already uses off the
// hot path — it does not add one lock spanning every shard at once, which
// would undo the sharding this throughput comes from.
func (r *Registry) SweepAll() {
	r.roomsMu.RLock()
	rooms := make(map[string]*roomShards, len(r.rooms))
	for name, rs := range r.rooms {
		rooms[name] = rs
	}
	r.roomsMu.RUnlock()

	now := r.clock.Now()
	// A loose, sequential (lock-one-shard-at-a-time) pass: cheap, and the
	// existing per-request cost of pruning. It also tells us which rooms
	// are worth the strict double-check below — a room this pass finds
	// non-empty cannot have become reapable by the time we get to it, so
	// there is no point paying for one.
	var candidates []string
	for room, rs := range rooms {
		empty := true
		for _, s := range rs.shards {
			s.mu.Lock()
			r.pruneExpired(room, s, now, nil)
			if len(s.claims) != 0 || len(s.carry) != 0 || len(liveReservations(s, now)) != 0 {
				empty = false
			}
			s.mu.Unlock()
		}
		if empty {
			candidates = append(candidates, room)
		}
	}

	// The strict pass, one candidate room at a time: re-verify emptiness
	// with every one of the room's shards locked simultaneously (not
	// sequentially — a sequential re-check would leave the exact same gap
	// between "shard 0 looked empty" and "shard 15 looked empty" that the
	// loose pass above already has) and only then delete. roomsMu.Lock()
	// is taken per room, not once for the whole batch, so an ordinary
	// Join/roomOf for an unrelated room is never blocked for longer than
	// one room's worth of reaping.
	for _, room := range candidates {
		r.roomsMu.Lock()
		if rs, ok := r.rooms[room]; ok {
			r.reapRoomLocked(room, rs, now)
		}
		r.roomsMu.Unlock()
	}
}

// reapRoomLocked deletes room from r.rooms if it is genuinely empty across
// every shard at once. Caller holds r.roomsMu (write); this additionally
// takes every shard's own mu for the duration of the check, which is what
// makes the check-then-delete atomic with respect to Acquire — see
// lockLiveShard's doc comment for the race this closes and why marking
// dead here, under the same mu a straggling Acquire is about to wait on,
// is the part that actually matters (roomsMu alone is not enough: a caller
// that already resolved this *roomShards before we got roomsMu is not
// looking at the map again, so removing the map entry doesn't stop it).
func (r *Registry) reapRoomLocked(room string, rs *roomShards, now float64) {
	for _, s := range rs.shards {
		s.mu.Lock()
	}
	empty := true
	for _, s := range rs.shards {
		if len(s.claims) != 0 || len(s.carry) != 0 || len(liveReservations(s, now)) != 0 {
			empty = false
			break
		}
	}
	if empty {
		delete(r.rooms, room)
		for _, s := range rs.shards {
			s.dead = true
		}
	}
	for _, s := range rs.shards {
		s.mu.Unlock()
	}
}

// Contend registers an ask for a region somebody else holds, without
// taking it. Mirrors leases.py's contend.
//
// The wait-die decision comes back with the view because it is resolved
// here, under the lock, against the same holder contendLocked then caps —
// the caller re-resolving it off the lock (negotiation.Open used to) reads
// a claim that may already have moved on.
func (r *Registry) Contend(room string, scope Region, agent, human string, tier int, requesterAcquiredAt *float64, actor Conn) (*claimView, waitDieDecision) {
	s := r.lockLiveShard(room, scope.Path)
	defer s.mu.Unlock()
	now := r.clock.Now()
	r.pruneExpired(room, s, now, actor)

	held := holderOfLocked(s, scope)
	if held == nil || held.Agent == agent {
		return nil, ""
	}
	before := snapshotOf(held)
	age := requesterAcquiredAt
	var ageVal float64
	if age == nil {
		ageVal = r.ageOf(agent)
	} else {
		ageVal = *age
	}
	decision := resolveWaitDie(agent, ageVal, held, tier)
	contendLocked(held, agent, human, tier, decision, now)
	r.emitChange(room, held, before, now, actor)
	return viewPtr(held), decision
}

// Withdraw takes back an ask: the requester is dropped from the holder's
// contender set, and if that was the last one the cap the ask put on the
// holder's lease is lifted.
//
// This is DEFER's other half. Opening a brief is an ask, so by the time a
// requester can answer one, contendLocked has already recorded it and
// pulled the holder's HandoverAt (and its ExpiresAt with it) down to the
// grace deadline. Answering "you keep it, I'm backing off" used to touch
// nothing, so the ask outlived the decision that withdrew it and the
// region was handed to the agent that had just declined it.
//
// Deliberately does NOT restore ExpiresAt. contendLocked clamps it down to
// the deadline, so the obvious completion is to push it back out — but
// nothing here knows whether the holder is still alive. A holder that
// wedged at T0 and never heartbeated again would take a fresh 90s every
// time somebody asked and then deferred, and an ordinary polite client
// (open a brief, see it is contended, back off, retry later) does exactly
// that on a loop. Each courteous retry would renew a dead agent's lease.
//
// removeContender nils HandoverAt, which is the part that has to be lifted.
// The clamp then heals on its own: the holder's next heartbeat is at most
// HeartbeatS away and renewTo gives it now + LeaseTTLS. A holder that has
// stopped heartbeating gets nothing, which is the right answer.
func (r *Registry) Withdraw(room string, scope Region, requester string, actor Conn) {
	s := r.lockLiveShard(room, scope.Path)
	defer s.mu.Unlock()
	now := r.clock.Now()
	r.pruneExpired(room, s, now, actor)

	held := holderOfLocked(s, scope)
	if held == nil || held.Agent == requester {
		return
	}
	before := snapshotOf(held)
	if !held.removeContender(requester) {
		return
	}
	r.emitChange(room, held, before, now, actor)
}

// Acquire is the whole decision tree: grant, renew, refuse-with-wait,
// refuse-with-abort, or grant-from-a-reservation. Mirrors leases.py's
// acquire exactly, including the ordering of checks (renewal before
// reservation, so an agent already holding a region is never refused its
// own renewal by a neighbour's reservation).
func (r *Registry) Acquire(room, human, agent string, scope Region, intent string, requesterAcquiredAt *float64, priority int, actor Conn) AcquireResult {
	tier := r.priorityOf(agent, priority)
	now := r.clock.Now()

	s := r.lockLiveShard(room, scope.Path)
	defer s.mu.Unlock()
	r.pruneExpired(room, s, now, actor)

	held := holderOfLocked(s, scope)
	if held != nil && held.Agent != agent {
		var ageVal float64
		if requesterAcquiredAt == nil {
			ageVal = r.ageOf(agent)
		} else {
			ageVal = *requesterAcquiredAt
		}
		decision := resolveWaitDie(agent, ageVal, held, tier)
		before := snapshotOf(held)
		contendLocked(held, agent, human, tier, decision, now)
		r.emitChange(room, held, before, now, actor)
		view := viewPtr(held)
		// wait and abort are peers in the outcome vocabulary, not one
		// outcome refining the other — a losing requester is refused
		// either way, but only wait-die's abort branch is "abort".
		if decision == decisionAbort {
			r.metrics.Lease(metrics.OutcomeAbort)
		} else {
			r.metrics.Lease(metrics.OutcomeRefused)
		}
		return AcquireResult{Ok: false, HeldBy: view, Decision: decision, HandoverAt: view.HandoverAt}
	}

	if held != nil {
		before := snapshotOf(held)
		held.ExpiresAt = renewTo(held, now)
		r.emitChange(room, held, before, now, actor)
		r.metrics.Lease(metrics.OutcomeGranted)
		return AcquireResult{Ok: true, Claim: viewPtr(held)}
	}

	reserved := reservationForLocked(s, scope, now)
	if reserved != nil && reserved.Agent != agent {
		r.metrics.Lease(metrics.OutcomeRefused)
		return AcquireResult{Ok: false, Decision: decisionWait, ReservedBy: reserved}
	}

	inherited := consumeReservationLocked(s, scope, agent, now)

	claim := &Claim{
		Room: room, Human: human, Agent: agent, Scope: scope, Intent: intent,
		AcquiredAt: r.ageOf(agent), ExpiresAt: now + LeaseTTLS, Priority: tier,
	}
	r.resumeCarry(s, claim, now)
	s.claims[claimKey(scope)] = claim
	r.agentClaimAdded(agent, claim.AcquiredAt, tier)
	r.emitNew(room, claim, now, actor)
	r.metrics.Lease(metrics.OutcomeGranted)
	return AcquireResult{Ok: true, Claim: viewPtr(claim), Inherited: inherited}
}

func (r *Registry) Heartbeat(room, agent string, scope Region, actor Conn) bool {
	s := r.lockLiveShard(room, scope.Path)
	defer s.mu.Unlock()
	now := r.clock.Now()
	r.pruneExpired(room, s, now, actor)
	c, ok := s.claims[claimKey(scope)]
	if !ok || c.Agent != agent {
		return false
	}
	before := snapshotOf(c)
	c.ExpiresAt = renewTo(c, now)
	r.emitChange(room, c, before, now, actor)
	return true
}

func (r *Registry) Release(room, agent string, scope Region, actor Conn) {
	s := r.lockLiveShard(room, scope.Path)
	defer s.mu.Unlock()
	now := r.clock.Now()
	r.pruneExpired(room, s, now, actor)
	key := claimKey(scope)
	c, ok := s.claims[key]
	if !ok || c.Agent != agent {
		return
	}
	winner := c.handoverWinner()
	delete(s.claims, key)
	r.agentClaimRemovedByRelease(c.Agent, now)
	reservation := r.handOver(s, c, now)
	frame := departureFrame(c.Room, c.Human, c.Agent, c.Scope, now, "released", winner, reservation)
	r.pub.Publish(room, frame, actor)
}

// ReleaseAll drops every lease an agent holds in one room, preserving its
// wait-die age (agentClaimRemoved). This is the wait-die-abort path
// (relay.go's onClaim, on decisionAbort) — the agent didn't choose to let
// go, so a retry should keep the priority it earned. For a connection's
// session actually ending, use ReleaseAllSessionEnd instead: reusing this
// one there would let an agent's age survive disconnect/reconnect forever.
func (r *Registry) ReleaseAll(room, agent string, actor Conn) {
	r.releaseAllInRoom(room, agent, actor, false)
}

// ReleaseAllSessionEnd is ReleaseAll's counterpart for a connection's
// session actually ending (relay.go's Leave). Unlike an abort, there's no
// retry on the way — the identity is leaving with the socket — so once
// every lease is dropped the same way ReleaseAll drops them, the agent's
// wait-die entry is cleared outright instead of preserved: a rejoin under
// the same agent id starts fresh, exactly like a genuinely new agent
// would. It also prunes agent's contender entry from every other claim
// still standing in the room (issue #174): see releaseAllInRoom's doc for
// why that pruning belongs here and not in ReleaseAll.
func (r *Registry) ReleaseAllSessionEnd(room, agent string, actor Conn) {
	r.releaseAllInRoom(room, agent, actor, true)
	r.agentSessionEnded(agent)
}

// releaseAllInRoom is ReleaseAll's body, shared with ReleaseAllSessionEnd.
// pruneAsks additionally walks every claim left in the room after agent's
// own are gone and removes agent from their contender sets — only correct
// when the agent is actually leaving (ReleaseAllSessionEnd), never for a
// plain wait-die abort or lazy expiry: those mean the agent lost *this*
// claim, not that it disconnected, and it may still be legitimately
// contending elsewhere. That's why this is a parameter here rather than
// unconditional behaviour of ReleaseAll itself, which relay.go's onClaim
// also calls on abort.
func (r *Registry) releaseAllInRoom(room, agent string, actor Conn, pruneAsks bool) {
	rs := r.roomOf(room)
	now := r.clock.Now()
	for _, s := range rs.shards {
		s.mu.Lock()
		r.pruneExpired(room, s, now, actor)
		for key, c := range s.claims {
			if c.Agent != agent {
				continue
			}
			winner := c.handoverWinner()
			delete(s.claims, key)
			r.agentClaimRemoved(c.Agent, now)
			reservation := r.handOver(s, c, now)
			frame := departureFrame(c.Room, c.Human, c.Agent, c.Scope, now, "released", winner, reservation)
			r.pub.Publish(room, frame, actor)
		}
		if pruneAsks {
			r.pruneContendersLocked(room, s, agent, now, actor)
		}
		s.mu.Unlock()
	}
}

// pruneContendersLocked removes agent's contender entry from every claim
// left in s (its own claims are already gone from s.claims by the time
// this runs). Caller holds s.mu — same shard, no additional locking, same
// discipline every other shard-local helper in this file uses.
func (r *Registry) pruneContendersLocked(room string, s *shard, agent string, now float64, actor Conn) {
	for _, c := range s.claims {
		before := snapshotOf(c)
		if !c.removeContender(agent) {
			continue
		}
		r.emitChange(room, c, before, now, actor)
	}
}

// ReleaseEverywhere drops every lease this agent id holds, in every room —
// the identity-handoff path (Relay._bind_agent's drop_stranded_claims).
func (r *Registry) ReleaseEverywhere(agent string, actor Conn) {
	// Held for the whole sweep, not just to snapshot the room list: this is
	// rare (identity reclaim only, see relay.go's dropStrandedClaims), so
	// blocking a concurrent room *creation* for its duration is cheap, and
	// it is what closes a real gap a snapshot-then-release-then-iterate
	// pattern would leave — a room created in that window would silently
	// never be swept by this call. Existing rooms are untouched by this
	// lock (roomOf's read path only needs RLock too), so ordinary traffic
	// in rooms that already exist is not blocked.
	r.roomsMu.RLock()
	defer r.roomsMu.RUnlock()

	now := r.clock.Now()
	for room, rs := range r.rooms {
		for _, s := range rs.shards {
			s.mu.Lock()
			r.pruneExpired(room, s, now, actor)
			for key, c := range s.claims {
				if c.Agent != agent {
					continue
				}
				winner := c.handoverWinner()
				delete(s.claims, key)
				r.agentClaimRemoved(c.Agent, now)
				reservation := r.handOver(s, c, now)
				frame := departureFrame(c.Room, c.Human, c.Agent, c.Scope, now, "released", winner, reservation)
				r.pub.Publish(room, frame, actor)
			}
			// The identity is being reclaimed by whoever binds next, same as
			// a session ending — see releaseAllInRoom's doc for why abort/
			// expiry never do this and session-shaped departures always do.
			r.pruneContendersLocked(room, s, agent, now, actor)
			s.mu.Unlock()
		}
	}
	r.agentIdentityReset(agent)
}

// -- fan-out --------------------------------------------------------------

type claimSnapshot struct {
	room, human, intent string
	expiresAt           float64
	handoverAt          *float64
	winner              *Contender
}

func snapshotOf(c *Claim) claimSnapshot {
	return claimSnapshot{
		room: c.Room, human: c.Human, intent: c.Intent, expiresAt: c.ExpiresAt,
		handoverAt: c.HandoverAt, winner: c.handoverWinner(),
	}
}

func sameShared(a, b claimSnapshot) bool {
	return a.room == b.room && a.human == b.human && a.intent == b.intent && a.expiresAt == b.expiresAt
}

func sameHandoverAt(a, b *float64) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

func sameWinner(a, b *Contender) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

// snapshotsEqual is value equality, not the pointer equality Go's == would
// give a struct holding *float64/*Contender fields. Mirrors the frozen
// dataclass equality python's _snapshot tuple gets for free — two winner
// pointers with identical contents (the common "incumbent re-asks with the
// same key" case in note_contender, which reallocates) must compare equal
// or a re-ask that changed nothing would still get a fan-out frame.
func snapshotsEqual(a, b claimSnapshot) bool {
	return sameShared(a, b) && sameHandoverAt(a.handoverAt, b.handoverAt) && sameWinner(a.winner, b.winner)
}

// emitChange publishes a lease frame for a claim that was just renewed or
// contended, routing it to the whole room or only to the holder depending
// on whether anything a non-holder's cache keys on actually changed.
// Mirrors relay.py's _publish loop, scoped to one claim because a shard
// operation only ever touches one.
func (r *Registry) emitChange(room string, c *Claim, before claimSnapshot, now float64, actor Conn) {
	after := snapshotOf(c)
	if snapshotsEqual(before, after) {
		return
	}
	frame := leaseFrame(viewOf(c), now)
	frame["type"] = "lease"
	frame["state"] = "held"
	if sameShared(before, after) {
		r.pub.PublishTo(room, c.Agent, frame, actor)
	} else {
		r.pub.Publish(room, frame, actor)
	}
}

func (r *Registry) emitNew(room string, c *Claim, now float64, actor Conn) {
	frame := leaseFrame(viewOf(c), now)
	frame["type"] = "lease"
	frame["state"] = "held"
	r.pub.Publish(room, frame, actor)
}
