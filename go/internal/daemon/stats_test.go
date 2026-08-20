package daemon

import (
	"testing"

	"github.com/mohsensc/sync/go/internal/metrics"
)

// TestBuildStatsFrameReadsEveryField is the wiring check for the stats
// push: every field in statsFrame actually comes from the registry field
// or label value its comment claims, by name. Every metric name and label
// value buildStatsFrame reads (ap_relay_reconnects_total,
// ap_lease_cache_divergence, the "outcome" and "shape" label values) is a
// bare string literal matched against internal/metrics from outside that
// package — nothing here fails to compile if one of them drifts, so this
// test is what would actually catch it: a typo or a rename on either side
// turns a field into a permanent, silent zero otherwise.
//
// No socket, no relay connection, no ticker: buildStatsFrame is a pure
// function of a Gatherer, called directly the same way daemon.pushStats
// calls it on its 30-second cadence.
func TestBuildStatsFrameReadsEveryField(t *testing.T) {
	m := metrics.New()

	m.DecideDuration.Observe(0.0009) // lands in more than one bucket boundary
	m.DaemonConnected.Set(1)
	m.Reconnects.Inc()
	m.Reconnects.Inc()
	m.Coalesce(metrics.AdmitAdmitted)
	m.Coalesce(metrics.AdmitAdmitted)
	m.Coalesce(metrics.AdmitDropped)
	m.JournalWrites.Inc()
	m.JournalWrites.Inc()
	m.JournalWrites.Inc()
	m.JournalTrims.Inc()
	m.LeaseCacheDiverge.Set(3)
	m.RegionKey(metrics.ShapeRelative)
	m.RegionKey(metrics.ShapeRelative)
	m.RegionKey(metrics.ShapeAbsolute)
	m.OutboundDropped.Add(5)

	f, ok := buildStatsFrame(m)
	if !ok {
		t.Fatal("buildStatsFrame reported failure")
	}

	if f.Type != "stats" {
		t.Errorf("Type = %q, want \"stats\"", f.Type)
	}
	if f.DecideCount != 1 {
		t.Errorf("DecideCount = %d, want 1", f.DecideCount)
	}
	if f.DecideSumSeconds != 0.0009 {
		t.Errorf("DecideSumSeconds = %v, want 0.0009", f.DecideSumSeconds)
	}
	if len(f.DecideBucketBounds) == 0 || len(f.DecideBucketBounds) != len(f.DecideBucketCounts) {
		t.Fatalf("DecideBucketBounds/Counts mismatched or empty: %v / %v",
			f.DecideBucketBounds, f.DecideBucketCounts)
	}
	// 0.0009 falls at or past every bound from 0.001 up; the last (widest)
	// bucket's cumulative count must include this one observation.
	if last := f.DecideBucketCounts[len(f.DecideBucketCounts)-1]; last != 1 {
		t.Errorf("widest decide bucket cumulative count = %d, want 1", last)
	}

	if f.DaemonConnected != 1 {
		t.Errorf("DaemonConnected = %d, want 1", f.DaemonConnected)
	}
	if f.Reconnects != 2 {
		t.Errorf("Reconnects = %d, want 2", f.Reconnects)
	}
	if f.CoalesceAdmitted != 2 {
		t.Errorf("CoalesceAdmitted = %d, want 2", f.CoalesceAdmitted)
	}
	if f.CoalesceDropped != 1 {
		t.Errorf("CoalesceDropped = %d, want 1", f.CoalesceDropped)
	}
	if f.JournalWrites != 3 {
		t.Errorf("JournalWrites = %d, want 3", f.JournalWrites)
	}
	if f.JournalTrims != 1 {
		t.Errorf("JournalTrims = %d, want 1", f.JournalTrims)
	}
	if f.LeaseCacheDiverge != 3 {
		t.Errorf("LeaseCacheDiverge = %v, want 3", f.LeaseCacheDiverge)
	}
	if f.RegionKeysRelative != 2 {
		t.Errorf("RegionKeysRelative = %d, want 2", f.RegionKeysRelative)
	}
	if f.RegionKeysAbsolute != 1 {
		t.Errorf("RegionKeysAbsolute = %d, want 1", f.RegionKeysAbsolute)
	}
	if f.OutboundDropped != 5 {
		t.Errorf("OutboundDropped = %d, want 5", f.OutboundDropped)
	}
}

// TestBuildStatsFrameZeroValueRegistry is the empty-registry case: a fresh
// Registry with nothing recorded yet must produce zeroed fields, not a
// panic from indexing an empty Metric slice on a family that exists but
// carries no series (a CounterVec with no label combination touched yet
// gathers as a family with zero Metric entries, not an absent family).
func TestBuildStatsFrameZeroValueRegistry(t *testing.T) {
	m := metrics.New()
	f, ok := buildStatsFrame(m)
	if !ok {
		t.Fatal("buildStatsFrame reported failure")
	}
	if f.DecideCount != 0 || f.CoalesceAdmitted != 0 || f.RegionKeysAbsolute != 0 {
		t.Fatalf("expected an all-zero frame, got %+v", f)
	}
}
