package devproxy

import (
	"bufio"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// TestProxyRoundTripsAWebsocketUpgrade is the reason this proxy is
// httputil.ReverseProxy and not something hand-rolled: vite's HMR client
// needs a real 101 Switching Protocols handshake followed by a full-duplex
// byte stream, and that has to survive going through the arbiter. This
// hijacks the upstream connection to fake a websocket peer, sends a real
// upgrade request through the arbiter's proxy, and proves bytes travel
// both ways after the 101 — not just that the status line says 101.
func TestProxyRoundTripsAWebsocketUpgrade(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hj, ok := w.(http.Hijacker)
		if !ok {
			t.Fatal("upstream test server does not support hijacking")
		}
		conn, buf, err := hj.Hijack()
		if err != nil {
			t.Fatalf("hijack: %v", err)
		}
		defer conn.Close()

		buf.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")
		buf.Flush()

		line, err := buf.ReadString('\n')
		if err != nil {
			t.Errorf("upstream read after upgrade: %v", err)
			return
		}
		buf.WriteString("echo:" + line)
		buf.Flush()
	}))
	defer upstream.Close()

	upstreamPort := mustPort(t, upstream.URL)

	lock := NewLock(90 * time.Second)
	if granted, _ := lock.Claim("me", "featA", 1, upstreamPort, false); !granted {
		t.Fatal("setup: claim must be granted on an empty lock")
	}

	arbiter := httptest.NewServer(Handler(lock))
	defer arbiter.Close()

	conn, err := net.Dial("tcp", strings.TrimPrefix(arbiter.URL, "http://"))
	if err != nil {
		t.Fatalf("dial arbiter: %v", err)
	}
	defer conn.Close()

	fmt.Fprintf(conn, "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n")

	br := bufio.NewReader(conn)
	statusLine, err := br.ReadString('\n')
	if err != nil {
		t.Fatalf("read status line: %v", err)
	}
	if !strings.Contains(statusLine, "101") {
		t.Fatalf("want a 101 Switching Protocols through the proxy, got %q", statusLine)
	}
	for {
		line, err := br.ReadString('\n')
		if err != nil {
			t.Fatalf("read headers: %v", err)
		}
		if line == "\r\n" {
			break
		}
	}

	fmt.Fprintf(conn, "ping\n")
	echoed, err := br.ReadString('\n')
	if err != nil {
		t.Fatalf("read echo after upgrade: %v", err)
	}
	if echoed != "echo:ping\n" {
		t.Fatalf("full-duplex byte stream after 101 did not round-trip, got %q", echoed)
	}
}

// TestProxyRefusesWithNoHolder proves the flip side: with no live lease
// the proxy fails clean instead of forwarding to a stale or nonexistent
// upstream.
func TestProxyRefusesWithNoHolder(t *testing.T) {
	lock := NewLock(90 * time.Second)
	arbiter := httptest.NewServer(Handler(lock))
	defer arbiter.Close()

	resp, err := http.Get(arbiter.URL + "/")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("want 503 with no holder, got %d", resp.StatusCode)
	}
}

func mustPort(t *testing.T, rawURL string) int {
	t.Helper()
	_, portStr, err := net.SplitHostPort(strings.TrimPrefix(rawURL, "http://"))
	if err != nil {
		t.Fatalf("split host:port from %q: %v", rawURL, err)
	}
	var port int
	if _, err := fmt.Sscanf(portStr, "%d", &port); err != nil {
		t.Fatalf("parse port from %q: %v", portStr, err)
	}
	return port
}
