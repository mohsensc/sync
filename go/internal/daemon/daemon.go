// Package daemon wires the hook sockets, the relay client and the local
// state (leases, policy, presence, journal) together — the Go mirror of
// cpp/daemon/main.cpp.
package daemon

import (
	"context"
	"encoding/json"
	"log"
	"sync"
	"sync/atomic"
	"time"

	"github.com/mohsensc/sync/go/internal/coalesce"
	"github.com/mohsensc/sync/go/internal/contend"
	"github.com/mohsensc/sync/go/internal/decide"
	"github.com/mohsensc/sync/go/internal/hooksock"
	"github.com/mohsensc/sync/go/internal/journal"
	"github.com/mohsensc/sync/go/internal/leases"
	"github.com/mohsensc/sync/go/internal/policy"
	"github.com/mohsensc/sync/go/internal/presence"
	"github.com/mohsensc/sync/go/internal/relay"
	"github.com/mohsensc/sync/go/internal/wire"
)

// How long an agent stays on the statusline after its last event, how often
// the snapshot is rewritten even when nothing changed, and the daemon's
// tick — same three constants as main.cpp's kPresenceTtlMs,
// kSnapshotTickMs and kTickMs.
const (
	presenceTTLMs  = 30_000
	snapshotTickMs = 1_000
	tickInterval   = 100 * time.Millisecond

	// Coalescer window: cpp/daemon/main.cpp's Coalescer(1000, 200).
	coalesceWindowMs  = 1000
	coalesceMaxPerWin = 200
)

type Options struct {
	// Sock is the hook event socket path. Required. Decisions are served
	// on Sock+".decide" — see hook/protocol.hpp's decision_sock_path,
	// which both the C++ hook and this daemon derive it with.
	Sock string

	// RelayURL is ws://host:port. Empty, or an empty Room, means no relay
	// connection — same "no room, no relay" rule main.cpp applies.
	RelayURL string
	Room     string
	Agent    string
	Human    string

	Principal  string
	Token      string
	Unattended bool

	// Snapshot is the file the statusline reads. Empty disables writing
	// it (and the daemon's tick loop keeps running regardless — a policy
	// refresh doesn't depend on the statusline mattering to anyone).
	Snapshot string
	// PolicyCache is what `ap policy compile` writes. Empty means the
	// daemon answers off the compiled-in table for its whole life.
	PolicyCache string
	// Journal is where `ap why` reads from. Empty disables recording.
	Journal string
}

// Daemon is a running instance.
type Daemon struct {
	opts       Options
	eventSock  *hooksock.Server
	decideSock *hooksock.Server
	relay      *relay.Client
	leases     *leases.Cache
	policy     *policy.Cache
	presence   *presence.Table
	journal    *journal.Journal
	contend    *contend.Queue

	// Coalescer is not concurrency-safe on its own — cpp/daemon/main.cpp
	// gets that for free from being single-threaded, and every caller here
	// (one goroutine per accepted hook connection, plus the tick loop) is
	// not. This is the one piece of daemon-local state deliberately kept
	// behind a plain mutex rather than a channel-owning goroutine: it sits
	// on one-way relay traffic, never the decision path, so there is
	// nothing here for #20's guarantee to protect.
	coalesceMu sync.Mutex
	coalescer  *coalesce.Coalescer

	dirty atomic.Bool
}

