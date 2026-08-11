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
// only when the cpp toolchain has run — a separate CI job from this one
// (.github/workflows/ci.yml) — so a Go-only run skips rather than fails.
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
