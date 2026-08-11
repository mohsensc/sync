package main

// The launchable surface: the compiled binary, speaking MCP over stdio.
// Port of the MCP-specific half of python/tests/test_entrypoints.py — the
// relay-process half of that file has no Go equivalent to port, since the
// relay stays Python.
//
// Unlike the rest of this package's tests, these build and exec the actual
// binary: importing a package proves nothing about whether the stdio
// transport, the exit code, and the stdout/stderr split all hold up in a
// real process, which is the whole reason that Python file existed.

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

var binPath string

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "agent-presence-mcp-test")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer os.RemoveAll(dir)

	binPath = filepath.Join(dir, "agent-presence-mcp")
	build := exec.Command("go", "build", "-o", binPath, ".")
	if out, err := build.CombinedOutput(); err != nil {
		fmt.Fprintf(os.Stderr, "go build: %v\n%s", err, out)
		os.Exit(1)
	}

	os.Exit(m.Run())
}

// syncBuffer is an io.Writer safe to read from one goroutine while the
// subprocess writes from another — cmd.Stderr is written on the child's
// pipe-relay goroutine, and tests read it after the process exits.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// stdioClient is the smallest MCP client that proves the transport works:
// JSON-RPC, one object per line, on the process's own stdin/stdout — the
// Go mirror of test_entrypoints.py's StdioClient.
type stdioClient struct {
	t      *testing.T
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout *bufio.Reader
	stderr *syncBuffer
	nextID int
}

func startMCP(t *testing.T, env []string, extraArgs ...string) *stdioClient {
	t.Helper()
	cmd := exec.Command(binPath, extraArgs...)
	cmd.Env = env
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	stderr := &syncBuffer{}
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	c := &stdioClient{t: t, cmd: cmd, stdin: stdin, stdout: bufio.NewReader(stdout), stderr: stderr}
	t.Cleanup(func() {
		stdin.Close()
		done := make(chan error, 1)
		go func() { done <- cmd.Wait() }()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			cmd.Process.Kill()
		}
	})
	return c
}

func (c *stdioClient) write(obj map[string]any) {
	c.t.Helper()
	data, err := json.Marshal(obj)
	if err != nil {
		c.t.Fatal(err)
	}
	if _, err := c.stdin.Write(append(data, '\n')); err != nil {
		c.t.Fatal(err)
	}
}

func (c *stdioClient) notify(method string, params map[string]any) {
	c.write(map[string]any{"jsonrpc": "2.0", "method": method, "params": params})
}

func (c *stdioClient) request(method string, params map[string]any) map[string]any {
	c.t.Helper()
	c.nextID++
	c.write(map[string]any{"jsonrpc": "2.0", "id": c.nextID, "method": method, "params": params})
	line, err := c.stdout.ReadString('\n')
	if err != nil {
		c.t.Fatalf("reading reply to %s: %v\nstderr:\n%s", method, err, c.stderr.String())
	}
	var reply map[string]any
	if err := json.Unmarshal([]byte(line), &reply); err != nil {
		c.t.Fatalf("reply to %s was not JSON: %v\n%s", method, err, line)
	}
	return reply
}

func (c *stdioClient) handshake() map[string]any {
	reply := c.request("initialize", map[string]any{
		"protocolVersion": "2025-06-18",
		"capabilities":    map[string]any{},
		"clientInfo":      map[string]any{"name": "test", "version": "0"},
	})
	c.notify("notifications/initialized", map[string]any{})
	return reply
}

func cleanEnv(extra ...string) []string {
	var env []string
	for _, kv := range os.Environ() {
		if strings.HasPrefix(kv, "AGENT_PRESENCE_") {
			continue
		}
		env = append(env, kv)
	}
	return append(env, extra...)
}

func TestMCPServerCompletesAStdioHandshake(t *testing.T) {
	c := startMCP(t, cleanEnv("AGENT_PRESENCE_ROOM=r1", "AGENT_PRESENCE_AGENT=a1", "AGENT_PRESENCE_HUMAN=sara"))
	reply := c.handshake()
	result, _ := reply["result"].(map[string]any)
	serverInfo, _ := result["serverInfo"].(map[string]any)
	if serverInfo["name"] != "agent-presence" {
		t.Fatalf("got %+v", reply)
	}
}

func TestMCPServerListsItsFourToolsOverStdio(t *testing.T) {
	c := startMCP(t, cleanEnv("AGENT_PRESENCE_ROOM=r1", "AGENT_PRESENCE_AGENT=a1", "AGENT_PRESENCE_HUMAN=sara"))
	c.handshake()
	listed := c.request("tools/list", map[string]any{})
	result, _ := listed["result"].(map[string]any)
	tools, _ := result["tools"].([]any)
	if len(tools) != 4 {
		t.Fatalf("got %d tools, want 4: %+v", len(tools), listed)
	}
	// The SDK's tools/list orders alphabetically regardless of
	// registration order (unlike mcp_server.py's, which preserved
	// tool_descriptors()' order) — a set comparison, not a sequence one,
	// since nothing about the protocol assigns meaning to list position.
	want := map[string]bool{"who_else_is_here": true, "claim_work": true, "release": true, "respond": true}
	got := map[string]bool{}
	for _, tl := range tools {
		m, _ := tl.(map[string]any)
		name, _ := m["name"].(string)
		got[name] = true
	}
	for name := range want {
		if !got[name] {
			t.Fatalf("got %v, missing %q", got, name)
		}
	}
}

