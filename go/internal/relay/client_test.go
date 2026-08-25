package relay

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/mohsensc/sync/go/internal/leases"
	"github.com/mohsensc/sync/go/internal/metrics"
	"github.com/mohsensc/sync/go/internal/policy"
	"github.com/mohsensc/sync/go/internal/wire"
)

// gaugeValue reads back one no-label gauge's current value straight from
// the registry's own Gatherer — see metrics.Registry.Gatherer's doc
// comment on why that method exists.
func gaugeValue(t *testing.T, m *metrics.Registry, name string) float64 {
	t.Helper()
	families, err := m.Gatherer().Gather()
	if err != nil {
		t.Fatalf("gather: %v", err)
	}
	for _, fam := range families {
		if fam.GetName() != name {
			continue
		}
		for _, metric := range fam.GetMetric() {
			return metric.GetGauge().GetValue()
		}
	}
	return 0
}

// fakeRelay is just enough of serve.py + relay.py to drive Client through a
// real join, a real leases snapshot and a real presence fan-out over an
// actual TCP + websocket connection. It is not a reimplementation of the
// Python relay's protocol logic — see python/tests for that coverage — only
// of the frames this test needs on the wire.
type fakeRelay struct {
	upgrader websocket.Upgrader
	joined   chan wire.Join
}

func newFakeRelay() *fakeRelay {
	return &fakeRelay{joined: make(chan wire.Join, 4)}
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
		if err := json.Unmarshal(data, &env); err != nil {
			continue
		}
		if env.Type != "join" {
			continue
		}
		var j wire.Join
		_ = json.Unmarshal(data, &j)
		f.joined <- j

		// Same order the real relay answers a join in: a leases snapshot
		// first, then whatever else this test wants to push.
		snapshot := wire.Leases{Type: "leases", Leases: []wire.LeaseFrame{
			{
				Agent:  "other-agent",
				Human:  "sara",
				Intent: "refactor sign_in",
				Region: wire.Region{Path: "src/auth.py"},
			},
		}}
		if err := conn.WriteJSON(snapshot); err != nil {
			return
		}

		peer := wire.Presence{
			Agent: "other-agent",
			Human: "sara",
			Verb:  "edit",
			Region: wire.Region{
				Path: "src/auth.py",
			},
		}
		peerFrame := map[string]any{
			"type":   "presence",
			"agent":  peer.Agent,
			"human":  peer.Human,
			"verb":   peer.Verb,
			"region": peer.Region,
		}
		if err := conn.WriteJSON(peerFrame); err != nil {
			return
		}

		// Then read whatever the client sends and just keep the connection
		// open until the test tears it down.
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}
}

func TestClientJoinsRoomAndReceivesFrames(t *testing.T) {
	fr := newFakeRelay()
	srv := httptest.NewServer(http.HandlerFunc(fr.handler))
	defer srv.Close()

	url := "ws://" + srv.Listener.Addr().String() + "/"

	lc := leases.New()
	peerCh := make(chan wire.Presence, 4)

	c := New(Config{
		URL:   url,
		Room:  "test-room",
		Agent: "go-daemon-test",
		Human: "mohsen",
	}, lc)
	c.OnPeer(func(p wire.Presence) { peerCh <- p })

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go c.Run(ctx)

	select {
	case j := <-fr.joined:
		if j.Room != "test-room" || j.Agent != "go-daemon-test" {
			t.Fatalf("unexpected join frame: %+v", j)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("relay never received a join frame")
	}

	select {
	case p := <-peerCh:
		if p.Agent != "other-agent" || p.Region.Path != "src/auth.py" {
			t.Fatalf("unexpected presence frame: %+v", p)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("client never delivered the presence frame")
	}

	// The leases snapshot sent right after join must have landed in the
	// cache the client was built with — this is the round trip that lets a
	// hook decision see a conflict a moment after the daemon joins.
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, _, ok := lc.Conflict("src/auth.py", []string{"go-daemon-test"}, time.Now().UnixMilli()); ok {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("leases snapshot from join never reached the cache")
		}
		time.Sleep(10 * time.Millisecond)
	}

	if !c.Open() {
		t.Fatalf("client state = %v, want Open", c.State())
	}
}

func TestClientReconnectsWithBackoff(t *testing.T) {
	// No listener at all: every dial fails, so this exercises the backoff
	// loop, not a live connection.
	lc := leases.New()
	c := New(Config{
		URL:        "ws://127.0.0.1:1", // refused immediately, no real service
		Room:       "test-room",
		Agent:      "go-daemon-test",
		BackoffMin: 10 * time.Millisecond,
		BackoffMax: 40 * time.Millisecond,
	}, lc)

	ctx, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
	defer cancel()
	c.Run(ctx)

	if c.ConnectAttempts() < 2 {
		t.Fatalf("connect attempts = %d, want at least 2 (backoff should have retried)", c.ConnectAttempts())
	}
	if c.State() != StateBackoff {
		t.Fatalf("state = %v, want StateBackoff", c.State())
	}
}

// syncBuf is bytes.Buffer plus the locking log.SetOutput needs: the log
// package serializes its own writers, but nothing serializes a test
// goroutine reading the buffer against the client's Run goroutine still
// writing to it, and this file's tests run with -race.
type syncBuf struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (s *syncBuf) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buf.Write(p)
}