// New builds and starts the hook sockets, and starts the relay connection
// in the background when RelayURL and Room are both set. The returned
// Daemon must be stopped by cancelling ctx.
func New(ctx context.Context, opts Options) (*Daemon, error) {
	d := &Daemon{
		opts:      opts,
		leases:    leases.New(),
		policy:    policy.New(),
		presence:  presence.NewTable(presenceTTLMs),
		contend:   contend.New(),
		coalescer: coalesce.New(coalesceWindowMs, coalesceMaxPerWin),
	}

	if opts.Journal != "" {
		d.journal = journal.New(opts.Journal)
	}

	// Once before the sockets are up, so the first decision of the session
	// already has the current table rather than the builtin one.
	if opts.PolicyCache != "" {
		d.policy.Refresh(opts.PolicyCache, nowMs())
	}

	if opts.RelayURL != "" && opts.Room != "" {
		d.relay = relay.New(relay.Config{
			URL:        opts.RelayURL,
			Room:       opts.Room,
			Agent:      opts.Agent,
			Human:      opts.Human,
			Principal:  opts.Principal,
			Token:      opts.Token,
			Unattended: opts.Unattended,
		}, d.leases)
		d.relay.OnPeer(func(p wire.Presence) {
			if p.Agent == "" {
				return
			}
			who := p.Human
			if who == "" {
				who = p.Agent
			}
			if d.presence.Touch(p.Agent, who, p.Verb, p.Region.Path, nowMs()) {
				d.dirty.Store(true)
			}
		})
		d.relay.OnPolicy(func(floor policy.Table, source string) {
			d.policy.SetFloor(floor, source)
			d.dirty.Store(true)
		})
		go d.relay.Run(ctx)
	} else {
		log.Printf("daemon: no room configured, running with no relay connection")
	}

	d.eventSock = hooksock.New(opts.Sock)
	d.eventSock.OnLine(d.onLine)
	// Still answers decisions here too, same as main.cpp's
	// server.on_request(decide): an older hook that has never heard of
	// the decision socket asks on this one and must keep getting an
	// answer.
	d.eventSock.OnRequest(d.onRequest)
	if err := d.eventSock.Start(); err != nil {
		return nil, err
	}

	// Decisions, on their own socket, so a request cannot end up behind a
	// burst of events in one accept queue and time out unanswered — see
	// hook/protocol.hpp's decision_sock_path and
	// cpp/daemon/decision_server.hpp's comment on the 60% loss rate that
	// motivated the split. The C++ side needed a dedicated thread pool to
	// get this property because its event socket was served by one poll
	// loop; here every accepted connection already gets its own goroutine
	// (see hooksock's package doc), so a second Server on the path is the
	// whole of the port.
	d.decideSock = hooksock.New(opts.Sock + ".decide")
	d.decideSock.OnRequest(d.onRequest)
	if err := d.decideSock.Start(); err != nil {
		// Non-fatal: the event socket still answers decisions, and a hook
		// that cannot connect here falls back to asking there — the same
		// compatibility path an old daemon leaves a new hook on.
		log.Printf("daemon: decision socket unavailable, falling back to the event socket: %v", err)
	}

	if opts.Snapshot != "" {
		// Write once up front so the statusline reads a valid file from
		// the first tick instead of treating a missing file as an error.
		_ = presence.WriteSnapshot(opts.Snapshot, d.presence.Peers(), d.policy.Problem())
	}
	go d.tick(ctx)

	go func() {
		<-ctx.Done()
		d.eventSock.Stop()
		d.decideSock.Stop()
		if d.journal != nil {
			d.journal.Stop()
		}
	}()

	return d, nil
}

// tick is main.cpp's for(;;) loop, minus the socket poll — hooksock's
// per-connection goroutines make that unnecessary. What is left: draining
// what decisions blocked on, stepping policy, expiring presence and writing
// the snapshot.
func (d *Daemon) tick(ctx context.Context) {
	ticker := time.NewTicker(tickInterval)
	defer ticker.Stop()

	lastWrite := nowMs()
	lastProblem := d.policy.Problem()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			d.drainContend()

			t := nowMs()
			if d.opts.PolicyCache != "" {
				d.policy.Refresh(d.opts.PolicyCache, t)
			}
			if problem := d.policy.Problem(); problem != lastProblem {
				lastProblem = problem
				d.dirty.Store(true) // a degradation has to reach the statusline promptly
			}

			if d.presence.Expire(t) {
				d.dirty.Store(true)
			}

			if d.opts.Snapshot != "" && (d.dirty.Load() || t-lastWrite >= snapshotTickMs) {
				_ = presence.WriteSnapshot(d.opts.Snapshot, d.presence.Peers(), lastProblem)
				lastWrite = t
				d.dirty.Store(false)
			}
		}
	}
}

