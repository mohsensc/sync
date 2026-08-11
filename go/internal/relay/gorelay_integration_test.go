package relay

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/mohsensc/sync/go/internal/leases"
)

var listenRe = regexp.MustCompile(`relay listening on (\S+)`)

// buildGoRelay compiles cmd/gorelay into a temp dir once per test binary
// run. Building rather than assuming a prebuilt path keeps this runnable
// straight off `go test ./...` with no separate build step, matching how
// the rest of this repo's tests build their own C++ fixtures on demand.
func buildGoRelay(t *testing.T) (string, error) {
	t.Helper()
	dir := t.TempDir()
	bin := filepath.Join(dir, "gorelay")
	cmd := exec.Command("go", "build", "-o", bin, "github.com/mohsensc/sync/go/cmd/gorelay")
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("go build cmd/gorelay: %w", err)
	}
	return bin, nil
}

func waitForListenLine(stderr interface{ Read([]byte) (int, error) }, timeout time.Duration) (string, error) {
	type result struct {
		addr string
		err  error
	}
	ch := make(chan result, 1)
	go func() {
		scanner := bufio.NewScanner(stderr)
		for scanner.Scan() {
			line := scanner.Text()
			if m := listenRe.FindStringSubmatch(line); m != nil {
				ch <- result{addr: m[1]}
				return
			}
		}
		ch <- result{err: fmt.Errorf("stream closed before a listen line appeared")}
	}()
	select {
	case r := <-ch:
		return r.addr, r.err
	case <-time.After(timeout):
		return "", fmt.Errorf("timed out waiting for a listen line")
	}
}

// TestClientAgainstRealGoRelay builds the real gorelay binary (issue #40)
// and points this package's Client — the same one go/cmd/godaemon uses — at
// it, over a real socket. This is the hard constraint from issue #40: the
// Go relay's wire protocol has to work against the Go daemon's existing
// client unchanged, not just against hand-rolled test frames.
func TestClientAgainstRealGoRelay(t *testing.T) {
	bin, err := buildGoRelay(t)
	if err != nil {
		t.Skipf("could not build gorelay for the integration check: %s", err)
	}

	cmd := exec.Command(bin, "--host", "127.0.0.1", "--port", "0")
	stderr, err := cmd.StderrPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatalf("could not start gorelay: %s", err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _, _ = cmd.Process.Wait() })

	addr, err := waitForListenLine(stderr, 5*time.Second)
	if err != nil {
		t.Fatalf("gorelay never reported a listening address: %s", err)
	}

	cache := leases.New()
	client := New(Config{
		URL: "ws://" + addr, Room: "integration-room", Agent: "godaemon-1", Human: "sara",
	}, cache)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go client.Run(ctx)

	deadline := time.Now().Add(5 * time.Second)
	for !client.Open() {
		if time.Now().After(deadline) {
			t.Fatalf("client never reached StateOpen against the real relay (last error: %s)", client.LastError())
		}
		time.Sleep(10 * time.Millisecond)
	}

	// A second, raw connection claims the same region the daemon's client
	// should learn about via ordinary fan-out.
	raw, _, err := websocket.DefaultDialer.Dial("ws://"+addr, nil)
	if err != nil {
		t.Fatalf("raw dial: %s", err)
	}
	defer raw.Close()
	send(t, raw, map[string]any{"type": "join", "room": "integration-room", "agent": "other-agent", "human": "dev"})
	if _, _, err := raw.ReadMessage(); err != nil { // leases snapshot
		t.Fatalf("raw join reply: %s", err)
	}
	send(t, raw, map[string]any{
		"type": "claim", "intent": "refactor sign_in",
		"region": map[string]any{"path": "src/auth.py", "symbol": "sign_in", "lines": nil},
	})
	if _, _, err := raw.ReadMessage(); err != nil { // claim_result
		t.Fatalf("raw claim reply: %s", err)
	}

	deadline = time.Now().Add(5 * time.Second)
	for {
		if l, ok := cache.ConflictForFile("src/auth.py", "godaemon-1", nowMs()); ok {
			if l.Agent != "other-agent" {
				t.Fatalf("cache has the wrong holder: %+v", l)
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("the daemon's relay client never learned about the other agent's claim over the real go relay's wire")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func send(t *testing.T, ws *websocket.Conn, msg map[string]any) {
	t.Helper()
	b, err := json.Marshal(msg)
	if err != nil {
		t.Fatal(err)
	}
	if err := ws.WriteMessage(websocket.TextMessage, b); err != nil {
		t.Fatal(err)
	}
}
