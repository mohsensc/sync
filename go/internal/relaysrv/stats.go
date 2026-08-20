package relaysrv

import "github.com/mohsensc/sync/go/internal/metrics"

// -- the "stats" frame -------------------------------------------------
//
// presenced and agent-presence-mcp run on a developer's laptop with
// nothing Prometheus can reach (see the metrics package doc comment) and
// their own local metrics.Registry to show for it. A "stats" frame is how
// one of them hands the relay what it would otherwise be exposing on its
// own /metrics: a snapshot of that daemon's counters, folded into this
// relay's own registry so the whole system answers from the one endpoint
// an operator actually runs.
//
// This shape is not this file's own invention: it mirrors the producer
// already landed at internal/daemon/stats.go (a different agent's file,
// read but not owned here) field for field, JSON tag for JSON tag. That
// file's own doc comment on statsFrame is the wire contract; this is the
// consumer for it.
//
// Cumulative, not delta: every field below except lease_cache_diverge is
// "how many since this daemon's process started," the same shape a plain
// Prometheus counter already has, rather than "how many since the last
// report." That is the daemon side's choice, not this one's — see its
// own reasoning — and it pushes the bookkeeping this side needs: to fold
// a cumulative counter without a per-daemon label (bounded cardinality;
// see the metrics package doc), this relay has to remember what each
// live connection last reported and add the difference. daemonBaselines
// is exactly that memory, keyed by Conn and cleared on Leave — it is
// process-local bookkeeping, not a metric, so it never becomes a label
// and never outlives the connection it describes. A cumulative field
// smaller than the last report means the daemon's own process restarted
// (its counters reset to zero on its side); the delta folded in that
// case is the new report's value as-is, not a negative number.
//
// Not folded here, and why:
//
//   - decide_count / decide_sum_seconds / decide_bucket_bounds /
//     decide_bucket_counts (ap_decide_duration_seconds): a histogram
//     delta can't be folded through Registry's typed recorders the way a
//     counter delta can (Histogram exposes only Observe(v), not a way to
//     import pre-aggregated bucket counts), and reconstructing individual
//     observations from cumulative per-bucket counts is not the kind of
//     thing to improvise under "code against it, do not redesign it" —
//     folding this needs either a Registry API this package cannot add on
//     its own, or a second Collector this relay registers to re-expose
//     the daemon's own bucket counts directly. Left for that decision.
//   - daemon_connected: a daemon's own instantaneous 0/1, not cumulative
//     by the producer's own comment. Averaging or summing N daemons' up/
//     down bit into the one shared ap_daemon_connected gauge would report
//     a number with no meaning — that gauge is the daemon's own to serve,
//     whenever it gets an endpoint of its own. This relay uses a stats
//     frame's mere arrival, not this field's value, as its own signal
//     that the connection is a daemon (see markDaemon).
//
// lease_cache_diverge is the one already-instantaneous field: Set, not
// added, straight from the latest report. ap_lease_cache_divergence is a
// single shared gauge with no per-daemon label, so — the same limitation
// SendQueueDepth would have without the live-connection sampling server.go
// does for it — the last daemon to report wins; there is no compare-and-
// swap on a Prometheus gauge to do better without tracking every live
// daemon's own value, which this field was not asked for and isn't worth
// the bookkeeping on its own.
type daemonBaseline struct {
	reconnects, coalesceAdmitted, coalesceDropped uint64
	journalWrites, journalTrims                   uint64
	regionKeysRelative, regionKeysAbsolute        uint64
	outboundDropped                               uint64
}