func (s *syncBuf) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buf.String()
}

// TestClientLogsConnectStateTransitions is the fix for a relay SIGKILL,
// backoff, restart and successful reconcile leaving presenced's log
// completely empty — an operator had no way to tell "connected" from
// "retrying forever". The first accepted connection is dropped right
// after the handshake to force a real connect -> open -> lost -> backoff
// -> reconnect cycle on one URL, not just the never-connects case
// TestClientReconnectsWithBackoff already covers.
func TestClientLogsConnectStateTransitions(t *testing.T) {
	sb := &syncBuf{}
	orig := log.Writer()
	log.SetOutput(sb)
	defer log.SetOutput(orig)

	var accepted int32
	upgrader := websocket.Upgrader{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		if atomic.AddInt32(&accepted, 1) == 1 {
			conn.Close() // first connection: drop it, don't answer the join
			return
		}
		defer conn.Close()
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}))
	defer srv.Close()

	lc := leases.New()
	c := New(Config{
		URL:        "ws://" + srv.Listener.Addr().String() + "/",
		Room:       "test-room",
		Agent:      "go-daemon-test",
		BackoffMin: 10 * time.Millisecond,
		BackoffMax: 40 * time.Millisecond,
	}, lc)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	go c.Run(ctx)

	deadline := time.Now().Add(2 * time.Second)
	for !strings.Contains(sb.String(), "relay: reconnected to") {
		if time.Now().After(deadline) {
			t.Fatalf("never saw a reconnect log line; got:\n%s", sb.String())
		}
		time.Sleep(10 * time.Millisecond)
	}

	got := sb.String()
	for _, want := range []string{
		"relay: connecting to",
		"relay: connection lost:",
		"backing off",
		"relay: reconnected to",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("log output missing %q; got:\n%s", want, got)
		}
	}
}

func TestMalformedLeasesFrameLeavesTableUntouched(t *testing.T) {
	lc := leases.New()
	lc.Upsert(leases.RegionKey("a.py", ""), leases.Lease{Agent: "other", ExpiresAtMs: 90_000}, 0)

	c := New(Config{URL: "ws://127.0.0.1:1", Room: "r", Agent: "a"}, lc)

	// A "leases" frame whose "leases" key is null, missing, or not an array
	// must never wipe the table — see relay_client.cpp's on_text.
	for _, frame := range []string{
		`{"type":"leases","leases":null}`,
		`{"type":"leases"}`,
		`{"type":"leases","leases":"not an array"}`,
	} {
		if err := c.dispatch([]byte(frame)); err != nil {
			t.Fatalf("dispatch(%s): %v", frame, err)
		}
		if _, _, ok := lc.Conflict("a.py", []string{"me"}, 0); !ok {
			t.Fatalf("frame %s wiped the lease table", frame)
		}
	}

	// A real, empty array is the one thing allowed to clear it.
	if err := c.dispatch([]byte(`{"type":"leases","leases":[]}`)); err != nil {
		t.Fatal(err)
	}
	if _, _, ok := lc.Conflict("a.py", []string{"me"}, 0); ok {
		t.Fatal("an empty leases array must clear the table")
	}
}

