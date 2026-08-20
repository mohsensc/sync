// Package daemon wires the hook sockets, the relay client and the local
// state (leases, policy, presence, journal) together — the Go mirror of
// cpp/daemon/main.cpp.
package daemon

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/mohsensc/sync/go/internal/coalesce"
	"github.com/mohsensc/sync/go/internal/contend"
	"github.com/mohsensc/sync/go/internal/decide"
	"github.com/mohsensc/sync/go/internal/hooksock"
	"github.com/mohsensc/sync/go/internal/journal"
	"github.com/mohsensc/sync/go/internal/leases"
	"github.com/mohsensc/sync/go/internal/metrics"
	"github.com/mohsensc/sync/go/internal/policy"
	"github.com/mohsensc/sync/go/internal/presence"
	"github.com/mohsensc/sync/go/internal/relay"
	"github.com/mohsensc/sync/go/internal/repo"
	"github.com/mohsensc/sync/go/internal/wire"
)

// noopObserver stands in for DecideDuration when no Registry is configured.
// A package-level singleton, not a per-daemon allocation: onRequest resolves
// which Observer to call once, in New, so the decision path itself never
// branches on whether metrics are on — see Options.Metrics.
var noopObserver prometheus.Observer = prometheus.ObserverFunc(func(float64) {})

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

	// statsTickMs is how often a stats frame goes up to the relay — tens
	// of seconds, not per event, same reasoning as snapshotTickMs but
	// slower: this is fleet-wide observability, not a file a person is
	// staring at. See daemon.pushStats and stats.go's frame shape.
	statsTickMs = 30_000
)

type Options struct {
	// Sock is the hook event socket path. Required. Decisions are served
	// on Sock+".decide" — see hook/protocol.hpp's decision_sock_path,
	// which both the C++ hook and this daemon derive it with.
	Sock string

	// RelayURL is ws://host:port or wss://host:port. Empty, or an empty
	// Room, means no relay connection — same "no room, no relay" rule
	// main.cpp applies.
	RelayURL string
	Room     string
	Agent    string
	Human    string

	// Root is the repo root this checkout was found under — the same root
	// repo.DiscoverRoom already walked to derive Room, carried here so
	// every path a hook sends can be turned into the region key every
	// checkout of this repo agrees on (repo.RegionKey). Empty means New
	// resolves it itself from the process's cwd: the caller is free to
	// pass it explicitly (tests do), but a daemon nobody wired this for
	// must not silently fall back to the raw-absolute-path bug this field
	// exists to close.
	Root string

	Principal  string
	Token      string
	Unattended bool

	// RelayTLSCAFile and RelayTLSInsecureSkipVerify are only consulted
	// when RelayURL is wss://. See relay.Config's fields of the same
	// name — this is a straight pass-through.
	RelayTLSCAFile             string
	RelayTLSInsecureSkipVerify bool

	// Snapshot is the file the statusline reads. Empty disables writing
	// it (and the daemon's tick loop keeps running regardless — a policy
	// refresh doesn't depend on the statusline mattering to anyone).
	Snapshot string
	// PolicyCache is what `ap policy compile` writes. Empty means the
	// daemon answers off the compiled-in table for its whole life.
	PolicyCache string
	// Journal is where `ap why` reads from. Empty disables recording.
	Journal string

	// Metrics is where this daemon's numbers go — the decision-path
	// histogram, relay connection state, the coalescer, the journal, and
	// (via periodic stats frames — see daemon.tick) the numbers gorelay's
	// own /metrics ends up serving on this daemon's behalf, since a laptop
	// behind NAT cannot be scraped directly.
	//
	// Nil is a real, supported state, not "metrics forgotten": every
	// call site off the decision path checks it directly (a nil check
	// nobody would ever measure), and onRequest resolves DecideDuration to
	// a single no-op Observer once, here in New, rather than branching on
	// every decision — see noopObserver. A daemon built without a Registry
	// costs nothing for not having brought one.
	Metrics *metrics.Registry
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

	// metrics is nil-safe at every call site below except decideObs (see
	// Options.Metrics); decideObs is what onRequest actually calls, so the
	// decision path never tests metrics itself.
	metrics   *metrics.Registry
	decideObs prometheus.Observer

	dirty atomic.Bool

	// closeOnce and done make Close idempotent and let it block until the
	// shutdown sequence — see shutdown — has actually finished, whether it
	// was triggered by ctx being cancelled or by a caller invoking Close
	// directly (tests do the latter). Without this, main.go had nothing to
	// wait on: it returned as soon as ctx.Done() fired, racing the
	// goroutine that stops the sockets and drains the journal — see #144.
	closeOnce sync.Once
	done      chan struct{}
}

// New builds and starts the hook sockets, and starts the relay connection
// in the background when RelayURL and Room are both set. The returned
// Daemon must be stopped by cancelling ctx.
func New(ctx context.Context, opts Options) (*Daemon, error) {
	// Resolved once, here, rather than shelled out to git per request —
	// the 5ms decision budget can't absorb a fork. An explicit opts.Root
	// (tests, and eventually main.go alongside its DiscoverRoom call) wins
	// outright; otherwise this is the same cwd main.go already walks to
	// derive Room, so a daemon started the ordinary way still gets one.
	if opts.Root == "" {
		if cwd, err := os.Getwd(); err == nil {
			if root, ok := repo.FindRepoRoot(cwd); ok {
				opts.Root = root
			}
		}
	}

	d := &Daemon{
		opts:      opts,
		leases:    leases.New(),
		policy:    policy.New(),
		presence:  presence.NewTable(presenceTTLMs),
		contend:   contend.New(),
		coalescer: coalesce.New(coalesceWindowMs, coalesceMaxPerWin),
		metrics:   opts.Metrics,
		decideObs: noopObserver,
		done:      make(chan struct{}),
	}
	if opts.Metrics != nil {
		d.decideObs = opts.Metrics.DecideDuration
	}

	if opts.Journal != "" {
		d.journal = journal.New(opts.Journal, opts.Metrics)
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

			TLSCAFile:             opts.RelayTLSCAFile,
			TLSInsecureSkipVerify: opts.RelayTLSInsecureSkipVerify,

			Metrics: opts.Metrics,
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
		d.shutdown()
	}()

	return d, nil
}

