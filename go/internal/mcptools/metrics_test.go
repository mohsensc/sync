package mcptools

// The MCP surface's health is the product's health from the agent's side —
// every exported tool has to record exactly one ap_mcp_calls_total sample,
// with an outcome from this package's small vocabulary, no matter how the
// call resolved.

import (
	"context"
	"testing"
	"time"

	"github.com/mohsensc/sync/go/internal/mcprelay"
	"github.com/mohsensc/sync/go/internal/metrics"
)

// mcpCallSeries finds every ap_mcp_calls_total series carrying the given
// tool label, tolerant of outcome. Used to assert "exactly one call was
// recorded" in a way that fails on double-recording at two layers, not
// just on the series a test expected existing.
func mcpCallSeries(t *testing.T, r *metrics.Registry, tool string) map[string]float64 {
	t.Helper()
	fams, err := r.Gatherer().Gather()
	if err != nil {
		t.Fatalf("gather: %v", err)
	}
	got := map[string]float64{}
	for _, fam := range fams {
		if fam.GetName() != "ap_mcp_calls_total" {
			continue
		}
		for _, m := range fam.GetMetric() {
			var gotTool, outcome string
			for _, lp := range m.GetLabel() {
				switch lp.GetName() {
				case "tool":
					gotTool = lp.GetValue()
				case "outcome":
					outcome = lp.GetValue()
				}
			}
			if gotTool == tool {
				got[outcome] = m.GetCounter().GetValue()
			}
		}
	}
	return got
}

// totalMCPCallSeries is every series in the family, regardless of tool —
// for asserting a whole test run produced exactly one sample system-wide.
func totalMCPCallSeries(t *testing.T, r *metrics.Registry) int {
	t.Helper()
	fams, err := r.Gatherer().Gather()
	if err != nil {
		t.Fatalf("gather: %v", err)
	}
	for _, fam := range fams {
		if fam.GetName() == "ap_mcp_calls_total" {
			return len(fam.GetMetric())
		}
	}
	return 0
}

func assertExactlyOneCall(t *testing.T, r *metrics.Registry, tool, wantOutcome string) {
	t.Helper()
	if n := totalMCPCallSeries(t, r); n != 1 {
		t.Fatalf("ap_mcp_calls_total has %d series, want exactly 1: %+v", n, mcpCallSeries(t, r, tool))
	}
	series := mcpCallSeries(t, r, tool)
	if v := series[wantOutcome]; v != 1 {
		t.Fatalf("tool=%q outcome=%q = %v, want 1 (series: %+v)", tool, wantOutcome, v, series)
	}
}

func TestWhoElseIsHereRecordsOK(t *testing.T) {
	url, _, stop := startScriptedRelay(t)
	defer stop()
	tools, reg := newTestToolsWithMetrics(url, "", "r1", "a1", "sara")
	defer tools.Close()

	tools.WhoElseIsHere(context.Background())
	assertExactlyOneCall(t, reg, mcpToolWhoElseIsHere, mcpOutcomeOK)
}

func TestClaimWorkRecordsOKOnAGrantedClaim(t *testing.T) {
	url, _, stop := startScriptedRelay(t)
	defer stop()
	tools, reg := newTestToolsWithMetrics(url, "", "r1", "a1", "sara")
	defer tools.Close()

	tools.ClaimWork(context.Background(), "src/db.py", strp("query"), "add index")
	assertExactlyOneCall(t, reg, mcpToolClaimWork, mcpOutcomeOK)
}

// TestClaimWorkRecordsRefusedNotErrorOnALosingClaim is the case named
// explicitly in the brief: a claim the relay legitimately turned down is a
// refusal, not a system error.
func TestClaimWorkRecordsRefusedNotErrorOnALosingClaim(t *testing.T) {
	url, _, stop := startScriptedRelay(t)
	defer stop()
	holder, _ := newTestToolsWithMetrics(url, "", "r1", "a1", "sara")
	defer holder.Close()
	challenger, reg := newTestToolsWithMetrics(url, "", "r1", "a2", "dev")
	defer challenger.Close()

	if r := holder.ClaimWork(context.Background(), "src/db.py", strp("query"), "rewriting"); r["granted"] != true {
		t.Fatalf("setup claim failed: %+v", r)
	}
	challenger.ClaimWork(context.Background(), "src/db.py", strp("query"), "add index")

	series := mcpCallSeries(t, reg, mcpToolClaimWork)
	if series[mcpOutcomeRefused] != 1 {
		t.Fatalf("claim_work outcomes = %+v, want refused=1", series)
	}
	if _, hasError := series[mcpOutcomeError]; hasError {
		t.Fatalf("claim_work outcomes = %+v, a losing claim must not record error", series)
	}
}

