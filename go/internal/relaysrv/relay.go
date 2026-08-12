package relaysrv

import (
	"log"
	"strings"
	"sync"
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

	roomsMu sync.RWMutex
	rooms   map[string]*roomInfo

	identityMu sync.Mutex
	identity   map[Conn]identityRecord
	principal  map[Conn]principalRecord

	// Builtin plus org floor, and nothing else — see policy.go's package
	// doc comment. policyMu guards policyDigest, which is read and
	// written from Join/Handle on any goroutine; policy itself
	// (*PolicyFile) is already safe for concurrent use on its own.
	policy       *PolicyFile
	policyMu     sync.Mutex
	policyDigest string
}

func NewRelay(clock Clock, roster Roster) *Relay {
	r := &Relay{
		clock:     clock,
		roster:    roster,
		rooms:     make(map[string]*roomInfo),
		identity:  make(map[Conn]identityRecord),
		principal: make(map[Conn]principalRecord),
		policy:    NewPolicyFileForRelay(clock),
	}
	r.registry = NewRegistry(clock, r)
	r.negotiator = NewNegotiator(r.registry)
	r.policyDigest = r.policy.Current().Digest
	if roster.Present() {
		log.Printf("roster %s: %d principal(s), default %s", roster.Source(), roster.PrincipalCount(), PriorityName(roster.DefaultTier()))
	} else {
		log.Printf("no principals roster (%s); every connection joins at %s", roster.Source(), PriorityName(PriorityNormal))
	}
	return r
}

// policyFrame is the org floor, as this relay currently reads it. Only the
// floor travels — effects are the client's business, the relay cannot see
// a client's repo/user/session layers — but a floor composes with
// whatever the client resolved locally by taking the louder of the two.
// nil when there is no org file to state: a relay with nothing configured
// has nothing to say beyond the daemon's own compiled-in floor, and
// test_golden_noop.py-equivalent coverage (golden_test.go) locks down
// that this must not put a frame on the wire nobody configured. Mirrors
// relay.py's _policy_frame.
func (r *Relay) policyFrame() Frame {
	policy := r.policy.Current()
	org := policy.layer(layerOrg)
	if org == nil {
		return nil
	}
	frame := Frame{
		"type":   "policy",
		"floor":  policy.floorTable("").names(),
		"source": "org:" + org.source,
		"digest": policy.Digest,
	}
	if floors := policy.floorRules(); len(floors) > 0 {
		out := make([]any, len(floors))
		for i, f := range floors {
			out[i] = Frame{"match": f.Match, "effects": f.Effects, "layer": f.Layer}
		}
		frame["floors"] = out
	}
	return frame
}

