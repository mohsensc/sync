package hooksock

import (
	"bufio"
	"net"
	"path/filepath"
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