// shutdown stops both hooksock servers and drains the journal, exactly
// once regardless of how many times it's called or from where — ctx being
// cancelled and an explicit Close() both funnel through here, so there is
// only ever one Stop() call per server. done is closed last so Close can
// block until this has actually finished.
func (d *Daemon) shutdown() {
	d.closeOnce.Do(func() {
		d.eventSock.Stop()
		d.decideSock.Stop()
		if d.journal != nil {
			d.journal.Stop()
		}
		close(d.done)
	})
}

// Close runs (or waits for) the full shutdown sequence and blocks until it
// has finished — see #144: main used to return as soon as ctx was
// cancelled, racing the goroutine above to Stop() the sockets and journal,
// which made PR #124's journal stop-drain unreachable in production.
// Callers that already have a ctx to cancel should still do that (it's
// what unblocks everything else keyed off ctx, like the tick loop and the
// relay client); Close is what makes waiting for the daemon-owned part of
// shutdown possible at all.
//
// Honest residual: hooksock doesn't track in-flight serveConn goroutines,
// so a decision request that was already accepted when shutdown began can
// still race Stop() and never make it into the journal.
func (d *Daemon) Close() {
	d.shutdown()
	<-d.done
}

// tick is main.cpp's for(;;) loop, minus the socket poll — hooksock's
// per-connection goroutines make that unnecessary. What is left: draining
// what decisions blocked on, stepping policy, expiring presence and writing
// the snapshot.
func (d *Daemon) tick(ctx context.Context) {
	ticker := time.NewTicker(tickInterval)
	defer ticker.Stop()

	lastWrite := nowMs()
	lastStats := nowMs()
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

			if t-lastStats >= statsTickMs {
				d.pushStats()
				lastStats = t
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
		if frame := decide.ContendFrame(path, d.opts.Root); frame != nil {
			if d.metrics != nil {
				d.metrics.RegionKey(regionShape(repo.RegionKeyResolved(d.opts.Root, path)))
			}
			d.relay.SendText(frame)
		}
	}
}

func (d *Daemon) admitCoalesce(e coalesce.Ev, nowMs int64) bool {
	d.coalesceMu.Lock()
	admitted := d.coalescer.Admit(e, nowMs)
	d.coalesceMu.Unlock()

	// Recorded outside the lock: nothing about a Prometheus counter add
	// needs coalesceMu, and this is one-way relay traffic, never the
	// decision path (see coalesceMu's own comment above).
	if d.metrics != nil {
		outcome := metrics.AdmitDropped
		if admitted {
			outcome = metrics.AdmitAdmitted
		}
		d.metrics.Coalesce(outcome)
	}
	return admitted
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
	// The same region key that goes on the wire, not the raw hook path.
	// presence.Table compares a local entry's path against a peer's to spot
	// rung 1 ("one reading while another edits"), and a peer's path arrived
	// already repo-relative — an absolute local path could never match it.
	// Computed once and reused below for the metric, rather than a second
	// call into repo.RegionKeyResolved just to learn its shape.
	regionKey := repo.RegionKeyResolved(d.opts.Root, req.Path)
	if d.presence.Touch(req.Agent, human, req.Verb, regionKey, nowMs()) {
		d.dirty.Store(true)
	}

	if d.relay == nil {
		return
	}
	if !d.admitCoalesce(coalesce.Ev{Verb: req.Verb, Path: req.Path, Agent: req.Agent}, nowMs()) {
		return
	}
	if frame := decide.EventFrame(req, d.opts.Root); frame != nil {
		if d.metrics != nil {
			d.metrics.RegionKey(regionShape(regionKey))
		}
		d.relay.SendText(frame)
	}
}

// regionShape reports whether a region key came out relative to the repo
// root or fell back to an absolute path — see repo.RegionKey's doc comment.
// Its output is always forward-slashed regardless of OS, so a leading "/"
// is the whole test; filepath.IsAbs would ask the wrong question on
// Windows, where an absolute path looks like "C:\\..." instead.
func regionShape(key string) string {
	if strings.HasPrefix(key, "/") {
		return metrics.ShapeAbsolute
	}
	return metrics.ShapeRelative
}

// onRequest answers one hook decision. ap_decide_duration_seconds times
// everything from here to the marshaled response, since that is what
// actually keeps the hook blocked — not just the local-cache lookup inside
// decide.Decide. Timed with two monotonic reads and one Observe call, no
// closure, no allocation of its own: see Options.Metrics for why
// d.decideObs is always safe to call and never itself branches on whether
// a Registry is configured.
func (d *Daemon) onRequest(line []byte) []byte {
	req := decide.ParseRequest(line)
	if !req.WantsDecision() {
		return nil
	}

	start := time.Now()
	resp := decide.Decide(req, d.leases, d.policy, nowMs(), d.selfAgent(), d.opts.Root)
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
	d.decideObs.Observe(time.Since(start).Seconds())
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