// publishPolicyChange pushes a new org floor to every room, if there is
// one. PolicyFile.Current gates its own stat to once a second, so this
// costs a comparison per frame in the steady state. Mirrors relay.py's
// _publish_policy_change.
func (r *Relay) publishPolicyChange() bool {
	digest := r.policy.Current().Digest
	r.policyMu.Lock()
	changed := digest != r.policyDigest
	if changed {
		r.policyDigest = digest
	}
	r.policyMu.Unlock()
	if !changed {
		return false
	}
	frame := r.policyFrame()
	if frame == nil {
		// The org file went away. The floor drops back to the compiled-in
		// one, which every daemon already has, so there is nothing to send.
		return false
	}
	log.Printf("org policy changed (%s); republishing the floor", shortDigest(digest))
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

	// One connection, one room membership.
	r.roomsMu.RLock()
	for _, ri := range r.rooms {
		ri.mu.Lock()
		ri.members = removeConn(ri.members, conn)
		ri.mu.Unlock()
	}
	r.roomsMu.RUnlock()

	// Before the joiner is a member, so a change picked up here fans out
	// to the room that already exists and the joiner gets its own copy
	// below rather than two.
	r.publishPolicyChange()

	conn.SetRoom(room)
	ri := r.roomOf(room)
	ri.mu.Lock()
	ri.members = append(ri.members, conn)
	ri.mu.Unlock()

	r.sendLeaseSnapshot(conn, room)
	// Only when there is an org policy to state — see policyFrame's doc
	// comment on why a relay with nothing configured must stay silent.
	if frame := r.policyFrame(); frame != nil {
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
	for _, other := range toEvict {
		r.Leave(other)
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
	r.roomsMu.RLock()
	for _, ri := range r.rooms {
		ri.mu.Lock()
		ri.members = removeConn(ri.members, conn)
		ri.mu.Unlock()
	}
	r.roomsMu.RUnlock()

	r.identityMu.Lock()
	identity, hadIdentity := r.identity[conn]
	delete(r.identity, conn)
	delete(r.principal, conn)
	r.identityMu.Unlock()

	if hadIdentity && room != "" {
		r.registry.ReleaseAll(room, identity.agent, nil)
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
	for _, c := range targets {
		c.Send(encoded)
	}
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
	switch kind {
	case "claim", "contend", "release", "heartbeat", "move":
	default:
		return nil
	}

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
		var splitScope *Region
		if sc, ok := CleanRegionDict(msg["split_region"]); ok {
			splitScope = &sc
		}
		move, _ := msg["move"].(string)
		outcome := r.negotiator.Apply(room, conn.Agent(), region, move, CleanIntent(msg["reason"]), splitScope, r.priorityOf(conn), conn)
		reply := Frame{"type": "move_result", "granted": outcome.Granted, "action": outcome.Action}
		if outcome.Error != "" {
			reply["error"] = outcome.Error
		}
		return reply
	}
	return nil
}

func (r *Relay) onEvent(room string, conn Conn, msg map[string]any) Frame {
	clean := RedactEvent(msg)
	now := r.clock.Now()

	ri := r.roomOf(room)
	ri.mu.Lock()
	ri.lastTs = now
	ri.hasLastTs = true
	ri.mu.Unlock()

	// regionPayload returns the named Frame type, not a bare map[string]any
	// — a type assertion has to match the concrete type exactly, so this
	// has to assert Frame, not the interface it happens to satisfy.
	regionRaw, _ := clean["region"].(Frame)
	region := regionFromPayload(regionRaw)
	verb, _ := clean["verb"].(string)
	// Hooks never carry one; only an MCP-sourced event does, and only that
	// kind can reach rung 4.
	intent := CleanIntent(clean["intent"])

	event := AgentEvent{Room: room, Human: conn.Human(), Agent: conn.Agent(), Kind: "touch",
		Source: ParseSource(cleanString(clean["source"])), Verb: verb, Region: region, Ts: now}

	others := r.presence(room)
	rung := Classify(event, others, intent)

	ri.mu.Lock()
	ri.activity = append(ri.activity, timedActivity{now, Activity{
		Agent: conn.Agent(), Human: conn.Human(), Verb: verb, Region: region,
		Intent: intent, Source: event.Source,
	}})
	ri.mu.Unlock()

	r.Broadcast(room, Frame{
		"type": "presence", "agent": conn.Agent(), "human": conn.Human(),
		"verb": verb, "region": clean["region"], "rung": rung, "ts": now,
	}, conn)

	// Policy decides how loudly this rung is told. It does not decide the
	// rung, and it never reaches the lease table: Classify above and
	// Negotiator.Open below run exactly as they did before, whatever the
	// effect turns out to be. Mirrors relay.py's _on_event.
	resolution := r.resolvePolicy(conn, rung, region.Path)
	effect := resolution.Effect

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
		frame["handover_in_ms"] = msRemaining(*brief.HandoverAt, now)
		frame["handover_to"] = brief.HandoverTo
		if brief.HandoverTo == conn.Agent() {
			frame["retry_in_ms"] = frame["handover_in_ms"]
			frame["reserved_for_ms"] = int(ReservationS * 1000)
		}
		held := r.registry.HolderOf(room, region, conn)
		if held != nil {
			lf := leaseFrame(held, now)
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
	held := r.registry.Contend(room, region, conn.Agent(), conn.Human(), r.priorityOf(conn), nil, conn)
	if held == nil {
		return
	}
	f := leaseFrame(held, r.clock.Now())
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
		for k, v := range leaseFrame(result.Claim, now) {
			granted[k] = v
		}
		// The lease is granted either way. Rung 4 is not contention — the
		// paths are disjoint — it is the news that somebody else already
		// declared this work, delivered while the agent is still
		// deciding what to do. Same volume knob as the event path.
		rung4Effect := r.resolvePolicy(conn, 4, region.Path).Effect
		if rung4Effect != EffectSilent {
			if red := r.checkRedundancy(room, conn.Agent(), conn.Human(), region, intent); red != nil {
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

	winner := held.HandoverWinner()
	if held.HandoverAt != nil && winner != nil {
		handoverInMs := msRemaining(*held.HandoverAt, now)
		reply["handover_in_ms"] = handoverInMs
		reply["handover_at"] = *held.HandoverAt
		reply["handover_to"] = winner.Agent
		reply["handover_to_human"] = winner.Human
		reply["handover_to_priority"] = PriorityName(winner.Priority)
		reply["waiting"] = len(held.Contenders)
		if winner.Agent == conn.Agent() {
			reply["retry_in_ms"] = handoverInMs
			reply["reserved_for_ms"] = int(ReservationS * 1000)
		}
	}
	return reply
}
