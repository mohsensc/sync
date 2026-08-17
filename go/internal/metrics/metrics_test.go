package metrics

import (
	"net/http/httptest"
	"strings"
	"testing"
)

// forbiddenLabels are the label names that would put user data into a time
// series. A path, an intent or a person's name in a label lands in a
// time-series database, gets replicated, and outlives whatever it described —
// which is the opposite of what the rest of this product is careful about.
//
// This test is the guard. Adding a label called "path" to any metric here
// fails it, which is the point: the cost of that mistake is not visible at
// the call site.
var forbiddenLabels = []string{
	"path", "file", "intent", "human", "agent", "holder", "user",
	"room", "session", "email", "name",
}

func TestNoMetricCarriesUserDataInALabel(t *testing.T) {
	r := New()
	// Touch every vector so it materialises at least one series to inspect.
	r.Decision(3, "deny")
	r.Lease(OutcomeGranted)
	r.RegionKey(ShapeRelative)
	r.MCPCall("claim_work", "ok", 0)
	r.FrameDropped("slow_consumer")
	r.Coalesce(AdmitAdmitted)

	families, err := r.Gatherer().Gather()
	if err != nil {
		t.Fatalf("gather: %v", err)
	}
	for _, fam := range families {
		if !strings.HasPrefix(fam.GetName(), "ap_") {
			continue // go_* and process_* come from the runtime collectors
		}
		for _, m := range fam.GetMetric() {
			for _, lp := range m.GetLabel() {
				for _, bad := range forbiddenLabels {
					if strings.EqualFold(lp.GetName(), bad) {
						t.Errorf("%s carries a %q label — user data must not reach a label",
							fam.GetName(), lp.GetName())
					}
				}
			}
		}
	}
}

func TestRungLabelIsBounded(t *testing.T) {
	// A rung outside 0-4 is a bug upstream. Bucketing it keeps that bug from
	// also becoming unbounded cardinality.
	seen := map[string]bool{}
	for rung := -5; rung < 50; rung++ {
		seen[rungLabel(rung)] = true
	}
	if len(seen) != 6 {
		t.Fatalf("rung label has %d values, want 6 (0-4 and other): %v", len(seen), seen)
	}
	if !seen["other"] {
		t.Fatal("a rung outside 0-4 must fall into 'other'")
	}
}

func TestHandlerServesTheCatalogue(t *testing.T) {
	r := New()
	r.Decision(0, "silent")
	r.RegionKey(ShapeAbsolute)
	r.DecideDuration.Observe(0.0003)

	rec := httptest.NewRecorder()
	r.Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/metrics", nil))
	if rec.Code != 200 {
		t.Fatalf("status %d", rec.Code)
	}
	body := rec.Body.String()
	for _, want := range []string{
		`ap_decisions_total{effect="silent",rung="0"} 1`,
		`ap_region_keys_total{shape="absolute"} 1`,
		"ap_decide_duration_seconds_bucket",
		"go_goroutines",    // the runtime collector is wired
		"process_open_fds", // and the process one
	} {
		if !strings.Contains(body, want) {
			t.Errorf("exposition is missing %q", want)
		}
	}
}

func TestDecideBucketsStraddleTheHookBudget(t *testing.T) {
	// The hook's budget is 5ms and it fails open past it, so the question
	// this histogram has to answer is "what fraction is over 5ms" — which
	// needs buckets on both sides of it, not Prometheus's defaults that
	// start there.
	var below, above int
	for _, b := range decideBuckets {
		if b < 0.005 {
			below++
		}
		if b > 0.005 {
			above++
		}
	}
	if below < 3 || above < 3 {
		t.Fatalf("decide buckets need resolution either side of 5ms, got %d below and %d above",
			below, above)
	}
}
