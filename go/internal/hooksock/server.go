// Package hooksock is the daemon's half of the unix-socket protocol
// documented in cpp/hook/hook.hpp: line-delimited JSON in, an optional
// line-delimited JSON reply out. It is the Go mirror of
// cpp/daemon/socket_server.{hpp,cpp}, protocol-agnostic on purpose — same
// split as the C++ side, where SocketServer knows nothing about verbs or
// leases and the daemon wires callbacks into it.
//
// Concurrency shape is deliberately different from the C++ side, not just a
// port. socket_server.cpp exists to answer a hook inside a few-millisecond
// budget without one slow client parking the daemon's single-threaded loop,
// so it polls a shared listening fd and hand-doles each connection a sliver
// of wall-clock time. Go has no such loop to protect: each accepted
// connection gets its own goroutine, so a client that connects and says
// nothing costs one goroutine, not a slice of everyone else's budget. The
// per-connection deadline below exists only as a resource bound, not as
// head-of-line-blocking prevention — that problem doesn't exist here.
package hooksock

import (
	"bufio"
	"fmt"
	"net"
	"os"
	"sync"
	"time"
)

// LineHandler observes a line (an event) but produces no reply.
type LineHandler func(line []byte)

// RequestHandler answers a line. A nil return means no answer, which the
// hook reads as "allow" — same rule as an empty reply on the C++ socket.
type RequestHandler func(line []byte) []byte

type Server struct {
	path string

	// mu guards ln itself, not the listener's own use: Start writes it
	// once, Stop reads-and-clears it once. acceptLoop never touches this
	// field — it gets the listener as a parameter, captured at the moment
	// its goroutine is launched, specifically so Stop() closing (and
	// nilling) ln from another goroutine can never race with acceptLoop's
	// read of it. A first draft had acceptLoop read s.ln directly; -race
	// on a loaded CI runner (not on a quiet laptop) is what caught it.
	mu sync.Mutex
	ln *net.UnixListener

	onLine  LineHandler
	respond RequestHandler

	// ConnTimeout bounds one connection's total lifetime, mirroring the
	// per-connection read budget the C++ server enforces — except here it
	// is a resource cap, not a fairness mechanism (see package doc).
	ConnTimeout time.Duration
}

func New(path string) *Server {
	return &Server{path: path, ConnTimeout: 2 * time.Second}
}

func (s *Server) OnLine(h LineHandler)       { s.onLine = h }
func (s *Server) OnRequest(h RequestHandler) { s.respond = h }

// Start binds the socket and begins accepting in a background goroutine. A
// stale socket file from a crashed daemon must never prevent restart, same
// as SocketServer::start — but a live one must never be stolen out from
// under a running daemon, so a second presenced against the same socket
// path shares a journal/snapshot/policy cache with the first (see
// siblingPath in cmd/presenced/main.go) and hooks start getting answered by
// whichever daemon happens to win the race. So: probe first. Something
// answers the connect, this path is live, and Start fails instead of
// unlinking it. Nothing answers, the file (if any) is a stale leftover from
// a crash and is safe to remove before binding.
//
// probe → remove → bind is three steps, and none of the OS's own guarantees
// cover the gap between them: two cold starts against the same stale path
// can both probe and see "nothing answers", and the second one to run
// os.Remove isn't removing a stale file anymore — it's removing the live
// socket the first one just bound, orphaning that listener with no error
// raised anywhere (ListenUnix creates a fresh inode; unlinking the path
// doesn't touch the fd already holding it open). Bind semantics never even
// get a chance to settle it, because by the time the second Start calls
// ListenUnix the path is simply empty again, not contended. So the whole
// sequence runs under startLock, a flock'd sidecar <path>.lock: whoever
// gets the lock first runs probe → remove → bind to completion before the
// second Start's probe is allowed to happen, and that second probe now sees
// the first Start's live socket and correctly errors "already running"
// instead of racing to unlink it. The lock is held until Start returns;
// past the bind, the OS's own one-listener-per-path semantics cover it
// anyway, so nothing is lost by not releasing any earlier.
func (s *Server) Start() error {
	unlock, err := startLock(s.path)
	if err != nil {
		return err
	}
	defer unlock()

	if probeListening(s.path) {
		return fmt.Errorf("hooksock: already running at %s", s.path)
	}
	if err := os.Remove(s.path); err != nil && !os.IsNotExist(err) {
		return err
	}

	addr, err := net.ResolveUnixAddr("unix", s.path)
	if err != nil {
		return err
	}
	ln, err := net.ListenUnix("unix", addr)
	if err != nil {
		return err
	}
	// net.ListenUnix creates the file at 0777&^umask; docs/threat-model.md
	// treats filesystem permission as the hook<->daemon boundary, so a
	// world-writable socket defeats that without this.
	if err := os.Chmod(s.path, 0o600); err != nil {
		_ = ln.Close() // unlinks s.path itself; nothing else to clean up
		return err
	}
	s.mu.Lock()
	s.ln = ln
	s.mu.Unlock()

	go s.acceptLoop(ln)
	return nil
}