func TestReleaseRecordsOK(t *testing.T) {
	url, _, stop := startScriptedRelay(t)
	defer stop()
	tools, reg := newTestToolsWithMetrics(url, "", "r1", "a1", "sara")
	defer tools.Close()

	tools.ClaimWork(context.Background(), "src/db.py", strp("query"), "add index")
	tools.Release(context.Background(), "src/db.py", strp("query"))
	series := mcpCallSeries(t, reg, mcpToolRelease)
	if series[mcpOutcomeOK] != 1 {
		t.Fatalf("release outcomes = %+v, want ok=1", series)
	}
}

func TestRespondRecordsOKOnAnAcceptedMove(t *testing.T) {
	url, _, stop := startScriptedRelay(t)
	defer stop()
	holder, _ := newTestToolsWithMetrics(url, "", "r1", "a1", "sara")
	defer holder.Close()
	challenger, reg := newTestToolsWithMetrics(url, "", "r1", "a2", "dev")
	defer challenger.Close()

	holder.ClaimWork(context.Background(), "src/db.py", strp("query"), "x")
	challenger.Respond(context.Background(), "src/db.py", strp("query"), "PROCEED", "")
	assertExactlyOneCall(t, reg, mcpToolRespond, mcpOutcomeOK)
}

// TestRespondRecordsRefusedOnAnInventedMove is the other case the brief
// names explicitly, and it never touches the relay at all — the refusal
// has to come from Tools.Respond's local check, not from a wire reply.
func TestRespondRecordsRefusedOnAnInventedMove(t *testing.T) {
	url, _, stop := startScriptedRelay(t)
	defer stop()
	tools, reg := newTestToolsWithMetrics(url, "", "r1", "a1", "sara")
	defer tools.Close()

	tools.Respond(context.Background(), "src/db.py", strp("query"), "ARGUE", "")
	assertExactlyOneCall(t, reg, mcpToolRespond, mcpOutcomeRefused)
}

// -- no relay: every tool answers, and records no_relay, not error -------

func TestNoRelayRecordsNoRelayForEveryToolAndDoesNotHang(t *testing.T) {
	cases := []struct {
		tool string
		call func(tools *Tools)
	}{
		{mcpToolWhoElseIsHere, func(tools *Tools) { tools.WhoElseIsHere(context.Background()) }},
		{mcpToolClaimWork, func(tools *Tools) {
			tools.ClaimWork(context.Background(), "src/db.py", strp("query"), "x")
		}},
		{mcpToolRelease, func(tools *Tools) {
			tools.Release(context.Background(), "src/db.py", strp("query"))
		}},
		{mcpToolRespond, func(tools *Tools) {
			tools.Respond(context.Background(), "src/db.py", strp("query"), "DEFER", "")
		}},
	}

	for _, c := range cases {
		t.Run(c.tool, func(t *testing.T) {
			reg := metrics.New()
			conn := newConnToDeadRelay(reg)
			tools := NewTools(conn, "", "r1", "a1", "sara", reg)
			defer tools.Close()

			c.call(tools) // must return promptly — go test -timeout is the backstop
			assertExactlyOneCall(t, reg, c.tool, mcpOutcomeNoRelay)
		})
	}
}

// -- Dispatch's own failures: unknown tool, missing/mistyped argument ----

func TestDispatchRecordsErrorForAnUnknownToolBucketedNotByName(t *testing.T) {
	reg := metrics.New()
	conn := newConnToDeadRelay(reg)
	tools := NewTools(conn, "", "r1", "a1", "sara", reg)
	defer tools.Close()

	if _, err := Dispatch(context.Background(), tools, "delete_everything", nil); err == nil {
		t.Fatal("expected an error for an unknown tool")
	}

	assertExactlyOneCall(t, reg, mcpToolUnknown, mcpOutcomeError)
	if series := mcpCallSeries(t, reg, "delete_everything"); len(series) != 0 {
		t.Fatalf("the client-supplied name must never become a label value, got %+v", series)
	}
}

func TestDispatchRecordsErrorForAMissingRequiredArgumentUnderTheToolName(t *testing.T) {
	reg := metrics.New()
	conn := newConnToDeadRelay(reg)
	tools := NewTools(conn, "", "r1", "a1", "sara", reg)
	defer tools.Close()

	if _, err := Dispatch(context.Background(), tools, "claim_work", map[string]any{"intent": "no path"}); err == nil {
		t.Fatal("expected an error for a missing required argument")
	}
	assertExactlyOneCall(t, reg, mcpToolClaimWork, mcpOutcomeError)
}

// newConnToDeadRelay is a Conn pointed at a port nothing listens on, so
// every call fails fast with *mcprelay.Unavailable — same convention
// TestClaimWorkErrorsInsteadOfHangingWhenTheRelayIsNotRunning uses.
func newConnToDeadRelay(reg *metrics.Registry) *mcprelay.Conn {
	return mcprelay.New(mcprelay.Config{
		URL: "ws://127.0.0.1:1", Room: "r1", Agent: "a1", Human: "sara",
		ConnectTimeout: 1 * time.Second, RequestTimeout: 1 * time.Second,
		Metrics: reg,
	})
}
