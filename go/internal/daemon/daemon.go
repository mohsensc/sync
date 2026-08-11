// Package daemon wires the hook socket and the relay client together — the
// Go mirror of cpp/daemon/main.cpp, narrowed to wave 1's scope. See
// docs/go-daemon.md for the full list of what main.cpp does that this does
// not yet: presence table, snapshot file, policy live-reload, decision
// journal, contend-queue-driven handover deadlines, principal/token
// discovery from disk, room derivation from a git remote.
package daemon

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/mohsensc/sync/go/internal/decide"
	"github.com/mohsensc/sync/go/internal/hooksock"
	"github.com/mohsensc/sync/go/internal/leases"
	"github.com/mohsensc/sync/go/internal/relay"
	"github.com/mohsensc/sync/go/internal/wire"
)

type Options struct {
	// Sock is the hook event socket path. Required.
	Sock string

	// RelayURL is ws://host:port. Empty means no relay connection — same
	// "no room, no relay" rule main.cpp applies when the room can't be
	// determined.
	RelayURL string
	Room     string
	Agent    string
	Human    string

	Principal  string
	Token      string
	Unattended bool
}

// Daemon is a running instance: the hook socket and, when configured, the
// relay client.
type Daemon struct {
	opts   Options
	sock   *hooksock.Server
	relay  *relay.Client
	leases *leases.Cache
}

// New builds and starts the hook socket, and starts the relay connection in
// the background when RelayURL and Room are both set. The returned Daemon
// must be stopped by cancelling ctx.
func New(ctx context.Context, opts Options) (*Daemon, error) {
	d := &Daemon{
		opts:   opts,
		leases: leases.New(),
	}

	if opts.RelayURL != "" && opts.Room != "" {
		d.relay = relay.New(relay.Config{
			URL:        opts.RelayURL,
			Room:       opts.Room,
			Agent:      opts.Agent,
			Human:      opts.Human,
			Principal:  opts.Principal,
			Token:      opts.Token,
			Unattended: opts.Unattended,
		}, d.leases)
		d.relay.OnPeer(func(p wire.Presence) {
			// Wave 1 has no presence table or snapshot file to update — see
			// package doc. Logged so "peers are arriving" is at least
			// observable without a debugger attached.
			log.Printf("relay: peer %s (%s) %s %s", p.Agent, p.Human, p.Verb, p.Region.Path)
		})
		d.relay.OnPolicy(func(p wire.Policy) {
			log.Printf("relay: policy floor from %s: %v", p.Source, p.Floor)
		})
		go d.relay.Run(ctx)
	} else {
		log.Printf("daemon: no room configured, running with no relay connection")
	}

	d.sock = hooksock.New(opts.Sock)
	d.sock.OnLine(d.onLine)
	d.sock.OnRequest(d.onRequest)
	if err := d.sock.Start(); err != nil {
		return nil, err
	}

	go func() {
		<-ctx.Done()
		d.sock.Stop()
	}()

	return d, nil
}

// selfAgent is the id this daemon joined the room under — see decide.hpp's
// note on why the hook's own "agent" field (a session id) is not the same
// namespace as a lease's holder. Empty when no room is configured.
func (d *Daemon) selfAgent() string {
	if d.relay == nil {
		return ""
	}
	return d.opts.Agent
}

func (d *Daemon) onLine(line []byte) {
	req := decide.ParseRequest(line)
	if d.relay == nil {
		return
	}
	if frame := decide.EventFrame(req); frame != nil {
		d.relay.SendText(frame)
	}
}

func (d *Daemon) onRequest(line []byte) []byte {
	req := decide.ParseRequest(line)
	if !req.WantsDecision() {
		return nil
	}
	resp := decide.Decide(req, d.leases, nowMs(), d.selfAgent())
	if decide.BlockedByLease(resp) && d.relay != nil {
		if frame := decide.ContendFrame(req.Path); frame != nil {
			d.relay.SendText(frame)
		}
	}
	out, err := json.Marshal(resp)
	if err != nil {
		return nil
	}
	return out
}

func nowMs() int64 { return time.Now().UnixMilli() }