// TestLeaseCacheDivergeCountsALiveLeaseTheSnapshotDrops is the case
// ap_lease_cache_divergence exists to catch: this daemon still believes in
// a lease, a fresh snapshot from the relay silently doesn't list it, and
// nothing before this gauge would have told anyone a hook could now be
// blocking on stale state.
func TestLeaseCacheDivergeCountsALiveLeaseTheSnapshotDrops(t *testing.T) {
	lc := leases.New()
	m := metrics.New()
	c := New(Config{URL: "ws://x", Room: "r", Agent: "me", Metrics: m}, lc)

	if err := c.dispatch([]byte(
		`{"type":"lease","agent":"other","region":{"path":"a.py"},"expires_in_ms":90000}`,
	)); err != nil {
		t.Fatal(err)
	}
	if err := c.dispatch([]byte(`{"type":"leases","leases":[]}`)); err != nil {
		t.Fatal(err)
	}

	if got := gaugeValue(t, m, "ap_lease_cache_divergence"); got != 1 {
		t.Fatalf("ap_lease_cache_divergence = %v, want 1", got)
	}
}

// TestLeaseCacheDivergeZeroWhenSnapshotAgrees is the other half: a
// snapshot that lists exactly the lease this daemon already believed in
// must not trip the gauge — divergence means disagreement, not "any
// reconcile happened at all".
func TestLeaseCacheDivergeZeroWhenSnapshotAgrees(t *testing.T) {
	lc := leases.New()
	m := metrics.New()
	c := New(Config{URL: "ws://x", Room: "r", Agent: "me", Metrics: m}, lc)

	if err := c.dispatch([]byte(
		`{"type":"lease","agent":"other","region":{"path":"a.py"},"expires_in_ms":90000}`,
	)); err != nil {
		t.Fatal(err)
	}
	if err := c.dispatch([]byte(
		`{"type":"leases","leases":[{"agent":"other","region":{"path":"a.py"},"expires_in_ms":90000}]}`,
	)); err != nil {
		t.Fatal(err)
	}

	if got := gaugeValue(t, m, "ap_lease_cache_divergence"); got != 0 {
		t.Fatalf("ap_lease_cache_divergence = %v, want 0", got)
	}
}

// TestLeaseCacheDivergeIgnoresAlreadyExpiredLeases is the fix for the
// gauge's own false positive: after any outage long enough for a held
// lease to age past its ExpiresAtMs, the relay's fresh snapshot legitimately
// drops it too — Conflict already skips an expired entry and nobody is
// blocking on it — so counting it would make the gauge loudest exactly
// when nothing is wrong.
func TestLeaseCacheDivergeIgnoresAlreadyExpiredLeases(t *testing.T) {
	lc := leases.New()
	m := metrics.New()
	c := New(Config{URL: "ws://x", Room: "r", Agent: "me", Metrics: m}, lc)

	// expires_in_ms of 0 is the earliest ExpiresAtMs toLease will ever
	// produce (a negative ttl is clamped to zero); sleeping past it makes
	// the entry genuinely expired by the time the snapshot arrives.
	if err := c.dispatch([]byte(
		`{"type":"lease","agent":"other","region":{"path":"a.py"},"expires_in_ms":0}`,
	)); err != nil {
		t.Fatal(err)
	}
	time.Sleep(5 * time.Millisecond)

	if err := c.dispatch([]byte(`{"type":"leases","leases":[]}`)); err != nil {
		t.Fatal(err)
	}

	if got := gaugeValue(t, m, "ap_lease_cache_divergence"); got != 0 {
		t.Fatalf("ap_lease_cache_divergence = %v, want 0 (an expired lease must not count)", got)
	}
}

