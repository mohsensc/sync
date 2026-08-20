// Stats-frame push: the daemon's answer to "laptops are not scrapable".
// gorelay exposes /metrics for everyone; this file is how a number that
// only ever happened on somebody's laptop gets there — see
// internal/metrics's package comment for the shape this is built to feed,
// and this file's own comment on statsFrame for the wire contract itself,
// which is not yet in internal/wire (this package does not own it — see
// the report this landed with for why, and for the frame gorelay's own
// handler needs to implement against).
package daemon

import (
	"encoding/json"
	"math"

	dto "github.com/prometheus/client_model/go"

	"github.com/mohsensc/sync/go/internal/metrics"
)

// statsFrame is what pushStats sends. Every numeric field here mirrors one
// counter, gauge or histogram on metrics.Registry — see that package's
// comment for why none of them may ever grow a label, let alone a field,
// that carries a path, a human name or anything else per-user.
//
// Every field below except DaemonConnected and LeaseCacheDiverge is
// process-lifetime cumulative, the same as any Prometheus counter: this is
// a snapshot of "how many since this daemon started," not "how many since
// the last frame." A daemon restart makes its own cumulative fields smaller
// than the frame before — the relay side has no per-daemon label to hang
// delta-tracking state on (bounded cardinality; see internal/metrics), but
// it is free to keep that state in memory, keyed by the live connection,
// same as any other counter-federation consumer: treat a decrease as "this
// daemon just restarted, re-baseline from zero" rather than a negative
// delta.
type statsFrame struct {
	Type string `json:"type"` // "stats"

	// ap_decide_duration_seconds. Bounds and cumulative counts travel
	// together — sum and count alone cannot rebuild a histogram gorelay
	// could re-expose (prometheus.MustNewConstHistogram needs the buckets),
	// and hardcoding metrics.decideBuckets' values here would silently
	// drift the day that package's own buckets change.
	//
	// DecideBucketCounts holds only the finite buckets, same as
	// Prometheus's own wire format: there is no entry for +Inf. The
	// implicit +Inf cumulative count — every observation, bucketed or not
	// — is DecideCount. A reader feeding MustNewConstHistogram wants
	// exactly that split: the finite bounds as the buckets map, DecideCount
	// as the histogram's own count.
	DecideCount        uint64    `json:"decide_count"`
	DecideSumSeconds   float64   `json:"decide_sum_seconds"`
	DecideBucketBounds []float64 `json:"decide_bucket_bounds"`
	DecideBucketCounts []uint64  `json:"decide_bucket_counts"` // cumulative, same order as bounds, no +Inf entry

	// DaemonConnected is 0 or 1, this instant, not cumulative — but a
	// reader should not expect to ever see 0 here: this frame only exists
	// because pushStats just handed it to a live relay connection, so by
	// construction it is 1 on every frame that actually arrives. A daemon
	// that drops its connection stops sending frames rather than sending
	// one that says 0 — the relay's own live connection count is the
	// signal for "how many daemons are up right now," not this field.
	DaemonConnected int    `json:"daemon_connected"`
	Reconnects      uint64 `json:"reconnects"`

	CoalesceAdmitted uint64 `json:"coalesce_admitted"`
	CoalesceDropped  uint64 `json:"coalesce_dropped"`

	JournalWrites uint64 `json:"journal_writes"`
	JournalTrims  uint64 `json:"journal_trims"`

	// Instantaneous, set at the last "leases" reconcile, not cumulative —
	// see relay.Client.recordDivergence. Reconciles are rare (join, or a
	// relay restart), so a one-off divergence rides in this field
	// unchanged, frame after frame, until the next one — read a long run
	// of the same nonzero value as "measured once, a while ago," not as
	// "ongoing right now."
	LeaseCacheDiverge float64 `json:"lease_cache_diverge"`

	RegionKeysRelative uint64 `json:"region_keys_relative"`
	RegionKeysAbsolute uint64 `json:"region_keys_absolute"` // non-zero here means collision detection has silently broken

	OutboundDropped uint64 `json:"outbound_dropped"`
}

// pushStats gathers the current catalogue and sends one statsFrame over
// the relay connection this daemon already holds. Never blocks the caller
// (daemon.tick's own goroutine): SendText hands off to Client's bounded,
// drop-oldest outbound queue and returns immediately regardless of whether
// the relay is up, mid-backoff, or has never connected at all — see
// relay.Client.SendText and internal/outbound. A slow or absent relay
// therefore never delays the next tick, let alone a decision.
func (d *Daemon) pushStats() {
	if d.metrics == nil || d.relay == nil {
		return
	}
	frame, ok := buildStatsFrame(d.metrics)
	if !ok {
		return
	}
	body, err := json.Marshal(frame)
	if err != nil {
		return // every field here is a plain number; this cannot realistically fail
	}
	d.relay.SendText(body)
}