// drainContend tells the relay what decision goroutines were stopped on.
// Through the coalescer like any other relay traffic, so an agent retrying
// the same edit in a loop costs one frame a tick and not one per attempt.
func (d *Daemon) drainContend() {
	if d.relay == nil {
		d.contend.Drain() // nowhere to send it; still clear the queue
		return
	}
	now := nowMs()
	for _, path := range d.contend.Drain() {
		if !d.admitCoalesce(coalesce.Ev{Verb: "contend", Path: path, Agent: d.selfAgent()}, now) {
			continue
		}
		if frame := decide.ContendFrame(path); frame != nil {
			d.relay.SendText(frame)
		}
	}
}

func (d *Daemon) admitCoalesce(e coalesce.Ev, nowMs int64) bool {
	d.coalesceMu.Lock()
	defer d.coalesceMu.Unlock()
	return d.coalescer.Admit(e, nowMs)
}

// selfAgent is the id this daemon joined the room under — see decide.hpp's
// note on why the hook's own "agent" field (a session id) is not the same
// namespace as a lease's holder. Empty when no room is configured.
func (d *Daemon) selfAgent() string {
	if d.relay == nil {
		return ""
	}
	return d.opts.Agent
}

func (d *Daemon) onLine(line []byte) {
	req := decide.ParseRequest(line)
	if req.Agent == "" {
		return
	}

	// The hook has no name for the person driving; fall back to the
	// session id so the statusline still counts a body in the room.
	human := req.Human
	if human == "" {
		human = req.Agent
	}
	if d.presence.Touch(req.Agent, human, req.Verb, req.Path, nowMs()) {
		d.dirty.Store(true)
	}

	if d.relay == nil {
		return
	}
	if !d.admitCoalesce(coalesce.Ev{Verb: req.Verb, Path: req.Path, Agent: req.Agent}, nowMs()) {
		return
	}
	if frame := decide.EventFrame(req); frame != nil {
		d.relay.SendText(frame)
	}
}

func (d *Daemon) onRequest(line []byte) []byte {
	req := decide.ParseRequest(line)
	if !req.WantsDecision() {
		return nil
	}
	resp := decide.Decide(req, d.leases, d.policy, nowMs(), d.selfAgent())
	if decide.BlockedByLease(resp) {
		// Noted here rather than inside Decide, which stays a pure
		// function of the request and the two caches. Both callers — the
		// event socket's compat path and the decision socket — go through
		// this handler, so both feed the queue.
		d.contend.Note(req.Path)
	}
	if d.journal != nil {
		d.journal.Record(journalRecord(req, resp, d.policy))
	}
	out, err := json.Marshal(resp)
	if err != nil {
		return nil
	}
	return out
}

// journalRecord mirrors journal.cpp's reason_for: which side of the policy
// decided, and — when there is one worth naming — the tier the holder's
// lease was taken at.
func journalRecord(req decide.Request, resp decide.Response, pol *policy.Cache) journal.Record {
	origin := pol.Explain(resp.Rung)

	reason := "effect " + origin.Effect.String() + " from "
	switch {
	case origin.FromFloor:
		reason += "the org floor"
		if origin.Source != "" {
			reason += " (" + origin.Source + ")"
		}
	case origin.Source == "":
		reason += "the builtin table"
	default:
		reason += origin.Source
	}
	// "normal" is the default every unrostered room runs at, so saying it
	// would be spending a line to report that nothing unusual happened.
	if resp.HolderPriority != "" && resp.HolderPriority != "normal" {
		reason += "; the holder took it at " + resp.HolderPriority
	}

	return journal.Record{
		AtMs:   wallMs(),
		Rung:   resp.Rung,
		Effect: resp.Effect,
		Path:   req.Path,
		Agent:  req.Agent,
		Holder: resp.Holder,
		Human:  resp.Human,
		Intent: resp.Intent,
		Reason: reason,
	}
}

func nowMs() int64 { return time.Now().UnixMilli() }

// wallMs is the journal's own clock, kept as a separate call from nowMs
// purely for readability at call sites — both are wall time on the Go
// side; see docs/go-daemon.md's clock-source note on the gap from the C++
// side's monotonic/wall split.
func wallMs() int64 { return time.Now().UnixMilli() }
