package daemon

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/mohsensc/sync/go/internal/metrics"
	"github.com/mohsensc/sync/go/internal/wire"
)

// fakeRelay is the same minimal join+leases-snapshot relay used in
// internal/relay's own tests, kept local here so this test exercises
// daemon.New end to end without importing relay's test helpers.
type fakeRelay struct {
	upgrader  websocket.Upgrader
	joined    chan wire.Join
	leasePath string
}

func (f *fakeRelay) handler(w http.ResponseWriter, r *http.Request) {
	conn, err := f.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		var env wire.Envelope
		if json.Unmarshal(data, &env) != nil || env.Type != "join" {
			continue
		}
		var j wire.Join
		_ = json.Unmarshal(data, &j)
		f.joined <- j

		snapshot := wire.Leases{Type: "leases", Leases: []wire.LeaseFrame{
			{Agent: "other-agent", Human: "sara", Intent: "refactor",
				Region: wire.Region{Path: f.leasePath}},
		}}
		if conn.WriteJSON(snapshot) != nil {
			return
		}
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}
}

// TestEndToEndJoinReceiveRoundTrip is the acceptance test for wave 1: the Go
// daemon joins a room over a real websocket connection, receives a leases
// frame from it, and a hook talking to the unix socket sees that lease
// reflected in a decision response — the two protocols this PR ports,
// exercised together the way a real install would use them.
func TestEndToEndJoinReceiveRoundTrip(t *testing.T) {
	fr := &fakeRelay{joined: make(chan wire.Join, 4), leasePath: "src/auth.py"}
	srv := httptest.NewServer(http.HandlerFunc(fr.handler))
	defer srv.Close()

	sock := filepath.Join(t.TempDir(), "s")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	d, err := New(ctx, Options{
		Sock:     sock,
		RelayURL: "ws://" + srv.Listener.Addr().String() + "/",
		Room:     "test-room",
		Agent:    "go-daemon-test",
		Human:    "mohsen",
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	_ = d

	select {
	case j := <-fr.joined:
		if j.Room != "test-room" {
			t.Fatalf("joined room %q, want test-room", j.Room)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("daemon never joined the room")
	}

	// Give the leases snapshot time to land before asking the hook socket
	// about it — polling would be nicer, but the decision path itself is
	// the thing under test, not a second observation channel into the
	// lease cache.
	deadline := time.Now().Add(5 * time.Second)
	for {
		resp := decideOverSocket(t, sock, `{"verb":"edit","path":"src/auth.py","agent":"sess1","want":"decision"}`)
		if resp["rung"] == float64(3) {
			if resp["holder"] != "other-agent" {
				t.Fatalf("blocked by wrong holder: %+v", resp)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("hook socket never saw the lease from the join; last response: %+v", resp)
		}
		time.Sleep(20 * time.Millisecond)
	}

	// A path with no lease still gets a real answer, not silence — proving
	// the round trip covers the common case too, not only the conflict.
	resp := decideOverSocket(t, sock, `{"verb":"edit","path":"other.py","agent":"sess1","want":"decision"}`)
	if resp["rung"] != float64(0) {
		t.Fatalf("expected rung 0 for an unheld path, got %+v", resp)
	}
}

// TestRootNorm (named short — see TestDecideSocket's comment on
// t.TempDir()'s socket-path length against AF_UNIX's sun_path limit) is item
// 1 of the region-key fix,
// exercised through the real daemon rather than decide's own types: a peer
// that already normalized (any client that also carries this fix) files its
// lease under the repo-relative path, exactly what fr.leasePath sends here.
// A hook asking about the same file by its own absolute path — a different
// checkout, Options.Root pointing somewhere else entirely — has to resolve
// to that same lease, or the two are strangers again.
func TestRootNorm(t *testing.T) {
	fr := &fakeRelay{joined: make(chan wire.Join, 4), leasePath: "src/orders.py"}
	srv := httptest.NewServer(http.HandlerFunc(fr.handler))
	defer srv.Close()

	sock := filepath.Join(t.TempDir(), "s")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	d, err := New(ctx, Options{
		Sock:     sock,
		RelayURL: "ws://" + srv.Listener.Addr().String() + "/",
		Room:     "test-room",
		Agent:    "go-daemon-test",
		Human:    "mohsen",
		// A different machine's checkout than wherever the lease's
		// original claimant sat — that is the whole point.
		Root: "/Users/dan/dev/repo",
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	_ = d

	select {
	case <-fr.joined:
	case <-time.After(5 * time.Second):
		t.Fatal("daemon never joined the room")
	}

	deadline := time.Now().Add(5 * time.Second)
	for {
		resp := decideOverSocket(t, sock, `{"verb":"edit","path":"/Users/dan/dev/repo/src/orders.py","agent":"sess1","want":"decision"}`)
		if resp["rung"] == float64(3) {
			if resp["holder"] != "other-agent" {
				t.Fatalf("blocked by wrong holder: %+v", resp)
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("an absolute path under the configured root never matched the relatively-keyed lease; last response: %+v", resp)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// TestDecideSocket proves the daemon serves decisions on Sock+".decide" —
// the path hook/protocol.hpp's decision_sock_path derives, and the one the
// real ap-hook binary dials first (see hook.cpp's run_hook). Wave 1 only
// ever answered on the plain event socket; a hook built against the
// documented protocol would have gotten no answer here at all and silently
// fallen back.
//
// Named short on purpose: t.TempDir() folds the test name into the path it
// hands back, and this test's own socket path plus the ".decide" suffix
// leaves less margin under AF_UNIX's ~104-byte sun_path limit than a plain
// socket test does — see #24 and internal/hooksock's sockPath helper.
func TestDecideSocket(t *testing.T) {
	sock := filepath.Join(t.TempDir(), "s")
	if p := sock + ".decide"; len(p) > 100 {
		t.Fatalf("socket path too long for AF_UNIX: %q (%d bytes)", p, len(p))
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if _, err := New(ctx, Options{Sock: sock}); err != nil {
		t.Fatalf("New: %v", err)
	}

	// Give the second listener a moment to bind.
	deadline := time.Now().Add(2 * time.Second)
	for {
		if _, err := net.Dial("unix", sock+".decide"); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("decide socket never came up")
		}
		time.Sleep(10 * time.Millisecond)
	}

	resp := decideOverSocket(t, sock+".decide", `{"verb":"edit","path":"a.py","agent":"sess1","want":"decision"}`)
	if resp["rung"] != float64(0) {
		t.Fatalf("expected a real rung-0 answer on the decide socket, got %+v", resp)
	}
}

func decideOverSocket(t *testing.T, sock, line string) map[string]any {
	t.Helper()
	conn, err := net.Dial("unix", sock)
	if err != nil {
		t.Fatalf("dial hook socket: %v", err)
	}
	defer conn.Close()

	if _, err := conn.Write([]byte(line + "\n")); err != nil {
		t.Fatalf("write: %v", err)
	}
	if uc, ok := conn.(*net.UnixConn); ok {
		_ = uc.CloseWrite()
	}

	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	reply, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil {
		t.Fatalf("read reply: %v", err)
	}
	var out map[string]any
	if err := json.Unmarshal([]byte(reply), &out); err != nil {
		t.Fatalf("reply not JSON: %q: %v", reply, err)
	}
	return out
}

// hookBinary is the real cpp/build/ap-hook, not a Go stand-in. It exists
// only when the cpp toolchain has run — scripts/ci-local.sh's cpp job, a
// separate job from this one — so a Go-only run skips rather than fails.
func hookBinary(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatalf("resolve repo root: %v", err)
	}
	bin := filepath.Join(root, "cpp", "build", "ap-hook")
	if _, err := os.Stat(bin); err != nil {
		t.Skipf("ap-hook not built, skipping: %s\nbuild it with: cmake -S cpp -B cpp/build && cmake --build cpp/build", bin)
	}
	return bin
}

// TestRoundTripSpecialCharsHookToDaemon is #19's missing DoD item: a path
// with a quote, a backslash, a newline and a non-ASCII character has to
// survive from the hook's hand-rolled JSON writer to the daemon's
// encoding/json reader byte for byte. cpp/tests/test_hook.cpp already pins
// each of those characters individually against build_event's own output —
// the hook checked against itself, in isolation. This drives the real
// ap-hook binary against a real daemon over a real unix socket, the
// boundary a live install actually crosses, and reads back what the daemon
// decoded.
func TestRoundTripSpecialCharsHookToDaemon(t *testing.T) {
	bin := hookBinary(t)

	sock := filepath.Join(t.TempDir(), "s")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	d, err := New(ctx, Options{Sock: sock})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	// Quote, backslash, newline, non-ASCII — all four in one path, the
	// combination #19 asked for and nothing under go/ exercised.
	const wantPath = "/repo/a\"quote\\backslash\nnewline_日本語_🚀.py"

	type toolInput struct {
		FilePath string `json:"file_path"`
	}
	payload, err := json.Marshal(struct {
		ToolName  string    `json:"tool_name"`
		ToolInput toolInput `json:"tool_input"`
		SessionID string    `json:"session_id"`
	}{
		ToolName:  "Read", // one-way event: no decision wait, one socket hop
		ToolInput: toolInput{FilePath: wantPath},
		SessionID: "roundtrip-agent",
	})
	if err != nil {
		t.Fatalf("marshal hook payload: %v", err)
	}

	cmd := exec.CommandContext(ctx, bin)
	cmd.Env = append(os.Environ(), "AGENT_PRESENCE_SOCK="+sock)
	cmd.Stdin = bytes.NewReader(payload)
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("ap-hook: %v", err)
	}
	if len(out) != 0 {
		t.Fatalf("ap-hook printed a decision for a one-way event: %q", out)
	}

	deadline := time.Now().Add(2 * time.Second)
	for {
		for _, p := range d.presence.Peers() {
			if p.Path == wantPath {
				if p.Verb != "read" {
					t.Fatalf("path round-tripped but verb did not: got %q", p.Verb)
				}
				return // byte for byte: quote, backslash, newline and non-ASCII intact
			}
		}
		if time.Now().After(deadline) {
			var seen []string
			for _, p := range d.presence.Peers() {
				seen = append(seen, p.Path)
			}
			t.Fatalf("daemon never saw the round-tripped path; peers seen: %q", seen)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// TestDecideDurationObserves is the wiring check
// for ap_decide_duration_seconds: every answered decision request adds
// exactly one histogram observation, over the real decision socket a hook
// actually uses, not a direct call into onRequest.
func TestDecideDurationObserves(t *testing.T) {
	m := metrics.New()
	sock := filepath.Join(t.TempDir(), "s")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if _, err := New(ctx, Options{Sock: sock, Metrics: m}); err != nil {
		t.Fatalf("New: %v", err)
	}

	decideOverSocket(t, sock, `{"verb":"edit","path":"src/auth.py","agent":"sess1","want":"decision"}`)
	decideOverSocket(t, sock, `{"verb":"edit","path":"src/other.py","agent":"sess1","want":"decision"}`)

	families, err := m.Gatherer().Gather()
	if err != nil {
		t.Fatalf("gather: %v", err)
	}
	var count uint64
	for _, fam := range families {
		if fam.GetName() == "ap_decide_duration_seconds" {
			count = fam.GetMetric()[0].GetHistogram().GetSampleCount()
		}
	}
	if count != 2 {
		t.Fatalf("ap_decide_duration_seconds sample count = %d, want 2", count)
	}
}

// TestOnLineRecordsRegionKeyShape is the wiring check for RegionKey: a
// path inside the repo root goes on the wire relative and is counted
// "relative"; a path outside it (or with no root at all) keeps its
// absolute form and is counted "absolute" — the live regression detector
// for the bug where a region was named by its raw filesystem path.
func TestOnLineRecordsRegionKeyShape(t *testing.T) {
	fr := &fakeRelay{joined: make(chan wire.Join, 4)}
	srv := httptest.NewServer(http.HandlerFunc(fr.handler))
	defer srv.Close()

	m := metrics.New()
	sock := filepath.Join(t.TempDir(), "s")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	d, err := New(ctx, Options{
		Sock:     sock,
		RelayURL: "ws://" + srv.Listener.Addr().String() + "/",
		Room:     "test-room",
		Agent:    "go-daemon-test",
		Human:    "mohsen",
		Metrics:  m,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	select {
	case <-fr.joined:
	case <-time.After(5 * time.Second):
		t.Fatal("daemon never joined the room")
	}

	// No Root configured, so this stays absolute — same shape a checkout
	// with no discoverable repo root produces.
	d.onLine([]byte(`{"verb":"edit","path":"/abs/path/auth.py","agent":"sess1"}`))

	deadline := time.Now().Add(5 * time.Second)
	for {
		families, err := m.Gatherer().Gather()
		if err != nil {
			t.Fatalf("gather: %v", err)
		}
		var absolute uint64
		for _, fam := range families {
			if fam.GetName() != "ap_region_keys_total" {
				continue
			}
			for _, metric := range fam.GetMetric() {
				for _, lp := range metric.GetLabel() {
					if lp.GetName() == "shape" && lp.GetValue() == "absolute" {
						absolute = uint64(metric.GetCounter().GetValue())
					}
				}
			}
		}
		if absolute == 1 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("ap_region_keys_total{shape=\"absolute\"} never reached 1")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// TestTickWritesSnapshot covers the tick loop's write path, which nothing
// else here touches — it does not exercise the Store(false)-before-Peers()
// ordering fix itself (both orderings converge on the same file within one
// snapshotTickMs rewrite, so no black-box test can discriminate them); it
// just proves a Touch reaches the snapshot file at all.
func TestTickWritesSnapshot(t *testing.T) {
	sock := filepath.Join(t.TempDir(), "s")
	if p := sock + ".decide"; len(p) > 100 {
		t.Fatalf("socket path too long for AF_UNIX: %q (%d bytes)", p, len(p))
	}
	snap := filepath.Join(t.TempDir(), "snapshot")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	d, err := New(ctx, Options{Sock: sock, Snapshot: snap})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	d.onLine([]byte(`{"verb":"edit","path":"src/auth.py","agent":"sess1","human":"mohsen"}`))

	deadline := time.Now().Add(2 * time.Second)
	for {
		data, err := os.ReadFile(snap)
		if err == nil && bytes.Contains(data, []byte(`"human":"mohsen"`)) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("snapshot never picked up the touch; last read: %q, err: %v", data, err)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// BenchmarkOnRequestDecide is the decide path with and without metrics —
// the comparison Options.Metrics's nil case exists to keep cheap. Run with
// -benchmem: allocs/op is what "no allocation on that path" claims, not
// ns/op alone.
func BenchmarkOnRequestDecide(b *testing.B) {
	for _, tc := range []struct {
		name string
		reg  *metrics.Registry
	}{
		{"NoMetrics", nil},
		{"WithMetrics", metrics.New()},
	} {
		b.Run(tc.name, func(b *testing.B) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			sock := filepath.Join(b.TempDir(), "s")
			d, err := New(ctx, Options{Sock: sock, Metrics: tc.reg})
			if err != nil {
				b.Fatalf("New: %v", err)
			}
			line := []byte(`{"verb":"edit","path":"src/auth.py","agent":"sess1","want":"decision"}`)

			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				d.onRequest(line)
			}
		})
	}
}
