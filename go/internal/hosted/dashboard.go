package hosted

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// DashboardForClerkUser returns one transactionally consistent account view.
// Every child query is anchored through the requesting user's memberships;
// repository ids or workspace ids supplied by a caller never participate.
func (s *Store) DashboardForClerkUser(ctx context.Context, clerkUserID string) (Dashboard, error) {
	clerkUserID = strings.TrimSpace(clerkUserID)
	if clerkUserID == "" {
		return Dashboard{}, fmt.Errorf("%w: Clerk user id is empty", ErrInvalidInput)
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return Dashboard{}, fmt.Errorf("hosted: begin dashboard read: %w", err)
	}
	defer tx.Rollback(context.Background())

	out := Dashboard{ClerkUserID: clerkUserID, GeneratedAt: time.Now().UTC()}
	if err := tx.QueryRow(ctx, `SELECT id FROM app_users WHERE clerk_user_id = $1`, clerkUserID).Scan(&out.UserID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Dashboard{}, ErrNotFound
		}
		return Dashboard{}, fmt.Errorf("hosted: find dashboard user: %w", err)
	}

	rows, err := tx.Query(ctx, `
		SELECT w.id, w.name, m.role, w.personal_owner_user_id = $1
		FROM workspace_memberships m
		JOIN workspaces w ON w.id = m.workspace_id
		WHERE m.user_id = $1
		ORDER BY (w.personal_owner_user_id = $1) DESC, lower(w.name), w.id`, out.UserID)
	if err != nil {
		return Dashboard{}, fmt.Errorf("hosted: read dashboard workspaces: %w", err)
	}
	workspaceIndex := make(map[string]int)
	for rows.Next() {
		var w DashboardWorkspace
		if err := rows.Scan(&w.ID, &w.Name, &w.Role, &w.Personal); err != nil {
			rows.Close()
			return Dashboard{}, fmt.Errorf("hosted: scan dashboard workspace: %w", err)
		}
		workspaceIndex[w.ID] = len(out.Workspaces)
		out.Workspaces = append(out.Workspaces, w)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return Dashboard{}, fmt.Errorf("hosted: read dashboard workspaces: %w", err)
	}
	rows.Close()

	rows, err = tx.Query(ctx, `
		SELECT r.workspace_id, r.id, r.room_key, r.label, r.last_seen_at
		FROM repositories r
		JOIN workspace_memberships mine
		  ON mine.workspace_id = r.workspace_id AND mine.user_id = $1
		ORDER BY r.last_seen_at DESC, r.id`, out.UserID)
	if err != nil {
		return Dashboard{}, fmt.Errorf("hosted: read dashboard repositories: %w", err)
	}
	for rows.Next() {
		var workspaceID string
		var repo DashboardRepository
		if err := rows.Scan(&workspaceID, &repo.ID, &repo.RoomKey, &repo.Label, &repo.LastSeenAt); err != nil {
			rows.Close()
			return Dashboard{}, fmt.Errorf("hosted: scan dashboard repository: %w", err)
		}
		if i, ok := workspaceIndex[workspaceID]; ok {
			out.Workspaces[i].Repositories = append(out.Workspaces[i].Repositories, repo)
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return Dashboard{}, fmt.Errorf("hosted: read dashboard repositories: %w", err)
	}
	rows.Close()

	rows, err = tx.Query(ctx, `
		SELECT s.workspace_id, s.id, s.repository_id, s.user_id,
		       s.agent_id, s.human_id, s.last_state, s.last_verb,
		       s.last_path, s.last_symbol, s.last_intent,
		       s.first_seen_at, s.last_seen_at
		FROM agent_sessions s
		JOIN workspace_memberships mine
		  ON mine.workspace_id = s.workspace_id AND mine.user_id = $1
		ORDER BY s.last_seen_at DESC, s.id`, out.UserID)
	if err != nil {
		return Dashboard{}, fmt.Errorf("hosted: read dashboard sessions: %w", err)
	}
	for rows.Next() {
		var workspaceID string
		var session DashboardSession
		if err := rows.Scan(
			&workspaceID, &session.ID, &session.RepositoryID, &session.UserID,
			&session.AgentID, &session.HumanID, &session.State, &session.Verb,
			&session.Path, &session.Symbol, &session.Intent,
			&session.FirstSeenAt, &session.LastSeenAt,
		); err != nil {
			rows.Close()
			return Dashboard{}, fmt.Errorf("hosted: scan dashboard session: %w", err)
		}
		if i, ok := workspaceIndex[workspaceID]; ok {
			out.Workspaces[i].Sessions = append(out.Workspaces[i].Sessions, session)
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return Dashboard{}, fmt.Errorf("hosted: read dashboard sessions: %w", err)
	}
	rows.Close()

	rows, err = tx.Query(ctx, `
		SELECT e.workspace_id, e.id, e.repository_id, e.actor_user_id,
		       e.peer_user_id, e.event_type, e.outcome, e.rung,
		       e.region_path, e.region_symbol, e.actor_agent_id,
		       e.actor_human_id, e.peer_agent_id, e.peer_human_id,
		       e.waited_ms, e.occurred_at
		FROM resolution_events e
		JOIN workspace_memberships mine
		  ON mine.workspace_id = e.workspace_id AND mine.user_id = $1
		ORDER BY e.occurred_at DESC, e.id
		LIMIT 200`, out.UserID)
	if err != nil {
		return Dashboard{}, fmt.Errorf("hosted: read dashboard resolutions: %w", err)
	}
	for rows.Next() {
		var workspaceID string
		var event DashboardResolution
		if err := rows.Scan(
			&workspaceID, &event.ID, &event.RepositoryID, &event.ActorUserID,
			&event.PeerUserID, &event.EventType, &event.Outcome, &event.Rung,
			&event.RegionPath, &event.RegionSymbol, &event.ActorAgentID,
			&event.ActorHumanID, &event.PeerAgentID, &event.PeerHumanID,
			&event.WaitedMS, &event.OccurredAt,
		); err != nil {
			rows.Close()
			return Dashboard{}, fmt.Errorf("hosted: scan dashboard resolution: %w", err)
		}
		if i, ok := workspaceIndex[workspaceID]; ok {
			out.Workspaces[i].Resolutions = append(out.Workspaces[i].Resolutions, event)
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return Dashboard{}, fmt.Errorf("hosted: read dashboard resolutions: %w", err)
	}
	rows.Close()

	if err := tx.Commit(ctx); err != nil {
		return Dashboard{}, fmt.Errorf("hosted: commit dashboard read: %w", err)
	}
	return out, nil
}
