package relaysrv

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/mohsensc/sync/go/internal/metrics"
)

// gaugeValue reads one gauge's current value straight out of a Gather
// pass — the registry's own exported gauges (RelayConnections, Rooms,
// DaemonsConnected, ...) have no public getter, only Set/Add/Sub, so
// this is the same read path /metrics itself uses, not a shortcut around
// it.
func gaugeValue(t *testing.T, reg *metrics.Registry, name string) float64 {
	t.Helper()
	families, err := reg.Gatherer().Gather()
	if err != nil {
		t.Fatalf("gather: %v", err)
	}
	for _, fam := range families {
		if fam.GetName() != name {
			continue
		}
		for _, m := range fam.GetMetric() {
			return m.GetGauge().GetValue()
		}
	}
	return 0
}

// counterValue is gaugeValue's twin for a plain (unlabeled) Counter.
func counterValue(t *testing.T, reg *metrics.Registry, name string) float64 {
	t.Helper()
	families, err := reg.Gatherer().Gather()
	if err != nil {
		t.Fatalf("gather: %v", err)
	}
	for _, fam := range families {
		if fam.GetName() != name {
			continue
		}
		for _, m := range fam.GetMetric() {
			return m.GetCounter().GetValue()
		}
	}
	return 0
}

// -- the metrics endpoint ------------------------------------------------

func TestMetricsServerNotServedWhenAddrUnset(t *testing.T) {
	if ms := MetricsServer("", metrics.New()); ms != nil {
		t.Fatalf("expected no server when --metrics-addr is unset, got %#v", ms)
	}
}

