package mcprelay

// Connection-state and roundtrip metrics: the same reason the daemon has to
// report these, on the same shape — see internal/metrics's package comment
// on why there's no endpoint here to scrape instead.

import (
	"context"
	"net"
	"net/http"
	"testing"
	"time"

	"github.com/mohsensc/sync/go/internal/metrics"
	"github.com/mohsensc/sync/go/internal/wire"
)

func gaugeValue(t *testing.T, r *metrics.Registry, name string) float64 {
	t.Helper()
	fams, err := r.Gatherer().Gather()
	if err != nil {
		t.Fatalf("gather: %v", err)
	}
	for _, fam := range fams {
		if fam.GetName() != name {
			continue
		}
		ms := fam.GetMetric()
		if len(ms) == 0 {
			return 0
		}
		return ms[0].GetGauge().GetValue()
	}
	t.Fatalf("no metric family named %q", name)
	return 0
}

func counterValue(t *testing.T, r *metrics.Registry, name string) float64 {
	t.Helper()
	fams, err := r.Gatherer().Gather()
	if err != nil {
		t.Fatalf("gather: %v", err)
	}
	for _, fam := range fams {
		if fam.GetName() != name {
			continue
		}
		ms := fam.GetMetric()
		if len(ms) == 0 {
			return 0
		}
		return ms[0].GetCounter().GetValue()
	}
	t.Fatalf("no metric family named %q", name)
	return 0
}

func histogramSampleCount(t *testing.T, r *metrics.Registry, name string) uint64 {
	t.Helper()
	fams, err := r.Gatherer().Gather()
	if err != nil {
		t.Fatalf("gather: %v", err)
	}
	for _, fam := range fams {
		if fam.GetName() != name {
			continue
		}
		ms := fam.GetMetric()
		if len(ms) == 0 {
			return 0
		}
		return ms[0].GetHistogram().GetSampleCount()
	}
	t.Fatalf("no metric family named %q", name)
	return 0
}

func TestDaemonConnectedGaugeTracksTheLiveConnection(t *testing.T) {
	fr := newFakeRelay()
	url, stop := startFakeRelay(t, fr)
	defer stop()

	reg := metrics.New()
	c := New(Config{
		URL: url, Room: "r1", Agent: "a1", Human: "sara",
		ConnectTimeout: 2 * time.Second, RequestTimeout: 2 * time.Second,
		Metrics: reg,
	})

	if v := gaugeValue(t, reg, "ap_daemon_connected"); v != 0 {
		t.Fatalf("gauge = %v before any connect, want 0", v)
	}

	if _, err := c.Claim(context.Background(), wire.Region{Path: "x"}, "y"); err != nil {
		t.Fatal(err)
	}
	if v := gaugeValue(t, reg, "ap_daemon_connected"); v != 1 {
		t.Fatalf("gauge = %v while connected, want 1", v)
	}

	c.Close()
	if v := gaugeValue(t, reg, "ap_daemon_connected"); v != 0 {
		t.Fatalf("gauge = %v after Close, want 0", v)
	}
}

func TestReconnectsCountsOnlyAfterATeardown(t *testing.T) {
	fr := newFakeRelay()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	srv := &http.Server{Handler: http.HandlerFunc(fr.handler)}
	go srv.Serve(ln)

	reg := metrics.New()
	c := New(Config{
		URL: "ws://" + addr + "/", Room: "r1", Agent: "a1", Human: "sara",
		ConnectTimeout: 2 * time.Second, RequestTimeout: 2 * time.Second,
		Metrics: reg,
	})
	defer c.Close()

	if _, err := c.Claim(context.Background(), wire.Region{Path: "src/first.py"}, "one"); err != nil {
		t.Fatal(err)
	}
	if v := counterValue(t, reg, "ap_relay_reconnects_total"); v != 0 {
		t.Fatalf("reconnects = %v after the first-ever connect, want 0", v)
	}

	// A relay crash: the connection goes away without either side sending
	// a close frame.
	srv.Close()
	fr.closeConns()
	c.Claim(context.Background(), wire.Region{Path: "src/during-outage.py"}, "two") // expected to fail

	ln2, err := net.Listen("tcp", addr)
	if err != nil {
		t.Skipf("could not rebind %s (port not released yet): %v", addr, err)
	}
	fr2 := newFakeRelay()
	srv2 := &http.Server{Handler: http.HandlerFunc(fr2.handler)}
	go srv2.Serve(ln2)
	defer srv2.Close()

	deadline := time.Now().Add(3 * time.Second)
	var lastErr error
	for time.Now().Before(deadline) {
		if _, err := c.Claim(context.Background(), wire.Region{Path: "src/after-restart.py"}, "three"); err == nil {
			lastErr = nil
			break
		} else {
			lastErr = err
		}
		time.Sleep(20 * time.Millisecond)
	}
	if lastErr != nil {
		t.Fatalf("never reconnected after the relay came back: %v", lastErr)
	}

	if v := counterValue(t, reg, "ap_relay_reconnects_total"); v != 1 {
		t.Fatalf("reconnects = %v after one reconnect, want 1", v)
	}
	if v := gaugeValue(t, reg, "ap_daemon_connected"); v != 1 {
		t.Fatalf("gauge = %v after reconnecting, want 1", v)
	}
}

func TestClaimRoundtripObservesOnlyASuccessfulClaimNotAMove(t *testing.T) {
	fr := newFakeRelay()
	url, stop := startFakeRelay(t, fr)
	defer stop()

	reg := metrics.New()
	c := New(Config{
		URL: url, Room: "r1", Agent: "a1", Human: "sara",
		ConnectTimeout: 2 * time.Second, RequestTimeout: 2 * time.Second,
		Metrics: reg,
	})
	defer c.Close()

	if n := histogramSampleCount(t, reg, "ap_claim_roundtrip_seconds"); n != 0 {
		t.Fatalf("samples before any claim = %d, want 0", n)
	}

	if _, err := c.Claim(context.Background(), wire.Region{Path: "src/db.py"}, "add index"); err != nil {
		t.Fatal(err)
	}
	if n := histogramSampleCount(t, reg, "ap_claim_roundtrip_seconds"); n != 1 {
		t.Fatalf("samples after one claim = %d, want 1", n)
	}

	// Move rides the same request() path but ClaimRoundtrip's help text is
	// specifically about a claim's verdict — a move must not add a sample.
	if _, err := c.Move(context.Background(), wire.Region{Path: "src/db.py"}, "SPLIT", ""); err != nil {
		t.Fatal(err)
	}
	if n := histogramSampleCount(t, reg, "ap_claim_roundtrip_seconds"); n != 1 {
		t.Fatalf("samples after a move = %d, want still 1", n)
	}
}

func TestClaimRoundtripDoesNotObserveATimeout(t *testing.T) {
	fr := newFakeRelay()
	fr.silentClaim = true
	url, stop := startFakeRelay(t, fr)
	defer stop()

	reg := metrics.New()
	c := New(Config{
		URL: url, Room: "r1", Agent: "a1", Human: "sara",
		ConnectTimeout: 2 * time.Second, RequestTimeout: 300 * time.Millisecond,
		Metrics: reg,
	})
	defer c.Close()

	if _, err := c.Claim(context.Background(), wire.Region{Path: "x"}, "y"); err == nil {
		t.Fatal("expected a timeout error")
	}
	if n := histogramSampleCount(t, reg, "ap_claim_roundtrip_seconds"); n != 0 {
		t.Fatalf("samples after a timed-out claim = %d, want 0 — a timeout never got a verdict", n)
	}
}