// onStats folds one daemon's cumulative counters into this relay's
// registry. Called only from dispatch, which already refuses anything
// from a connection that never joined (room == "" returns before this is
// ever reached) — that guard is what keeps this from being a way to post
// metrics without authenticating first, so this needs no join check of
// its own.
func (r *Relay) onStats(conn Conn, msg map[string]any) {
	r.markDaemon(conn)

	r.statsMu.Lock()
	before, seen := r.statsSeen[conn]
	if !seen {
		before = daemonBaseline{}
	}
	after := daemonBaseline{
		reconnects:         statU64(msg["reconnects"], before.reconnects),
		coalesceAdmitted:   statU64(msg["coalesce_admitted"], before.coalesceAdmitted),
		coalesceDropped:    statU64(msg["coalesce_dropped"], before.coalesceDropped),
		journalWrites:      statU64(msg["journal_writes"], before.journalWrites),
		journalTrims:       statU64(msg["journal_trims"], before.journalTrims),
		regionKeysRelative: statU64(msg["region_keys_relative"], before.regionKeysRelative),
		regionKeysAbsolute: statU64(msg["region_keys_absolute"], before.regionKeysAbsolute),
		outboundDropped:    statU64(msg["outbound_dropped"], before.outboundDropped),
	}
	if r.statsSeen == nil {
		r.statsSeen = make(map[Conn]daemonBaseline)
	}
	r.statsSeen[conn] = after
	r.statsMu.Unlock()

	// Folded as a delta in one Add, never a loop: the bound would be a
	// number an untrusted peer chose. (see metrics.go's typed recorders —
	// there is no Add(n) for a CounterVec, and this package does not get
	// to add one), so folding a delta > 1 means calling it that many
	// times. deltaU64 already caps at what the field itself allows
	// (uint64, off the wire via statU64), which is a real bound but a
	// generous one; a connection cannot single-handedly stall this
	// goroutine for long even at the top of that range in practice, since
	// a real daemon reports every tens of seconds, not once with a
	// lifetime's counters saved up.
	r.metrics.Reconnects.Add(float64(deltaU64(before.reconnects, after.reconnects)))
	r.metrics.CoalesceAdd(metrics.AdmitAdmitted, float64(deltaU64(before.coalesceAdmitted, after.coalesceAdmitted)))
	r.metrics.CoalesceAdd(metrics.AdmitDropped, float64(deltaU64(before.coalesceDropped, after.coalesceDropped)))
	r.metrics.JournalWrites.Add(float64(deltaU64(before.journalWrites, after.journalWrites)))
	r.metrics.JournalTrims.Add(float64(deltaU64(before.journalTrims, after.journalTrims)))
	r.metrics.RegionKeyAdd(metrics.ShapeRelative, float64(deltaU64(before.regionKeysRelative, after.regionKeysRelative)))
	r.metrics.RegionKeyAdd(metrics.ShapeAbsolute, float64(deltaU64(before.regionKeysAbsolute, after.regionKeysAbsolute)))
	r.metrics.OutboundDropped.Add(float64(deltaU64(before.outboundDropped, after.outboundDropped)))

	if v, ok := msg["lease_cache_diverge"].(float64); ok && v >= 0 {
		r.metrics.LeaseCacheDiverge.Set(v)
	}
}

// markDaemon counts this connection toward DaemonsConnected the first
// time it reports stats, and only the first time — a connection that
// reports stats every 30s for the life of a session is still one
// daemon, not one per report. Leave (relay.go) is the matching decrement,
// keyed off the same map so it only fires for a connection this ever
// actually incremented.
func (r *Relay) markDaemon(conn Conn) {
	r.identityMu.Lock()
	already := r.daemons[conn]
	if !already {
		r.daemons[conn] = true
	}
	r.identityMu.Unlock()
	if !already {
		r.metrics.DaemonsConnected.Add(1)
	}
}

// forgetDaemonBaseline drops a departed connection's remembered counters.
// Called from Leave alongside the daemons-map cleanup; process-local
// bookkeeping, not a metric, so nothing needs decrementing here — this is
// purely "stop remembering a connection that is gone," the delta-folding
// twin of Leave un-marking DaemonsConnected.
func (r *Relay) forgetDaemonBaseline(conn Conn) {
	r.statsMu.Lock()
	delete(r.statsSeen, conn)
	r.statsMu.Unlock()
}

// deltaU64 is a cumulative counter's forward movement since the last
// report. current < before means the daemon's own process restarted
// (its counter reset to zero on its side, per statsFrame's doc comment),
// in which case current is itself the whole delta — treating it as a
// negative movement would silently lose however much work that restarted
// daemon has already reported doing.
func deltaU64(before, current uint64) uint64 {
	if current < before {
		return current
	}
	return current - before
}

// statU64 reads one cumulative field off the wire: a non-negative,
// integral JSON number. Anything else (missing, wrong type, negative,
// fractional, NaN/Inf) is not trusted and this field simply does not
// move this report — returning the fallback rather than erroring the
// whole frame over one malformed number, same policy CleanRegionDict and
// friends already use for inbound cleaning.
func statU64(v any, fallback uint64) uint64 {
	n, ok := v.(float64)
	if !ok || n < 0 || n != n || n > 1e18 || n != float64(int64(n)) {
		return fallback
	}
	return uint64(n)
}
