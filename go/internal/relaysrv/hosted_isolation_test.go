package relaysrv

import (
	"testing"

	"github.com/mohsensc/sync/go/internal/metrics"
)

type hostedRecorder struct {
	*recorder
	identity HostedIdentity
}

type hostedProjectionRecorder struct {
	presence    []PresenceProjection
	resolutions []ResolutionProjection
}

func (r *hostedProjectionRecorder) ObservePresence(event PresenceProjection) {
	r.presence = append(r.presence, event)
}

func (r *hostedProjectionRecorder) ObserveResolution(event ResolutionProjection) {
	r.resolutions = append(r.resolutions, event)
}

func (r *hostedRecorder) hostedIdentity() (HostedIdentity, bool) {
	return r.identity, true
}

func newHostedRecorder(workspace, user, agent string) *hostedRecorder {
	return &hostedRecorder{
		recorder: &recorder{agent: agent, human: "forged-client-human"},
		identity: HostedIdentity{
			WorkspaceID: workspace, UserID: user, RepositoryID: "repo-" + workspace,
			HumanID: user,
		},
	}
}

func TestHostedWorkspacesIsolateSameRoomAndAgentIDs(t *testing.T) {
	clock := NewVirtualClock(100)
	relay := NewRelay(clock, InertRoster(), metrics.New())
	a := newHostedRecorder("workspace-a", "user-a", "same-session")
	b := newHostedRecorder("workspace-b", "user-b", "same-session")
	roomKey := "0123456789abcdef"

	if !relay.Join(scopedHostedRoom(a.identity.WorkspaceID, roomKey), a) {
		t.Fatal("workspace A join refused")
	}
	if !relay.Join(scopedHostedRoom(b.identity.WorkspaceID, roomKey), b) {
		t.Fatal("workspace B join refused")
	}
	if len(a.evictions) != 0 || len(b.evictions) != 0 {
		t.Fatalf("cross-tenant agent id collision caused eviction: A=%v B=%v", a.evictions, b.evictions)
	}

	a.sent = nil
	b.sent = nil
	claim := map[string]any{
		"type": "claim", "region": goldenRegion("src/auth.go", "login"), "intent": "work",
	}
	if got := relay.Handle(a, claim); got["granted"] != true {
		t.Fatalf("workspace A claim = %#v", got)
	}
	if got := relay.Handle(b, claim); got["granted"] != true {
		t.Fatalf("workspace B claim leaked contention = %#v", got)
	}
	if len(a.sent) != 0 || len(b.sent) != 0 {
		t.Fatalf("cross-tenant claim broadcast leaked: A=%#v B=%#v", a.sent, b.sent)
	}

	relay.Handle(a, map[string]any{
		"type": "event", "agent": "worker", "human": "forged",
		"verb": "edit", "region": goldenRegion("src/auth.go", "login"),
	})
	if len(b.sent) != 0 {
		t.Fatalf("cross-tenant presence leaked: %#v", b.sent)
	}
}

func TestHostedPresenceUsesAuthenticatedHuman(t *testing.T) {
	relay := NewRelay(NewVirtualClock(100), InertRoster(), metrics.New())
	a := newHostedRecorder("workspace-a", "user-a", "daemon")
	viewer := newHostedRecorder("workspace-a", "user-a", "viewer")
	room := scopedHostedRoom("workspace-a", "0123456789abcdef")
	relay.Join(room, a)
	relay.Join(room, viewer)
	viewer.sent = nil

	relay.Handle(a, map[string]any{
		"type": "event", "agent": "session-1", "human": "other-account",
		"verb": "edit", "region": goldenRegion("src/auth.go", "login"),
	})

	if len(viewer.sent) != 1 {
		t.Fatalf("viewer got %d frames, want one presence: %#v", len(viewer.sent), viewer.sent)
	}
	if got := viewer.sent[0]["human"]; got != "user-a" {
		t.Fatalf("presence human = %v, want authenticated user-a", got)
	}
}

func TestHostedRefusedClaimProjectsSanitizedContention(t *testing.T) {
	relay := NewRelay(NewVirtualClock(100), InertRoster(), metrics.New())
	projections := &hostedProjectionRecorder{}
	relay.SetProjectionSink(projections)
	holder := newHostedRecorder("workspace-a", "user-a", "holder")
	requester := newHostedRecorder("workspace-a", "user-b", "requester")
	room := scopedHostedRoom("workspace-a", "0123456789abcdef")
	relay.Join(room, holder)
	relay.Join(room, requester)
	claim := map[string]any{
		"type": "claim", "region": goldenRegion("src/auth.go", "login"), "intent": "work",
	}
	if got := relay.Handle(holder, claim); got["granted"] != true {
		t.Fatalf("holder claim = %#v", got)
	}
	if got := relay.Handle(requester, claim); got["granted"] != false {
		t.Fatalf("requester claim = %#v", got)
	}
	if len(projections.resolutions) != 1 {
		t.Fatalf("resolution projections = %#v", projections.resolutions)
	}
	got := projections.resolutions[0]
	if got.Kind != "contention" || got.Outcome == "" || got.FromAgent != "requester" || got.ToAgent != "holder" {
		t.Fatalf("sanitized contention = %#v", got)
	}
}

func TestScopedHostedRoomRoundTrip(t *testing.T) {
	room := scopedHostedRoom("550e8400-e29b-41d4-a716-446655440000", "0123456789abcdef")
	if got := hostedWorkspaceFromRoom(room); got != "550e8400-e29b-41d4-a716-446655440000" {
		t.Fatalf("workspace = %q", got)
	}
	if got, ok := hostedRoomKeyFromScoped(room); !ok || got != "0123456789abcdef" {
		t.Fatalf("room key = %q, %v", got, ok)
	}
}
