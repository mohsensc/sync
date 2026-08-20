package hooksock

import (
	"bufio"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// sockPath keeps the AF_UNIX path short. t.TempDir() alone is well inside
// the 104-byte sun_path limit on macOS for a short test name, but a nested
// subtest or a longer TempDir prefix can push past it — see #24 in the
// issue: this is exactly the gotcha it's there to catch. One-letter file
// name keeps the margin as wide as possible without hardcoding /tmp and
// fighting the test's own cleanup.
func sockPath(t *testing.T) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "s")
	if len(p) > 100 {
		t.Fatalf("socket path too long for AF_UNIX: %q (%d bytes)", p, len(p))
	}
	return p
}

func TestRoundTripEventOnly(t *testing.T) {
	s := New(sockPath(t))
	lines := make(chan string, 4)
	s.OnLine(func(line []byte) { lines <- string(line) })
	// No OnRequest: an event-only line must get no reply, same as the C++
	// server when nothing is registered to answer.
	if err := s.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer s.Stop()

	conn, err := net.Dial("unix", s.Addr())
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer conn.Close()

	if _, err := conn.Write([]byte(`{"verb":"edit","path":"a.py","agent":"sess1"}` + "\n")); err != nil {
		t.Fatalf("Write: %v", err)
	}

	select {
	case got := <-lines:
		if got != `{"verb":"edit","path":"a.py","agent":"sess1"}` {
			t.Fatalf("onLine got %q", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("onLine callback never fired")
	}
}

func TestRoundTripDecisionRequest(t *testing.T) {
	s := New(sockPath(t))
	s.OnRequest(func(line []byte) []byte {
		return []byte(`{"rung":0,"effect":"silent"}`)
	})
	if err := s.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer s.Stop()

	conn, err := net.Dial("unix", s.Addr())
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer conn.Close()

	req := `{"verb":"edit","path":"a.py","agent":"sess1","want":"decision"}` + "\n"
	if _, err := conn.Write([]byte(req)); err != nil {
		t.Fatalf("Write: %v", err)
	}
	// Mirrors the hook's own half-close: it stops writing and waits for a
	// line back on the same connection.
	if uc, ok := conn.(*net.UnixConn); ok {
		_ = uc.CloseWrite()
	}

	r := bufio.NewReader(conn)
	line, err := r.ReadString('\n')
	if err != nil {
		t.Fatalf("ReadString: %v", err)
	}
	if line != `{"rung":0,"effect":"silent"}`+"\n" {
		t.Fatalf("reply = %q", line)
	}
}

func TestNoAnswerMeansNoReply(t *testing.T) {
	// A responder that returns nil must write nothing back — the hook reads
	// that as "no answer" and allows, same as an empty line on the C++
	// socket.
	s := New(sockPath(t))
	s.OnRequest(func(line []byte) []byte { return nil })
	if err := s.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer s.Stop()

	conn, err := net.Dial("unix", s.Addr())
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer conn.Close()

	if _, err := conn.Write([]byte(`{"verb":"edit","path":"a.py","agent":"s","want":"decision"}` + "\n")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if uc, ok := conn.(*net.UnixConn); ok {
		_ = uc.CloseWrite()
	}

	_ = conn.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
	buf := make([]byte, 16)
	n, err := conn.Read(buf)
	if n != 0 {
		t.Fatalf("expected no bytes back, got %q", buf[:n])
	}
	if err == nil {
		t.Fatal("expected EOF or timeout, got nil error")
	}
}

// TestStartWhenLive is #88: a second Start() against a path a live server
// is already listening on must fail instead of unlinking the socket out
// from under it.
func TestStartWhenLive(t *testing.T) {
	p := sockPath(t)

	first := New(p)
	if err := first.Start(); err != nil {
		t.Fatalf("first Start: %v", err)
	}
	defer first.Stop()

	second := New(p)
	err := second.Start()
	if err == nil {
		second.Stop()
		t.Fatal("second Start succeeded, expected an already-running error")
	}
	if !strings.Contains(err.Error(), "already running") || !strings.Contains(err.Error(), p) {
		t.Fatalf("error = %q, want it to say already running and name %q", err, p)
	}

	// The first server must still be reachable — the second Start must not
	// have unlinked its socket.
	conn, dialErr := net.Dial("unix", p)
	if dialErr != nil {
		t.Fatalf("first server unreachable after a stolen Start attempt: %v", dialErr)
	}
	conn.Close()
}

// TestStartOnStaleSocketSucceeds is the other half: a socket file left
// behind by a crashed daemon (nothing listening) must not block a fresh
// Start, same as before this fix.
func TestStartOnStaleSocketSucceeds(t *testing.T) {
	p := sockPath(t)

	// Create a stale socket file the way a crash leaves one: bind, then
	// close without unlinking.
	addr, err := net.ResolveUnixAddr("unix", p)
	if err != nil {
		t.Fatalf("ResolveUnixAddr: %v", err)
	}
	ln, err := net.ListenUnix("unix", addr)
	if err != nil {
		t.Fatalf("ListenUnix: %v", err)
	}
	// UnixListener unlinks its own path on Close by default — turn that off
	// so Close() leaves exactly what a crash leaves: a socket file with
	// nothing behind it.
	ln.SetUnlinkOnClose(false)
	if err := ln.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if _, err := os.Stat(p); err != nil {
		t.Fatalf("expected the stale socket file to still exist: %v", err)
	}

	s := New(p)
	if err := s.Start(); err != nil {
		t.Fatalf("Start on stale socket: %v", err)
	}
	defer s.Stop()

	conn, err := net.Dial("unix", p)
	if err != nil {
		t.Fatalf("Dial after Start on stale socket: %v", err)
	}
	conn.Close()
}

// TestStartSetsSocketMode is the other half of #88: docs/threat-model.md
// treats filesystem permission as the hook<->daemon boundary, which only
// holds if the socket isn't left at ListenUnix's default 0777&^umask.
func TestStartSetsSocketMode(t *testing.T) {
	p := sockPath(t)
	s := New(p)
	if err := s.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer s.Stop()

	fi, err := os.Stat(p)
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}
	if mode := fi.Mode().Perm(); mode != 0o600 {
		t.Fatalf("socket mode = %o, want 0600", mode)
	}
}

// TestStopAfterLoss makes sure a Server that lost
// the race in Start (found a live listener, errored out) doesn't remove
// that listener's socket when Stop is called on it anyway — a caller that
// treats "New, Start, defer Stop" as one unconditional sequence must not be
// able to take down someone else's daemon this way.
func TestStopAfterLoss(t *testing.T) {
	p := sockPath(t)

	live := New(p)
	if err := live.Start(); err != nil {
		t.Fatalf("live Start: %v", err)
	}
	defer live.Stop()

	loser := New(p)
	if err := loser.Start(); err == nil {
		loser.Stop()
		t.Fatal("loser Start succeeded, expected an already-running error")
	}
	loser.Stop() // must be a no-op: loser never bound p

	conn, err := net.Dial("unix", p)
	if err != nil {
		t.Fatalf("live server's socket gone after loser.Stop(): %v", err)
	}
	conn.Close()
}