// startLock serializes Start's probe → remove → bind sequence, across
// goroutines and across processes — two separate presenced invocations
// racing the same crash-restart go through the same sidecar lockfile, not
// just two calls in one binary. The acquire blocks rather than
// fail-fast-and-retry: the loser simply waits out the winner's critical
// section, then runs its own probe against whatever the winner left behind
// (a live socket, almost always), which is what turns the loser's outcome
// into the ordinary "already running" error instead of a race. The lockfile
// itself is never removed — deleting it would just reopen the same
// unlink-out-from-under-someone gap one level down, and leaving it behind
// costs nothing.
func startLock(sockPath string) (unlock func(), err error) {
	lf, err := os.OpenFile(sockPath+".lock", os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("hooksock: open lockfile: %w", err)
	}
	if err := flockExclusive(lf); err != nil {
		_ = lf.Close()
		return nil, fmt.Errorf("hooksock: lock %s: %w", lf.Name(), err)
	}
	return func() {
		_ = flockUnlock(lf)
		_ = lf.Close()
	}, nil
}

// probeListening reports whether something is already accepting
// connections at path. A refused or otherwise failed dial means no live
// listener — the file, if present, is stale.
func probeListening(path string) bool {
	conn, err := net.DialTimeout("unix", path, 200*time.Millisecond)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

func (s *Server) acceptLoop(ln *net.UnixListener) {
	for {
		conn, err := ln.AcceptUnix()
		if err != nil {
			return // listener closed: Stop() was called
		}
		go s.serveConn(conn)
	}
}

func (s *Server) serveConn(conn *net.UnixConn) {
	defer conn.Close()
	if s.ConnTimeout > 0 {
		_ = conn.SetDeadline(time.Now().Add(s.ConnTimeout))
	}

	r := bufio.NewReader(conn)
	for {
		line, err := r.ReadBytes('\n')
		if len(line) > 0 {
			// Trim the trailing newline; ReadBytes keeps it on success and
			// omits it only when err != nil (the unterminated tail case
			// below, which is dropped exactly as it is on the C++ side).
			if line[len(line)-1] == '\n' {
				line = line[:len(line)-1]
				s.serveLine(conn, line)
			}
		}
		if err != nil {
			// EOF, deadline exceeded, or a reset: nothing left worth
			// reading, and any unterminated tail in `line` is dropped —
			// there is no second chance for it, same as drain_conn.
			return
		}
	}
}

func (s *Server) serveLine(conn *net.UnixConn, line []byte) {
	if s.onLine != nil {
		s.onLine(line)
	}
	if s.respond == nil {
		return
	}
	reply := s.respond(line)
	if len(reply) == 0 {
		return
	}
	reply = append(reply, '\n')
	// The hook half-closes its write side before reading, so this must
	// happen before the connection is torn down — same ordering
	// requirement as SocketServer::serve_line's comment.
	_, _ = conn.Write(reply)
}

// Stop closes the listener. Idempotent. Only touches the listener if this
// Server actually bound it — Start failing with "already running" leaves
// s.ln nil, and a Stop on that half-started Server must not tear down the
// socket the live daemon it found is using. No explicit os.Remove here:
// UnixListener.Close unlinks its own path, so removing it again is not just
// redundant, it's the exact bug this fix exists for — a stray Remove after
// Close races a second daemon that already bound the just-freed path out
// from under it.
func (s *Server) Stop() {
	s.mu.Lock()
	ln := s.ln
	s.ln = nil
	s.mu.Unlock()

	if ln == nil {
		return
	}
	_ = ln.Close()
}

// Addr is the path this server is listening on, or empty before Start.
func (s *Server) Addr() string { return s.path }
