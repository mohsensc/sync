// Package metrics is every number this system reports about itself.
//
// One registry, defined here in full, so the catalogue is a thing you can
// read in one sitting rather than something you reconstruct by grepping for
// counter names. Every subsystem takes a *Registry and calls a method on it;
// nothing else in the repo imports a metrics library.
//
// # Where the numbers come from, and why
//
// presenced runs on a developer's laptop and gorelay runs somewhere central.
// Prometheus cannot scrape a laptop behind NAT, so the daemons do not expose
// an endpoint at all: they push a small stats frame up the websocket they
// already hold to the relay, and the relay — which is reachable, and is the
// one process an operator actually runs — exposes /metrics for everyone.
//
// That shape is not an optimisation. Scraping laptops would mean a network
// path per developer, credentials on every machine, and telemetry about which
// files people are editing leaving their laptop by a route nobody reviewed.
// The relay already terminates that connection and already redacts what
// crosses it (see relaysrv/redact.go), so it is the honest place to aggregate.
//
// # Two rules that keep this from becoming a liability
//
// **No user data in labels, ever.** Not a path, not an intent, not a human
// name, not an agent id. Those are the payload this whole product is careful
// about, and a label is the least careful place in a monitoring system — it
// lands in a time-series database, gets replicated, and outlives the thing it
// described. Rung, effect, outcome and verb are enumerations with a handful of
// values each; that is the whole allowed vocabulary. Room ids are already
// hashes and are still kept out of labels, because a room id plus a timestamp
// identifies a team.
//
// **Bounded cardinality.** Every label below has a small fixed domain. There
// is deliberately no per-daemon or per-agent label: developers come and go,
// and a label that grows with them turns a time-series database into a bill
// and then into an outage. Per-daemon detail belongs in the relay's status
// JSON, which is a point-in-time answer nobody stores.
package metrics

