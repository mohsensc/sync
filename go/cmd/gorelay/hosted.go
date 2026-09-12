package main

import (
	"context"
	"log"
	"math"
	"sync"
	"time"

	"github.com/mohsensc/sync/go/internal/hosted"
	"github.com/mohsensc/sync/go/internal/relaysrv"
)

const (
	projectionQueueSize = 256
	projectionWriteTTL  = 2 * time.Second
)

type storeAuthenticator struct{ store *hosted.Store }

func (a storeAuthenticator) AuthenticateAgent(ctx context.Context, token, roomKey string) (relaysrv.HostedIdentity, error) {
	auth, err := a.store.AuthenticateAgentToken(ctx, token, roomKey)
	if err != nil {
		return relaysrv.HostedIdentity{}, err
	}
	return relaysrv.HostedIdentity{
		WorkspaceID:  auth.WorkspaceID,
		UserID:       auth.UserID,
		RepositoryID: auth.RepositoryID,
		HumanID:      auth.UserID,
	}, nil
}

type projectionRecorder interface {
	RecordPresence(context.Context, hosted.PresenceUpdate) (bool, error)
	RecordResolution(context.Context, hosted.ResolutionUpdate) error
}

type projectionItem struct {
	presence   *hosted.PresenceUpdate
	resolution *hosted.ResolutionUpdate
}

// projectionWriter keeps Postgres entirely off the relay's authority path.
// A full queue drops dashboard telemetry; it never delays a claim, heartbeat,
// or handover. Live coordination remains in the in-memory lease registry.
type projectionWriter struct {
	store projectionRecorder
	queue chan projectionItem
	done  chan struct{}

	mu    sync.RWMutex
	auths map[string]hosted.AgentAuth

	stopOnce sync.Once
	cancel   context.CancelFunc
}

func newProjectionWriter(store projectionRecorder) *projectionWriter {
	ctx, cancel := context.WithCancel(context.Background())
	p := &projectionWriter{
		store:  store,
		queue:  make(chan projectionItem, projectionQueueSize),
		done:   make(chan struct{}),
		auths:  make(map[string]hosted.AgentAuth),
		cancel: cancel,
	}
	go p.run(ctx)
	return p
}

func projectionAgentKey(workspaceID, agentID string) string {
	return workspaceID + "\x00" + agentID
}

func (p *projectionWriter) remember(auth hosted.AgentAuth, agentID string) {
	p.mu.Lock()
	p.auths[projectionAgentKey(auth.WorkspaceID, agentID)] = auth
	p.mu.Unlock()
}

func (p *projectionWriter) authFor(workspaceID, agentID string) (hosted.AgentAuth, bool) {
	p.mu.RLock()
	auth, ok := p.auths[projectionAgentKey(workspaceID, agentID)]
	p.mu.RUnlock()
	return auth, ok
}

func (p *projectionWriter) enqueue(item projectionItem) {
	select {
	case p.queue <- item:
	default:
		// Dashboard telemetry is explicitly lossy. Logging here would put a
		// synchronous output lock back on the relay hot path during an outage.
	}
}

func (p *projectionWriter) ObservePresence(event relaysrv.PresenceProjection) {
	auth := hosted.AgentAuth{
		WorkspaceID:  event.WorkspaceID,
		RepositoryID: event.RepositoryID,
		UserID:       event.UserID,
		RoomKey:      event.RoomKey,
	}
	p.remember(auth, event.AgentID)
	update := hosted.PresenceUpdate{
		Auth:    auth,
		AgentID: event.AgentID,
		HumanID: event.HumanID,
		State:   "active",
		Verb:    event.Verb,
		Path:    event.Path,
		Symbol:  event.Symbol,
		Intent:  event.Intent,
	}
	p.enqueue(projectionItem{presence: &update})
}

func (p *projectionWriter) ObserveResolution(event relaysrv.ResolutionProjection) {
	auth, ok := p.authFor(event.WorkspaceID, event.FromAgent)
	if !ok {
		// Resolution persistence is best-effort. Refusing to guess an actor's
		// tenant identity is safer than writing a misleading cross-account row.
		return
	}
	var peerUserID *string
	if peer, found := p.authFor(event.WorkspaceID, event.ToAgent); found {
		peerUserID = &peer.UserID
	}
	rung := int16(event.Rung)
	var waitedMS *int
	if event.WaitedSeconds > 0 {
		value := int(math.Round(event.WaitedSeconds * 1000))
		waitedMS = &value
	}
	outcome := event.Outcome
	if outcome == "" {
		outcome = "proceed"
	}
	update := hosted.ResolutionUpdate{
		Auth:         auth,
		PeerUserID:   peerUserID,
		EventType:    event.Kind,
		Outcome:      outcome,
		Rung:         &rung,
		RegionPath:   event.Path,
		RegionSymbol: event.Symbol,
		ActorAgentID: event.FromAgent,
		ActorHumanID: event.FromHuman,
		PeerAgentID:  optionalString(event.ToAgent),
		PeerHumanID:  optionalString(event.ToHuman),
		WaitedMS:     waitedMS,
	}
	p.enqueue(projectionItem{resolution: &update})
}

func optionalString(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func (p *projectionWriter) run(ctx context.Context) {
	defer close(p.done)
	for {
		select {
		case item := <-p.queue:
			p.write(item)
		case <-ctx.Done():
			for {
				select {
				case item := <-p.queue:
					p.write(item)
				default:
					return
				}
			}
		}
	}
}

func (p *projectionWriter) write(item projectionItem) {
	ctx, cancel := context.WithTimeout(context.Background(), projectionWriteTTL)
	defer cancel()
	if item.presence != nil {
		if _, err := p.store.RecordPresence(ctx, *item.presence); err != nil {
			log.Printf("hosted presence projection failed: %v", err)
		}
		return
	}
	if item.resolution != nil {
		if err := p.store.RecordResolution(ctx, *item.resolution); err != nil {
			log.Printf("hosted resolution projection failed: %v", err)
		}
	}
}

func (p *projectionWriter) Close(ctx context.Context) error {
	p.stopOnce.Do(p.cancel)
	select {
	case <-p.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
