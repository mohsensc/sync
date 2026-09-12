package hosted

import (
	"errors"
	"strings"
	"testing"
)

func testAuth() AgentAuth {
	return AgentAuth{
		WorkspaceID: "workspace", RepositoryID: "repository", UserID: "user",
		RoomKey: "0123456789abcdef",
	}
}

func TestNormalizePresenceDefaultsState(t *testing.T) {
	p, err := normalizePresence(PresenceUpdate{Auth: testAuth(), AgentID: " agent ", HumanID: " human "})
	if err != nil {
		t.Fatal(err)
	}
	if p.State != "active" || p.AgentID != "agent" || p.HumanID != "human" {
		t.Fatalf("unexpected normalized presence: %+v", p)
	}
}

func TestNormalizePresenceRejectsUnboundedState(t *testing.T) {
	_, err := normalizePresence(PresenceUpdate{
		Auth: testAuth(), AgentID: "agent", HumanID: "human", Path: strings.Repeat("x", 4097),
	})
	if !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("error = %v, want ErrInvalidInput", err)
	}
}

func TestNormalizeResolutionAcceptsOnlySanitizedVocabulary(t *testing.T) {
	rung := int16(3)
	_, err := normalizeResolution(ResolutionUpdate{
		Auth: testAuth(), EventType: "handover", Outcome: "wait", Rung: &rung,
		RegionPath: "src/a.go", ActorAgentID: "agent", ActorHumanID: "human",
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = normalizeResolution(ResolutionUpdate{
		Auth: testAuth(), EventType: "raw_frame", Outcome: "wait",
		RegionPath: "src/a.go", ActorAgentID: "agent", ActorHumanID: "human",
	})
	if !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("error = %v, want ErrInvalidInput", err)
	}
}