import (
	"net/http"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Effect names, rung numbers and outcome words are the only label values this
// package ever emits. Kept as constants so a typo is a compile error rather
// than a second time series that looks almost like the first one.
const (
	OutcomeGranted  = "granted"
	OutcomeRefused  = "refused"
	OutcomeExpired  = "expired"
	OutcomeHandover = "handover"
	OutcomeAbort    = "abort"

	ShapeRelative = "relative"
	ShapeAbsolute = "absolute"

	AdmitAdmitted = "admitted"
	AdmitDropped  = "dropped"
)

// decideBuckets straddle the hook's 5ms budget rather than Prometheus's
// defaults, which start at 5ms and would put every healthy decision in the
// first bucket. The interesting question here is not "is it under a second",
// it is "what fraction of decisions are past 5ms", and that needs resolution
// on both sides of it.
var decideBuckets = []float64{
	0.0001, 0.00025, 0.0005, 0.001, 0.0025, 0.005, 0.0075, 0.01, 0.025, 0.05, 0.1,
}

// wireBuckets cover a network round trip to the relay and back.
var wireBuckets = []float64{
	0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5,
}

// Registry is the whole catalogue. Construct one per process.
type Registry struct {
	reg *prometheus.Registry

	// -- latency ------------------------------------------------------
	// The one that can silently break the product: the hook blocks Claude
	// Code on this and fails open past its budget, so a regression here
	// reads to a user as "collision detection stopped working" rather than
	// as slowness.
	DecideDuration  prometheus.Histogram
	ClaimRoundtrip  prometheus.Histogram
	BroadcastFanout prometheus.Histogram
	PolicyReload    prometheus.Histogram

	// -- the ladder, which is the product working or not ---------------
	decisions     *prometheus.CounterVec // rung, effect
	leases        *prometheus.CounterVec // outcome
	RedundantWork prometheus.Counter

	// -- availability --------------------------------------------------
	RelayConnections prometheus.Gauge
	Rooms            prometheus.Gauge
	DaemonConnected  prometheus.Gauge // 0 or 1, reported by each daemon
	DaemonsConnected prometheus.Gauge // how many daemons the relay holds
	Reconnects       prometheus.Counter

	// -- consistency: the ways this system can quietly disagree with
	//    itself, which is the class of bug that shipped ---------------
	regionKeys        *prometheus.CounterVec // shape
	RoomSplits        prometheus.Counter
	LeaseCacheDiverge prometheus.Gauge
	PeerClockSkew     prometheus.Histogram

	// -- the MCP surface ------------------------------------------------
	mcpCalls    *prometheus.CounterVec // tool, outcome
	mcpDuration *prometheus.HistogramVec

	// -- saturation ------------------------------------------------------
	SendQueueDepth prometheus.Gauge
	framesDropped  *prometheus.CounterVec // reason
	JournalWrites  prometheus.Counter
	JournalTrims   prometheus.Counter
	coalesce       *prometheus.CounterVec // outcome
}

// New builds the catalogue. The Go runtime and process collectors come along
// for free and are exactly the saturation signals worth having — goroutines,
// heap, GC pause, open file descriptors — measured by people who got the
// details right, rather than approximated here.
func New() *Registry {
	reg := prometheus.NewRegistry()
	reg.MustRegister(collectors.NewGoCollector())
	reg.MustRegister(collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}))

	r := &Registry{reg: reg}

	hist := func(name, help string, buckets []float64) prometheus.Histogram {
		h := prometheus.NewHistogram(prometheus.HistogramOpts{
			Name: name, Help: help, Buckets: buckets,
		})
		reg.MustRegister(h)
		return h
	}
	counter := func(name, help string) prometheus.Counter {
		c := prometheus.NewCounter(prometheus.CounterOpts{Name: name, Help: help})
		reg.MustRegister(c)
		return c
	}
	gauge := func(name, help string) prometheus.Gauge {
		g := prometheus.NewGauge(prometheus.GaugeOpts{Name: name, Help: help})
		reg.MustRegister(g)
		return g
	}
	counterVec := func(name, help string, labels ...string) *prometheus.CounterVec {
		c := prometheus.NewCounterVec(prometheus.CounterOpts{Name: name, Help: help}, labels)
		reg.MustRegister(c)
		return c
	}

	r.DecideDuration = hist("ap_decide_duration_seconds",
		"Time to answer one hook decision from the local lease cache. The hook's budget is 5ms and it fails open past it.",
		decideBuckets)
	r.ClaimRoundtrip = hist("ap_claim_roundtrip_seconds",
		"Time from sending a claim to the relay's verdict.", wireBuckets)
	r.BroadcastFanout = hist("ap_broadcast_fanout_seconds",
		"Time to fan one frame out to every member of a room.", wireBuckets)
	r.PolicyReload = hist("ap_policy_reload_seconds",
		"Time to re-read and recompile the policy after a change on disk.", wireBuckets)

	r.decisions = counterVec("ap_decisions_total",
		"Hook decisions, by ladder rung and the effect policy resolved.", "rung", "effect")
	r.leases = counterVec("ap_leases_total",
		"Lease lifecycle events, by outcome.", "outcome")
	r.RedundantWork = counter("ap_redundant_work_total",
		"Rung-4 hits: two agents found to be doing the same work in different files.")

	r.RelayConnections = gauge("ap_relay_connections",
		"Websocket connections the relay currently holds.")
	r.Rooms = gauge("ap_rooms", "Rooms with at least one member.")
	r.DaemonConnected = gauge("ap_daemon_connected",
		"1 when this daemon has a live relay connection, 0 otherwise.")
	r.DaemonsConnected = gauge("ap_daemons_connected",
		"Daemons currently reporting to this relay.")
	r.Reconnects = counter("ap_relay_reconnects_total",
		"Times a daemon re-established its relay connection after losing it.")

	r.regionKeys = counterVec("ap_region_keys_total",
		"Region keys seen on the wire, by shape. An absolute key cannot match a "+
			"teammate's, so anything but zero on 'absolute' means collision "+
			"detection has silently stopped working across checkouts.", "shape")
	r.RoomSplits = counter("ap_room_splits_total",
		"Times two clients derived different room ids from the same origin remote.")
	r.LeaseCacheDiverge = gauge("ap_lease_cache_divergence",
		"Leases a daemon believes in that the relay does not, measured at reconcile.")
	r.PeerClockSkew = hist("ap_peer_clock_skew_seconds",
		"Difference between a frame's own timestamp and its arrival time. Lease "+
			"and presence TTLs are wall-clock, and nothing here disciplines it.",
		[]float64{0.1, 0.5, 1, 5, 15, 30, 60, 300, 3600})

	r.mcpCalls = counterVec("ap_mcp_calls_total",
		"MCP tool calls, by tool and outcome.", "tool", "outcome")
	r.mcpDuration = prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "ap_mcp_duration_seconds",
		Help:    "Time to serve one MCP tool call.",
		Buckets: wireBuckets,
	}, []string{"tool"})
	reg.MustRegister(r.mcpDuration)

	r.SendQueueDepth = gauge("ap_send_queue_depth",
		"Frames queued for the slowest consumer the relay is writing to.")
	r.framesDropped = counterVec("ap_frames_dropped_total",
		"Frames the relay gave up on delivering, by reason.", "reason")
	r.JournalWrites = counter("ap_journal_writes_total", "Decision journal records written.")
	r.JournalTrims = counter("ap_journal_trims_total", "Times the journal was trimmed.")
	r.coalesce = counterVec("ap_coalesce_total",
		"Hook events the coalescer admitted or dropped as duplicates.", "outcome")

	return r
}

