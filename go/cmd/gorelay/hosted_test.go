package main

import (
	"context"
	"testing"
	"time"

	"github.com/mohsensc/sync/go/internal/hosted"
	"github.com/mohsensc/sync/go/internal/relaysrv"
)

type fakeProjectionStore struct {
	presence   chan hosted.PresenceUpdate
	resolution chan hosted.ResolutionUpdate
}

func (f *fakeProjectionStore) RecordPresence(_ context.Context, update hosted.PresenceUpdate) (bool, error) {
	f.presence <- update
	return true, nil
}

func (f *fakeProjectionStore) RecordResolution(_ context.Context, update hosted.ResolutionUpdate) error {
	f.resolution <- update
	return nil
}

func TestProjectionWriterPersistsSanitizedPresenceAndResolution(t *testing.T) {
	store := &fakeProjectionStore{
		presence:   make(chan hosted.PresenceUpdate, 1),
		resolution: make(chan hosted.ResolutionUpdate, 1),
	}
	p := newProjectionWriter(store)
	p.ObservePresence(relaysrv.PresenceProjection{
		WorkspaceID: "workspace", UserID: "user", RepositoryID: "repository",
		RoomKey: "0123456789abcdef", AgentID: "agent-a", HumanID: "user",
		Verb: "edit", Path: "main.go", Intent: "wire hosted relay",
	})
	p.ObserveResolution(relaysrv.ResolutionProjection{
		WorkspaceID: "workspace", RoomKey: "0123456789abcdef", Rung: 3,
		Kind: "handover", Outcome: "handover", FromAgent: "agent-a", FromHuman: "user",
		ToAgent: "agent-b", ToHuman: "peer", Path: "main.go", WaitedSeconds: 1.25,
	})

	select {
	case got := <-store.presence:
		if got.Auth.UserID != "user" || got.Intent != "wire hosted relay" || got.State != "active" {
			t.Fatalf("unexpected presence: %#v", got)
		}
	case <-time.After(time.Second):
		t.Fatal("presence was not projected")
	}
	select {
	case got := <-store.resolution:
		if got.EventType != "handover" || got.Outcome != "handover" || got.WaitedMS == nil || *got.WaitedMS != 1250 {
			t.Fatalf("unexpected resolution: %#v", got)
		}
		if got.PeerUserID != nil {
			t.Fatalf("unknown peer user must not be guessed: %#v", got.PeerUserID)
		}
	case <-time.After(time.Second):
		t.Fatal("resolution was not projected")
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := p.Close(ctx); err != nil {
		t.Fatal(err)
	}
}

type blockedProjectionStore struct{ release chan struct{} }

func (b *blockedProjectionStore) RecordPresence(context.Context, hosted.PresenceUpdate) (bool, error) {
	<-b.release
	return true, nil
}
func (b *blockedProjectionStore) RecordResolution(context.Context, hosted.ResolutionUpdate) error {
	<-b.release
	return nil
}

func TestProjectionWriterNeverBlocksRelayWhenQueueIsFull(t *testing.T) {
	store := &blockedProjectionStore{release: make(chan struct{})}
	p := newProjectionWriter(store)
	event := relaysrv.PresenceProjection{
		WorkspaceID: "workspace", UserID: "user", RepositoryID: "repository",
		RoomKey: "0123456789abcdef", AgentID: "agent-a", HumanID: "user",
	}
	done := make(chan struct{})
	go func() {
		for i := 0; i < projectionQueueSize*2; i++ {
			p.ObservePresence(event)
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("projection producer blocked on a slow store")
	}
	close(store.release)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := p.Close(ctx); err != nil {
		t.Fatal(err)
	}
}
