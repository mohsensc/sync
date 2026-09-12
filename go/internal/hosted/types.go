package hosted

import (
	"errors"
	"time"
)

var (
	ErrInvalidToken = errors.New("hosted: invalid agent token")
	ErrInvalidInput = errors.New("hosted: invalid input")
	ErrNotMember    = errors.New("hosted: user is not a workspace member")
	ErrNotFound     = errors.New("hosted: account not found")
)

// PersonalAccount is the idempotent result of provisioning a Clerk user and
// their personal workspace.
type PersonalAccount struct {
	UserID      string
	WorkspaceID string
	ClerkUserID string
}

// IssuedToken is returned only when a token is minted. Raw is never persisted
// and cannot be reconstructed from the other fields.
type IssuedToken struct {
	ID          string
	WorkspaceID string
	UserID      string
	Prefix      string
	Raw         string
	Label       *string
	CreatedAt   time.Time
}

// AgentAuth is the server-derived isolation scope for one authenticated join.
// Relay code should use WorkspaceID+RepositoryID as its internal room key,
// never the client-provided room hash by itself.
type AgentAuth struct {
	TokenID      string
	WorkspaceID  string
	RepositoryID string
	UserID       string
	ClerkUserID  string
	RoomKey      string
	Role         string
}

// PresenceUpdate is the bounded state persisted for the account dashboard.
// It intentionally has no payload, output, diff, prompt, or free-form metadata.
type PresenceUpdate struct {
	Auth    AgentAuth
	AgentID string
	HumanID string
	State   string
	Verb    string
	Path    string
	Symbol  *string
	Intent  string
}

// ResolutionUpdate is deliberately narrower than a relay frame. Only the
// sanitized facts needed for a room-scoped conflict history can be stored.
type ResolutionUpdate struct {
	Auth         AgentAuth
	PeerUserID   *string
	EventType    string
	Outcome      string
	Rung         *int16
	RegionPath   string
	RegionSymbol *string
	ActorAgentID string
	ActorHumanID string
	PeerAgentID  *string
	PeerHumanID  *string
	WaitedMS     *int
}

type Dashboard struct {
	UserID      string
	ClerkUserID string
	Workspaces  []DashboardWorkspace
	GeneratedAt time.Time
}

type DashboardWorkspace struct {
	ID           string
	Name         string
	Role         string
	Personal     bool
	Repositories []DashboardRepository
	Sessions     []DashboardSession
	Resolutions  []DashboardResolution
}

type DashboardRepository struct {
	ID         string
	RoomKey    string
	Label      *string
	LastSeenAt time.Time
}

type DashboardSession struct {
	ID           string
	RepositoryID string
	UserID       string
	AgentID      string
	HumanID      string
	State        string
	Verb         *string
	Path         *string
	Symbol       *string
	Intent       *string
	FirstSeenAt  time.Time
	LastSeenAt   time.Time
}

type DashboardResolution struct {
	ID           string
	RepositoryID string
	ActorUserID  string
	PeerUserID   *string
	EventType    string
	Outcome      string
	Rung         *int16
	RegionPath   string
	RegionSymbol *string
	ActorAgentID string
	ActorHumanID string
	PeerAgentID  *string
	PeerHumanID  *string
	WaitedMS     *int
	OccurredAt   time.Time
}