func TestMetricsServerServesOnlyMetrics(t *testing.T) {
	reg := metrics.New()
	reg.Decision(0, "silent")
	ms := MetricsServer("127.0.0.1:0", reg)
	if ms == nil {
		t.Fatal("expected a server once an address is given")
	}

	rec := httptest.NewRecorder()
	ms.Handler.ServeHTTP(rec, httptest.NewRequest("GET", "/metrics", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /metrics: status %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "ap_decisions_total") {
		t.Fatalf("expected the catalogue in the body, got %q", rec.Body.String())
	}

	rec = httptest.NewRecorder()
	ms.Handler.ServeHTTP(rec, httptest.NewRequest("GET", "/", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("GET /: status %d, want 404 — nothing but /metrics should be served here", rec.Code)
	}
}

// -- gauge lifecycle -------------------------------------------------------

// TestGaugesReturnToZeroAfterEveryConnectionLeaves is a real-server,
// real-websocket test: dial in, join a room, report stats once (so this
// connection counts as a daemon too), then disconnect — and check that
// RelayConnections, Rooms and DaemonsConnected all settle back to zero.
// A gauge that only goes up is a bug (see the ownership doc); this is
// what would have caught it.
func TestGaugesReturnToZeroAfterEveryConnectionLeaves(t *testing.T) {
	reg := metrics.New()
	relay := NewRelay(NewVirtualClock(0), InertRoster(), reg)
	srv := &Server{Addr: "127.0.0.1:0", Relay: relay}
	addr, err := srv.Listen()
	if err != nil {
		t.Fatalf("Listen: %s", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go srv.Serve(ctx)

	ws, _, err := websocket.DefaultDialer.Dial("ws://"+addr+"/", nil)
	if err != nil {
		t.Fatalf("dial: %s", err)
	}

	if err := ws.WriteJSON(map[string]any{"type": "join", "room": "r", "agent": "a", "human": "h"}); err != nil {
		t.Fatal(err)
	}
	var reply map[string]any
	if err := ws.ReadJSON(&reply); err != nil {
		t.Fatal(err)
	}
	if err := ws.WriteJSON(map[string]any{"type": "stats", "reconnects": 1.0}); err != nil {
		t.Fatal(err)
	}

	waitUntilFloat(t, func() float64 { return gaugeValue(t, reg, "ap_relay_connections") }, 1,
		"RelayConnections never reached 1 for the connected client")
	waitUntilFloat(t, func() float64 { return gaugeValue(t, reg, "ap_rooms") }, 1,
		"Rooms never reached 1 for the joined room")
	waitUntilFloat(t, func() float64 { return gaugeValue(t, reg, "ap_daemons_connected") }, 1,
		"DaemonsConnected never reached 1 after the stats frame")

	_ = ws.Close()

	waitUntilFloat(t, func() float64 { return gaugeValue(t, reg, "ap_relay_connections") }, 0,
		"RelayConnections did not return to 0 after the connection closed")
	waitUntilFloat(t, func() float64 { return gaugeValue(t, reg, "ap_rooms") }, 0,
		"Rooms did not return to 0 once its only member left")
	waitUntilFloat(t, func() float64 { return gaugeValue(t, reg, "ap_daemons_connected") }, 0,
		"DaemonsConnected did not return to 0 after the daemon's connection closed")
}

func waitUntilFloat(t *testing.T, read func() float64, want float64, what string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if read() == want {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("%s (got %v, want %v)", what, read(), want)
}

// -- the stats frame ---------------------------------------------------

// TestStatsFrameFromAnUnjoinedClientIsIgnored: dispatch's room=="" guard
// is what has to catch this — a stats frame is how a daemon posts
// numbers with no further authentication, so it must not work before
// Join has run.
func TestStatsFrameFromAnUnjoinedClientIsIgnored(t *testing.T) {
	reg := metrics.New()
	relay := NewRelay(NewVirtualClock(0), InertRoster(), reg)
	conn := &recorder{agent: "a1", human: "h"}
	// Deliberately never Join.

	relay.Handle(conn, map[string]any{
		"type":       "stats",
		"reconnects": 3.0,
	})

	if got := gaugeValue(t, reg, "ap_daemons_connected"); got != 0 {
		t.Fatalf("DaemonsConnected = %v, want 0 — an unjoined connection must never count as a daemon", got)
	}
	if got := counterValue(t, reg, "ap_relay_reconnects_total"); got != 0 {
		t.Fatalf("Reconnects = %v, want 0 — the whole stats frame should have been dropped", got)
	}
}

// TestStatsFrameFoldsIntoTheRelaysOwnCounters matches the producer's
// actual contract (internal/daemon/stats.go): fields are cumulative
// since the daemon's process started, not deltas since the last report —
// so a second report's fold has to be the *difference* from the first,
// not the second report's raw number.
func TestStatsFrameFoldsIntoTheRelaysOwnCounters(t *testing.T) {
	reg := metrics.New()
	relay := NewRelay(NewVirtualClock(0), InertRoster(), reg)
	conn := &recorder{agent: "a1", human: "h"}
	relay.Join("room", conn)

	relay.Handle(conn, map[string]any{
		"type":                 "stats",
		"reconnects":           3.0,
		"coalesce_admitted":    10.0,
		"coalesce_dropped":     1.0,
		"region_keys_relative": 8.0,
		"region_keys_absolute": 0.0,
	})

	if got := counterValue(t, reg, "ap_relay_reconnects_total"); got != 3 {
		t.Fatalf("Reconnects = %v, want 3 (this connection's first report)", got)
	}
	if got := gaugeValue(t, reg, "ap_daemons_connected"); got != 1 {
		t.Fatalf("DaemonsConnected = %v, want 1 after the first stats frame from a joined connection", got)
	}

	// A second, later report: cumulative totals have moved on by a few,
	// not reset — reconnects 3 -> 5 is +2 new reconnects, not a second
	// "5" on top of the first "3".
	relay.Handle(conn, map[string]any{
		"type":                 "stats",
		"reconnects":           5.0,
		"coalesce_admitted":    10.0,
		"coalesce_dropped":     1.0,
		"region_keys_relative": 8.0,
		"region_keys_absolute": 0.0,
	})
	if got := counterValue(t, reg, "ap_relay_reconnects_total"); got != 5 {
		t.Fatalf("Reconnects = %v, want 5 (3 + the 2 new since the first report)", got)
	}
	if got := gaugeValue(t, reg, "ap_daemons_connected"); got != 1 {
		t.Fatalf("DaemonsConnected = %v, want 1 — same connection reporting twice is one daemon", got)
	}
	shapes := regionShapeCounts(t, reg)
	if shapes[metrics.ShapeRelative] != 8 {
		t.Fatalf("region_keys{shape=relative} = %v, want 8 (unchanged between the two reports)", shapes[metrics.ShapeRelative])
	}
}

// TestStatsFrameHandlesADaemonRestart: a cumulative field smaller than
// the last report means the daemon's own process restarted and its
// counters reset to zero on its side (see daemonBaseline's doc comment)
// — the delta folded has to be the new report's value as-is, not a
// negative number that would make the relay's own counter go backwards
// (which Prometheus counters cannot do without looking like a bug).
func TestStatsFrameHandlesADaemonRestart(t *testing.T) {
	reg := metrics.New()
	relay := NewRelay(NewVirtualClock(0), InertRoster(), reg)
	conn := &recorder{agent: "a1", human: "h"}
	relay.Join("room", conn)

	relay.Handle(conn, map[string]any{"type": "stats", "journal_writes": 40.0})
	if got := counterValue(t, reg, "ap_journal_writes_total"); got != 40 {
		t.Fatalf("JournalWrites = %v, want 40", got)
	}

	// The daemon restarted: its own counter is back near zero.
	relay.Handle(conn, map[string]any{"type": "stats", "journal_writes": 3.0})
	if got := counterValue(t, reg, "ap_journal_writes_total"); got != 43 {
		t.Fatalf("JournalWrites = %v, want 43 (40 + the 3 the restarted daemon has done since) — "+
			"a naive delta would have gone negative and folded nothing, or worse, subtracted", got)
	}
}

// -- region shape ---------------------------------------------------------

// TestRegionShapeCounterDistinguishesAbsoluteFromRelative is the live
// regression detector's own test: a relative and an absolute region on
// the wire must land in different buckets, or the detector this exists
// to be would itself be silently broken.
func TestRegionShapeCounterDistinguishesAbsoluteFromRelative(t *testing.T) {
	reg := metrics.New()
	relay := NewRelay(NewVirtualClock(0), InertRoster(), reg)
	conn := &recorder{agent: "a1", human: "h"}
	relay.Join("room", conn)

	relay.Handle(conn, map[string]any{
		"type": "claim", "region": goldenRegion("src/app.py", "sym"), "intent": "x",
	})
	relay.Handle(conn, map[string]any{
		"type": "claim", "region": goldenRegion("/Users/dev/repo/src/app.py", "sym2"), "intent": "y",
	})

	shapes := regionShapeCounts(t, reg)
	if shapes[metrics.ShapeRelative] != 1 {
		t.Fatalf("relative count = %v, want 1 (all: %v)", shapes[metrics.ShapeRelative], shapes)
	}
	if shapes[metrics.ShapeAbsolute] != 1 {
		t.Fatalf("absolute count = %v, want 1 (all: %v)", shapes[metrics.ShapeAbsolute], shapes)
	}
}

func regionShapeCounts(t *testing.T, reg *metrics.Registry) map[string]float64 {
	t.Helper()
	families, err := reg.Gatherer().Gather()
	if err != nil {
		t.Fatalf("gather: %v", err)
	}
	out := map[string]float64{}
	for _, fam := range families {
		if fam.GetName() != "ap_region_keys_total" {
			continue
		}
		for _, m := range fam.GetMetric() {
			for _, lp := range m.GetLabel() {
				if lp.GetName() == "shape" {
					out[lp.GetValue()] = m.GetCounter().GetValue()
				}
			}
		}
	}
	return out
}