// Handler serves the Prometheus text exposition format. Mount it on an
// address an operator chooses; there is deliberately no default, because a
// metrics endpoint that appears on a well-known port without anybody asking
// is a way to leak a room's shape to whoever is on the same network.
func (r *Registry) Handler() http.Handler {
	return promhttp.HandlerFor(r.reg, promhttp.HandlerOpts{})
}

// Gatherer exposes the registry for a test, or for a caller that wants to
// forward these to something other than an HTTP scrape.
func (r *Registry) Gatherer() prometheus.Gatherer { return r.reg }

// -- typed recorders ---------------------------------------------------
//
// Every call site goes through one of these rather than touching a
// CounterVec directly, so label values can only ever come from the constants
// above and a new one is a compile error, not a silent second time series.

// Decision records one hook decision. rung is 0-4; effect is a policy effect
// name. Neither the path nor the intent is recorded, on purpose — see the
// package comment.
func (r *Registry) Decision(rung int, effect string) {
	r.decisions.WithLabelValues(rungLabel(rung), effect).Inc()
}

// Lease records a lease lifecycle event. outcome must be one of the
// Outcome constants.
func (r *Registry) Lease(outcome string) { r.leases.WithLabelValues(outcome).Inc() }

// RegionKey records the shape of one region key as it went on the wire.
// This is the live regression detector for the bug where a region was named
// by its absolute filesystem path and two checkouts of one repo therefore
// never collided.
func (r *Registry) RegionKey(shape string) { r.regionKeys.WithLabelValues(shape).Inc() }

// MCPCall records one tool call and how long it took.
func (r *Registry) MCPCall(tool, outcome string, d time.Duration) {
	r.mcpCalls.WithLabelValues(tool, outcome).Inc()
	r.mcpDuration.WithLabelValues(tool).Observe(d.Seconds())
}

// FrameDropped records a frame the relay could not deliver.
func (r *Registry) FrameDropped(reason string) { r.framesDropped.WithLabelValues(reason).Inc() }

// Coalesce records whether a hook event was admitted or dropped as a
// duplicate.
func (r *Registry) Coalesce(outcome string) { r.coalesce.WithLabelValues(outcome).Inc() }

// The Add forms exist for one caller: the relay folding a daemon's report,
// which arrives as a cumulative total and turns into a delta.
//
// They are not a convenience. Without them the only way to apply a delta was
// to call Inc() in a loop, and the loop bound is a number an untrusted peer
// puts on the wire — so a daemon reporting a large total, whether by bug,
// restart accounting or malice, span the relay's goroutine until the count
// ran out. An offered API that makes the obvious implementation a denial of
// service is the API's bug, not the caller's.
func (r *Registry) RegionKeyAdd(shape string, n float64) {
	r.regionKeys.WithLabelValues(shape).Add(n)
}

// CoalesceAdd is Coalesce for a delta. See RegionKeyAdd.
func (r *Registry) CoalesceAdd(outcome string, n float64) {
	r.coalesce.WithLabelValues(outcome).Add(n)
}

// Observe times fn and reports it to h. Cheap enough for the decision path:
// two monotonic clock reads and a histogram add, no allocation.
func Observe(h prometheus.Histogram, fn func()) {
	start := time.Now()
	fn()
	h.Observe(time.Since(start).Seconds())
}

// rungLabel keeps the rung label's domain to exactly six values. A rung
// outside 0-4 is a bug somewhere upstream, and bucketing it as "other" keeps
// that bug from becoming unbounded cardinality on top of whatever it already
// is.
func rungLabel(rung int) string {
	switch rung {
	case 0:
		return "0"
	case 1:
		return "1"
	case 2:
		return "2"
	case 3:
		return "3"
	case 4:
		return "4"
	}
	return "other"
}