func TestOutboundSurvivesBeforeConnect(t *testing.T) {
	// SendText before Run/connect ever happens must not be lost: it goes
	// through the same bounded queue a connected client drains, so it is
	// delivered on the first successful connection.
	fr := newFakeRelay()
	srv := httptest.NewServer(http.HandlerFunc(fr.handler))
	defer srv.Close()
	url := "ws://" + srv.Listener.Addr().String() + "/"

	lc := leases.New()
	c := New(Config{URL: url, Room: "r", Agent: "a"}, lc)
	c.SendText(wire.Marshal(wire.Event{Type: "event", Source: "hook", Verb: "edit", Agent: "a", Region: wire.Region{Path: "x"}}))

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go c.Run(ctx)

	select {
	case <-fr.joined:
	case <-time.After(5 * time.Second):
		t.Fatal("relay never received a join frame")
	}

	deadline := time.Now().Add(5 * time.Second)
	for c.SentMessages() < 2 { // join + the queued event
		if time.Now().After(deadline) {
			t.Fatalf("queued event was never sent, sent=%d", c.SentMessages())
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestDispatchLeaseCarriesHandoverDeadlineOntoTheLease(t *testing.T) {
	lc := leases.New()
	c := New(Config{URL: "ws://x", Room: "r", Agent: "me"}, lc)

	handoverInMs := 5000.0
	frame, _ := json.Marshal(map[string]any{
		"type": "lease", "agent": "other", "region": map[string]any{"path": "a.py"},
		"handover_in_ms": handoverInMs, "handover_to": "third",
	})
	if err := c.dispatch(frame); err != nil {
		t.Fatal(err)
	}
	held, _, ok := lc.Conflict("a.py", []string{"me"}, 0)
	if !ok || !held.HasHandover || held.HandoverTo != "third" {
		t.Fatalf("got %+v, ok=%v", held, ok)
	}
}

func TestDispatchLeaseHandoverOfOwnRegionRecordsLostNote(t *testing.T) {
	lc := leases.New()
	c := New(Config{URL: "ws://x", Room: "r", Agent: "me"}, lc)
	// This agent held the region first.
	lc.Upsert(leases.RegionKey("a.py", ""), leases.Lease{Agent: "me", ExpiresAtMs: 10_000}, 0)

	frame, _ := json.Marshal(map[string]any{
		"type": "lease", "state": "handover", "agent": "me",
		"region": map[string]any{"path": "a.py"},
		"to":     "other", "to_human": "sara",
	})
	if err := c.dispatch(frame); err != nil {
		t.Fatal(err)
	}

	if _, _, ok := lc.Conflict("a.py", []string{"someone-else"}, 0); ok {
		t.Fatal("the erased lease must be gone")
	}
	note, ok := lc.HandoverNoteFor("a.py", 0, leases.HandoverNoteMs)
	if !ok || note.To != "other" || note.ToHuman != "sara" {
		t.Fatalf("got %+v, ok=%v", note, ok)
	}
}

func TestDispatchLeaseHandoverOfSomeoneElsesRegionRecordsNoNote(t *testing.T) {
	lc := leases.New()
	c := New(Config{URL: "ws://x", Room: "r", Agent: "me"}, lc)

	frame, _ := json.Marshal(map[string]any{
		"type": "lease", "state": "handover", "agent": "other-agent",
		"region": map[string]any{"path": "a.py"},
		"to":     "third", "to_human": "sara",
	})
	if err := c.dispatch(frame); err != nil {
		t.Fatal(err)
	}
	if _, ok := lc.HandoverNoteFor("a.py", 0, leases.HandoverNoteMs); ok {
		t.Fatal("a handover of a region this agent never held must not record a lost note")
	}
}

func TestDispatchPolicyFrameClampsUnknownRungToBuiltinFloor(t *testing.T) {
	lc := leases.New()
	c := New(Config{URL: "ws://x", Room: "r", Agent: "me"}, lc)

	var got policy.Table
	var gotSource string
	called := false
	c.OnPolicy(func(floor policy.Table, source string) {
		got = floor
		gotSource = source
		called = true
	})

	frame, _ := json.Marshal(map[string]any{
		"type": "policy", "source": "org.toml",
		"floor": []string{"silent", "loud", "context", "deny", "silent"},
	})
	if err := c.dispatch(frame); err != nil {
		t.Fatal(err)
	}
	if !called {
		t.Fatal("OnPolicy callback never fired")
	}
	want := policy.Table{policy.Silent, policy.BuiltinFloor[1], policy.Context, policy.Deny, policy.Silent}
	if got != want {
		t.Fatalf("got %v, want %v (unknown name at rung1 falls back to BuiltinFloor there)", got, want)
	}
	if gotSource != "org.toml" {
		t.Fatalf("got source %q", gotSource)
	}
}

func TestDispatchPolicyFrameWrongLengthIsIgnored(t *testing.T) {
	lc := leases.New()
	c := New(Config{URL: "ws://x", Room: "r", Agent: "me"}, lc)
	called := false
	c.OnPolicy(func(policy.Table, string) { called = true })

	frame, _ := json.Marshal(map[string]any{"type": "policy", "floor": []string{"silent", "deny"}})
	if err := c.dispatch(frame); err != nil {
		t.Fatal(err)
	}
	if called {
		t.Fatal("a malformed policy frame must leave the floor untouched")
	}
}

// A relay that keeps the socket open but stops reading used to park
// writePump inside WriteMessage forever: readPump's deadline fired and
// closed `stop`, the ctx watcher took its <-stop branch without closing
// the connection, and the deferred conn.Close that would have unblocked
// the write was itself waiting on wg.Wait, which was waiting on writePump.
// The client leaked a goroutine and a socket, never reached backoff, and
// went on reporting StateOpen forever.
func TestStalledRelayDoesNotWedgeTheClient(t *testing.T) {
	// A server that completes the handshake, reads the join, then stops
	// reading entirely while holding the connection open.
	stalled := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		up := websocket.Upgrader{}
		ws, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		// Read the join, then never read again and never close.
		_, _, _ = ws.ReadMessage()
		close(stalled)
		<-r.Context().Done()
	}))
	defer srv.Close()

	c := New(Config{
		URL:          "ws" + strings.TrimPrefix(srv.URL, "http"),
		Room:         "r1",
		Agent:        "a1",
		PingInterval: 20 * time.Millisecond,
		IdleTimeout:  200 * time.Millisecond,
		WriteTimeout: 50 * time.Millisecond,
		BackoffMin:       10 * time.Millisecond,
		BackoffMax:       20 * time.Millisecond,
		OutboundCapacity: 500,
	}, leases.New())

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); c.Run(ctx) }()

	<-stalled

	// Push enough bytes that a write actually blocks. The stall alone is
	// not enough: WriteMessage only parks once the kernel send buffer is
	// full, so a client sending nothing but 20ms pings would drain to
	// backoff on readPump's deadline without ever exercising this.
	big := strings.Repeat("x", 256*1024)
	for i := 0; i < 200; i++ {
		c.SendText([]byte(big))
	}

	// The client must notice and fall through to backoff rather than
	// sitting at StateOpen with a parked writer.
	deadline := time.After(5 * time.Second)
	for {
		if c.State() == StateBackoff {
			break
		}
		select {
		case <-deadline:
			// Don't wait on done here: if writePump really is parked, Run
			// never returns and this would hang until the package timeout
			// instead of reporting the failure.
			cancel()
			t.Fatalf("client never left %v — writePump is wedged", c.State())
		case <-time.After(10 * time.Millisecond):
		}
	}

	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return after cancel — a pump is still parked")
	}
}