func TestMCPServerReachesARealRelayOverStdio(t *testing.T) {
	// A tiny relay of this test's own, so this doesn't depend on Python
	// being anywhere near the machine running `go test` — see
	// go/internal/mcptools/tools_test.go's scriptedRelay for the same
	// convention.
	relay := newTestRelay(t)
	c := startMCP(t, cleanEnv(
		"AGENT_PRESENCE_ROOM=r1", "AGENT_PRESENCE_AGENT=a1", "AGENT_PRESENCE_HUMAN=sara",
		"AGENT_PRESENCE_RELAY="+relay.url,
	))
	c.handshake()

	args := map[string]any{"path": "src/db.py", "symbol": "query", "intent": "add index"}
	first := c.request("tools/call", map[string]any{"name": "claim_work", "arguments": args})
	assertToolJSON(t, first, map[string]any{"granted": true})

	// Same relay: releasing has to make the region free again, which is
	// only observable if the call really reached the relay's state.
	c.request("tools/call", map[string]any{
		"name":      "release",
		"arguments": map[string]any{"path": "src/db.py", "symbol": "query"},
	})
	again := c.request("tools/call", map[string]any{"name": "claim_work", "arguments": args})
	assertToolJSON(t, again, map[string]any{"granted": true})
}

func TestMCPServerExitsZeroWhenTheClientClosesStdin(t *testing.T) {
	c := startMCP(t, cleanEnv("AGENT_PRESENCE_ROOM=r1"))
	c.handshake()
	c.stdin.Close()

	done := make(chan error, 1)
	go func() { done <- c.cmd.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("process did not exit 0: %v\nstderr:\n%s", err, c.stderr.String())
		}
	case <-time.After(5 * time.Second):
		t.Fatal("process did not exit after stdin closed")
	}
}

func TestNothingButProtocolReachesStdout(t *testing.T) {
	// Logs on stdout would corrupt the transport, so the log line naming
	// the room has to be on stderr, and everything on stdout has to stay
	// parseable JSON-RPC.
	c := startMCP(t, cleanEnv("AGENT_PRESENCE_ROOM=r1"))
	c.handshake()
	c.stdin.Close()
	c.cmd.Wait()

	rest, _ := io.ReadAll(c.stdout)
	for _, line := range strings.Split(string(rest), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var v any
		if err := json.Unmarshal([]byte(line), &v); err != nil {
			t.Fatalf("non-JSON on stdout: %q", line)
		}
	}
	if !strings.Contains(c.stderr.String(), "room=r1") {
		t.Fatalf("stderr = %q, want it to name room=r1", c.stderr.String())
	}
}

func TestMCPFlagsPinRoomAgentAndHuman(t *testing.T) {
	// Env says something else, so this also pins the precedence: flags win.
	c := startMCP(t, cleanEnv("AGENT_PRESENCE_ROOM=from-env"),
		"-room", "r9", "-agent", "a9", "-human", "h9")
	c.stdin.Close()

	done := make(chan error, 1)
	go func() { done <- c.cmd.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("process did not exit 0: %v\nstderr:\n%s", err, c.stderr.String())
		}
	case <-time.After(5 * time.Second):
		t.Fatal("process did not exit after stdin closed")
	}
	if !strings.Contains(c.stderr.String(), "room=r9 agent=a9 human=h9") {
		t.Fatalf("stderr = %q, want it to name room=r9 agent=a9 human=h9", c.stderr.String())
	}
}

func assertToolJSON(t *testing.T, reply map[string]any, want map[string]any) {
	t.Helper()
	result, _ := reply["result"].(map[string]any)
	content, _ := result["content"].([]any)
	if len(content) != 1 {
		t.Fatalf("got %+v", reply)
	}
	first, _ := content[0].(map[string]any)
	text, _ := first["text"].(string)
	var got map[string]any
	if err := json.Unmarshal([]byte(text), &got); err != nil {
		t.Fatalf("tool text %q was not JSON: %v", text, err)
	}
	for k, v := range want {
		if got[k] != v {
			t.Fatalf("got %+v, want %s=%v", got, k, v)
		}
	}
}

// -- a tiny relay for TestMCPServerReachesARealRelayOverStdio ------------

type testRelay struct{ url string }

func newTestRelay(t *testing.T) testRelay {
	t.Helper()
	held := map[string]string{}
	upgrader := websocket.Upgrader{}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		for {
			_, data, err := conn.ReadMessage()
			if err != nil {
				return
			}
			var msg map[string]any
			if err := json.Unmarshal(data, &msg); err != nil {
				continue
			}
			switch msg["type"] {
			case "join":
				conn.WriteJSON(map[string]any{"type": "leases", "leases": []any{}})
			case "claim":
				region, _ := msg["region"].(map[string]any)
				path, _ := region["path"].(string)
				if _, taken := held[path]; !taken {
					held[path] = "them"
					conn.WriteJSON(map[string]any{"type": "claim_result", "granted": true})
				} else {
					conn.WriteJSON(map[string]any{
						"type": "claim_result", "granted": false, "held_by": "other", "decision": "abort",
					})
				}
			case "release":
				region, _ := msg["region"].(map[string]any)
				path, _ := region["path"].(string)
				delete(held, path)
			}
		}
	})}
	go srv.Serve(ln)
	t.Cleanup(func() { srv.Close() })
	return testRelay{url: "ws://" + ln.Addr().String() + "/"}
}
