package relaysrv

import (
	"os"
	"strconv"
	"strings"
	"sync"
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

// AcquireResult mirrors python's leases.AcquireResult.
type AcquireResult struct {
	Ok         bool
	Claim      *Claim
	HeldBy     *Claim
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
// in handOver/resumeCarry. Mirrors leases.py's `_carry` dict key exactly:
// python keys on the full frozen Region (path, symbol *and* lines), not
// same_region()'s coarser path+symbol contention unit — same_region()
// deliberately ignores lines for conflict detection, but the carry dict is
// a different question ("is this the literal same claim reappearing"),
// and python answers it with plain dataclass equality. Dropping lines
// here would make Go's carry match in cases Python's wouldn't (a release
// and re-claim of the same symbol with a different line range would
// still reattach the remembered deadline in Go but not Python) — a real,
// if narrow, wire-behavior divergence, not just an internal difference.
type carryKey struct {
	room, path, symbol, lines, agent string
}

func linesKey(r Region) string {
	if len(r.Lines) == 0 {
		return ""
	}
	parts := make([]string, len(r.Lines))
	for i, v := range r.Lines {
		parts[i] = strconv.Itoa(v)
	}
	return strings.Join(parts, ",")
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
	clock Clock
	pub   Publisher

	roomsMu sync.RWMutex
	rooms   map[string]*roomShards

	agentMu sync.Mutex
	agents  map[string]*agentEntry
}

type roomShards struct {
	shards [shardsPerRoom]*shard
}

func NewRegistry(clock Clock, pub Publisher) *Registry {
	return &Registry{
		clock:  clock,
		pub:    pub,
		rooms:  make(map[string]*roomShards),
		agents: make(map[string]*agentEntry),
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

// agentClaimRemoved decrements liveCount and nothing else. Used by lazy
// expiry and by ReleaseAll (session end / a wait-die abort) — neither is a
// transaction concluding on its own terms, so neither touches firstSeen.
// Losing this distinction either way breaks something: an abort-retry that
// got reset here never gets old enough to be told wait (see ageOf), and a
// version that never resets anywhere means the first agent to ever connect
// outranks the room forever. See leases.py's release_all docstring (PR #37).
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
		winner := c.HandoverWinner()
		delete(s.claims, key)
		r.agentClaimRemoved(c.Agent, now)
		reservation := r.handOver(s, c, now)
		frame := departureFrame(c.Room, c.Human, c.Agent, c.Scope, now, "expired", winner, reservation)
		r.pub.Publish(room, frame, actor)
	}
}

// handOver is called with s.mu held, for a claim that just left the table
// (expired here, or released/replaced by the caller). If its renewal
// deadline is what ended it, reserve the region for the contender it was
// capped for. Mirrors leases.py's _hand_over exactly, including the carry
// bookkeeping that stops a holder dodging its deadline by releasing and
// re-taking a region a second before it fires.
func (r *Registry) handOver(s *shard, c *Claim, now float64) *Reservation {
	winner := c.HandoverWinner()
	if winner == nil {
		return nil
	}
	if c.HandoverAt == nil || *c.HandoverAt > now {
		key := carryKey{c.Room, c.Scope.Path, symbolKey(c.Scope), linesKey(c.Scope), c.Agent}
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
	return res
}

func (r *Registry) resumeCarry(s *shard, c *Claim, now float64) {
	if len(s.carry) == 0 {
		return
	}
	key := carryKey{c.Room, c.Scope.Path, symbolKey(c.Scope), linesKey(c.Scope), c.Agent}
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

func (r *Registry) HolderOf(room string, region Region, actor Conn) *Claim {
	s := r.shardFor(room, region.Path)
	s.mu.Lock()
	defer s.mu.Unlock()
	now := r.clock.Now()
	r.pruneExpired(room, s, now, actor)
	return holderOfLocked(s, region)
}

func (r *Registry) ReservationFor(room string, region Region, actor Conn) *Reservation {
	s := r.shardFor(room, region.Path)
	s.mu.Lock()
	defer s.mu.Unlock()
	now := r.clock.Now()
	r.pruneExpired(room, s, now, actor)
	return reservationForLocked(s, region, now)
}

// ActiveClaims is every live claim in a room. Only called at join
// (snapshot) and in tests: it walks every shard, which is fine off the hot
// path but would not be if it ran per claim.
func (r *Registry) ActiveClaims(room string, actor Conn) []*Claim {
	rs := r.roomOf(room)
	now := r.clock.Now()
	var out []*Claim
	for _, s := range rs.shards {
		s.mu.Lock()
		r.pruneExpired(room, s, now, actor)
		for _, c := range s.claims {
			out = append(out, c)
		}
		s.mu.Unlock()
	}
	return out
}

// Contend registers an ask for a region somebody else holds, without
// taking it. Mirrors leases.py's contend.
func (r *Registry) Contend(room string, scope Region, agent, human string, tier int, requesterAcquiredAt *float64, actor Conn) *Claim {
	s := r.shardFor(room, scope.Path)
	s.mu.Lock()
	defer s.mu.Unlock()
	now := r.clock.Now()
	r.pruneExpired(room, s, now, actor)

	held := holderOfLocked(s, scope)
	if held == nil || held.Agent == agent {
		return nil
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
	return held
}

// Acquire is the whole decision tree: grant, renew, refuse-with-wait,
// refuse-with-abort, or grant-from-a-reservation. Mirrors leases.py's
// acquire exactly, including the ordering of checks (renewal before
// reservation, so an agent already holding a region is never refused its
// own renewal by a neighbour's reservation).
func (r *Registry) Acquire(room, human, agent string, scope Region, intent string, requesterAcquiredAt *float64, priority int, actor Conn) AcquireResult {
	tier := r.priorityOf(agent, priority)
	now := r.clock.Now()

	s := r.shardFor(room, scope.Path)
	s.mu.Lock()
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
		ha := held.HandoverAt
		return AcquireResult{Ok: false, HeldBy: held, Decision: decision, HandoverAt: ha}
	}

	if held != nil {
		before := snapshotOf(held)
		held.ExpiresAt = renewTo(held, now)
		r.emitChange(room, held, before, now, actor)
		return AcquireResult{Ok: true, Claim: held}
	}

	reserved := reservationForLocked(s, scope, now)
	if reserved != nil && reserved.Agent != agent {
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
	return AcquireResult{Ok: true, Claim: claim, Inherited: inherited}
}

func (r *Registry) Heartbeat(room, agent string, scope Region, actor Conn) bool {
	s := r.shardFor(room, scope.Path)
	s.mu.Lock()
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
	s := r.shardFor(room, scope.Path)
	s.mu.Lock()
	defer s.mu.Unlock()
	now := r.clock.Now()
	r.pruneExpired(room, s, now, actor)
	key := claimKey(scope)
	c, ok := s.claims[key]
	if !ok || c.Agent != agent {
		return
	}
	winner := c.HandoverWinner()
	delete(s.claims, key)
	r.agentClaimRemovedByRelease(c.Agent, now)
	reservation := r.handOver(s, c, now)
	frame := departureFrame(c.Room, c.Human, c.Agent, c.Scope, now, "released", winner, reservation)
	r.pub.Publish(room, frame, actor)
}

// ReleaseAll drops every lease an agent holds in one room. Used on session
// end and on a wait-die abort.
func (r *Registry) ReleaseAll(room, agent string, actor Conn) {
	rs := r.roomOf(room)
	now := r.clock.Now()
	for _, s := range rs.shards {
		s.mu.Lock()
		r.pruneExpired(room, s, now, actor)
		for key, c := range s.claims {
			if c.Agent != agent {
				continue
			}
			winner := c.HandoverWinner()
			delete(s.claims, key)
			r.agentClaimRemoved(c.Agent, now)
			reservation := r.handOver(s, c, now)
			frame := departureFrame(c.Room, c.Human, c.Agent, c.Scope, now, "released", winner, reservation)
			r.pub.Publish(room, frame, actor)
		}
		s.mu.Unlock()
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
				winner := c.HandoverWinner()
				delete(s.claims, key)
				r.agentClaimRemoved(c.Agent, now)
				reservation := r.handOver(s, c, now)
				frame := departureFrame(c.Room, c.Human, c.Agent, c.Scope, now, "released", winner, reservation)
				r.pub.Publish(room, frame, actor)
			}
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
		handoverAt: c.HandoverAt, winner: c.HandoverWinner(),
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
	frame := leaseFrame(c, now)
	frame["type"] = "lease"
	frame["state"] = "held"
	if sameShared(before, after) {
		r.pub.PublishTo(room, c.Agent, frame, actor)
	} else {
		r.pub.Publish(room, frame, actor)
	}
}

func (r *Registry) emitNew(room string, c *Claim, now float64, actor Conn) {
	frame := leaseFrame(c, now)
	frame["type"] = "lease"
	frame["state"] = "held"
	r.pub.Publish(room, frame, actor)
}
