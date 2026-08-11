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
	"net"
	"os"
	"time"
)

// LineHandler observes a line (an event) but produces no reply.
type LineHandler func(line []byte)

// RequestHandler answers a line. A nil return means no answer, which the
// hook reads as "allow" — same rule as an empty reply on the C++ socket.
type RequestHandler func(line []byte) []byte

type Server struct {
	path string
	ln   *net.UnixListener

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
// as SocketServer::start.
func (s *Server) Start() error {
	_ = os.Remove(s.path)

	addr, err := net.ResolveUnixAddr("unix", s.path)
	if err != nil {
		return err
	}
	ln, err := net.ListenUnix("unix", addr)
	if err != nil {
		return err
	}
	s.ln = ln

	go s.acceptLoop()
	return nil
}

func (s *Server) acceptLoop() {
	for {
		conn, err := s.ln.AcceptUnix()
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

// Stop closes the listener and removes the socket file. Idempotent.
func (s *Server) Stop() {
	if s.ln != nil {
		_ = s.ln.Close()
		s.ln = nil
	}
	_ = os.Remove(s.path)
}

// Addr is the path this server is listening on, or empty before Start.
func (s *Server) Addr() string { return s.path }