// backoff was reset the instant a dial succeeded, before the connection
// had proved anything. A relay that completes the handshake and then ends
// the session immediately every time — join_refused, a mid-restart drain,
// any policy path that closes after accept — therefore recomputed
// nextBackoff(0) on every failure, and nextBackoff returns the floor for a
// zero input. The result was a permanent retry spin at BackoffMin instead
// of escalation toward BackoffMax.
func TestHandshakeThenRejectStillEscalatesBackoff(t *testing.T) {
	var attempts atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		up := websocket.Upgrader{}
		ws, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		attempts.Add(1)
		// Accept, then end the session at once — the shape that spun.
		ws.Close()
	}))
	defer srv.Close()

	c := New(Config{
		URL:        "ws" + strings.TrimPrefix(srv.URL, "http"),
		Room:       "r1",
		Agent:      "a1",
		BackoffMin: 20 * time.Millisecond,
		BackoffMax: 400 * time.Millisecond,
	}, leases.New())

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); c.Run(ctx) }()

	// Long enough that a floor-pinned client would rack up far more
	// attempts than an escalating one. At a 20ms floor, 2s is ~100
	// attempts; escalating 20/40/80/160/320/400... is under 15.
	time.Sleep(2 * time.Second)
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return after cancel")
	}

	if got := attempts.Load(); got > 25 {
		t.Fatalf("%d connect attempts in 2s — backoff is pinned at the floor instead of escalating", got)
	}
	if attempts.Load() == 0 {
		t.Fatal("the test relay was never dialled")
	}
}