// buildStatsFrame reads the registry back through its own Gatherer —
// "a caller that wants to forward these to something other than an HTTP
// scrape," in that method's own words — rather than tracking a second,
// parallel set of counters just for the wire. This runs on daemon.tick's
// 30-second cadence, not the decision path, so Gather's allocation is not
// a concern here the way it would be in onRequest.
func buildStatsFrame(m *metrics.Registry) (statsFrame, bool) {
	families, err := m.Gatherer().Gather()
	if err != nil {
		return statsFrame{}, false
	}
	byName := make(map[string]*dto.MetricFamily, len(families))
	for _, fam := range families {
		byName[fam.GetName()] = fam
	}

	f := statsFrame{Type: "stats"}

	if h := soleHistogram(byName["ap_decide_duration_seconds"]); h != nil {
		f.DecideCount = h.GetSampleCount()
		f.DecideSumSeconds = h.GetSampleSum()
		f.DecideBucketBounds = make([]float64, len(h.Bucket))
		f.DecideBucketCounts = make([]uint64, len(h.Bucket))
		for i, b := range h.Bucket {
			f.DecideBucketBounds[i] = b.GetUpperBound()
			f.DecideBucketCounts[i] = b.GetCumulativeCount()
		}
	}

	f.DaemonConnected = int(soleGaugeValue(byName["ap_daemon_connected"]))
	f.Reconnects = soleCounterValue(byName["ap_relay_reconnects_total"])

	f.CoalesceAdmitted = labeledCounterValue(byName["ap_coalesce_total"], "outcome", metrics.AdmitAdmitted)
	f.CoalesceDropped = labeledCounterValue(byName["ap_coalesce_total"], "outcome", metrics.AdmitDropped)

	f.JournalWrites = soleCounterValue(byName["ap_journal_writes_total"])
	f.JournalTrims = soleCounterValue(byName["ap_journal_trims_total"])

	f.LeaseCacheDiverge = soleGaugeValue(byName["ap_lease_cache_divergence"])

	f.RegionKeysRelative = labeledCounterValue(byName["ap_region_keys_total"], "shape", metrics.ShapeRelative)
	f.RegionKeysAbsolute = labeledCounterValue(byName["ap_region_keys_total"], "shape", metrics.ShapeAbsolute)

	f.OutboundDropped = soleCounterValue(byName["ap_outbound_dropped_total"])

	return f, true
}

// soleHistogram, soleGaugeValue and soleCounterValue read the one metric a
// label-less family carries. Every family this file reads that has no
// label vector (DecideDuration, DaemonConnected, Reconnects, JournalWrites,
// JournalTrims, LeaseCacheDiverge, OutboundDropped) is registered with
// prometheus.NewX, not
// prometheus.NewXVec, so Gather always hands back exactly one Metric for it.
func soleHistogram(fam *dto.MetricFamily) *dto.Histogram {
	if fam == nil || len(fam.Metric) == 0 {
		return nil
	}
	return fam.Metric[0].GetHistogram()
}

func soleGaugeValue(fam *dto.MetricFamily) float64 {
	if fam == nil || len(fam.Metric) == 0 {
		return 0
	}
	return fam.Metric[0].GetGauge().GetValue()
}

func soleCounterValue(fam *dto.MetricFamily) uint64 {
	if fam == nil || len(fam.Metric) == 0 {
		return 0
	}
	return uint64(math.Round(fam.Metric[0].GetCounter().GetValue()))
}

// labeledCounterValue reads the one series in a CounterVec family whose
// single label matches (label, value) — every vector this file reads
// (ap_coalesce_total's "outcome", ap_region_keys_total's "shape") has
// exactly one label, so a linear scan over a handful of series is simpler
// than building a lookup map for what Gather already keeps small by
// construction (bounded cardinality — see internal/metrics's package
// comment).
func labeledCounterValue(fam *dto.MetricFamily, label, value string) uint64 {
	if fam == nil {
		return 0
	}
	for _, m := range fam.Metric {
		for _, lp := range m.GetLabel() {
			if lp.GetName() == label && lp.GetValue() == value {
				return uint64(math.Round(m.GetCounter().GetValue()))
			}
		}
	}
	return 0
}
