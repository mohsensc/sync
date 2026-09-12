package hosted

import (
	"context"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
)

var validPresenceStates = map[string]bool{
	"active": true, "idle": true, "disconnected": true,
}

var validResolutionTypes = map[string]bool{
	"contention": true, "handover": true, "override": true, "redundant": true,
}

var validResolutionOutcomes = map[string]bool{
	"wait": true, "abort": true, "handover": true, "proceed": true, "redundant": true,
}

func validateAuth(a AgentAuth) error {
	if strings.TrimSpace(a.WorkspaceID) == "" || strings.TrimSpace(a.RepositoryID) == "" || strings.TrimSpace(a.UserID) == "" {
		return fmt.Errorf("%w: authenticated workspace, repository, and user are required", ErrInvalidInput)
	}
	if !validRoomKey(a.RoomKey) {
		return fmt.Errorf("%w: authenticated room key is invalid", ErrInvalidInput)
	}
	return nil
}

func normalizePresence(p PresenceUpdate) (PresenceUpdate, error) {
	if err := validateAuth(p.Auth); err != nil {
		return PresenceUpdate{}, err
	}
	p.AgentID = strings.TrimSpace(p.AgentID)
	p.HumanID = strings.TrimSpace(p.HumanID)
	p.State = strings.TrimSpace(p.State)
	p.Verb = strings.TrimSpace(p.Verb)
	p.Path = strings.TrimSpace(p.Path)
	p.Intent = strings.TrimSpace(p.Intent)
	if p.State == "" {
		p.State = "active"
	}
	if p.AgentID == "" || len(p.AgentID) > 256 || p.HumanID == "" || len(p.HumanID) > 256 {
		return PresenceUpdate{}, fmt.Errorf("%w: agent and human ids must be 1..256 bytes", ErrInvalidInput)
	}
	if !validPresenceStates[p.State] {
		return PresenceUpdate{}, fmt.Errorf("%w: unknown presence state %q", ErrInvalidInput, p.State)
	}
	if len(p.Verb) > 32 || len(p.Path) > 4096 || len(p.Intent) > 2048 {
		return PresenceUpdate{}, fmt.Errorf("%w: presence state exceeds storage limits", ErrInvalidInput)
	}
	if p.Symbol != nil && len(*p.Symbol) > 512 {
		return PresenceUpdate{}, fmt.Errorf("%w: symbol exceeds storage limit", ErrInvalidInput)
	}
	return p, nil
}

// RecordPresence persists the latest bounded state for an agent. The bool is
// false when a new active agent would exceed the five-agent account cap; that
// is a display/tracking decision only and must never block an agent action.
func (s *Store) RecordPresence(ctx context.Context, update PresenceUpdate) (bool, error) {
	update, err := normalizePresence(update)
	if err != nil {
		return false, err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return false, fmt.Errorf("hosted: begin presence update: %w", err)
	}
	defer tx.Rollback(context.Background())

	lockKey := update.Auth.WorkspaceID + ":" + update.Auth.UserID
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, lockKey); err != nil {
		return false, fmt.Errorf("hosted: lock presence account: %w", err)
	}

	if update.State != "disconnected" {
		var alreadyActive bool
		var activeCount int
		if err := tx.QueryRow(ctx, `
			SELECT
				COALESCE(bool_or(agent_id = $3), false),
				count(DISTINCT agent_id)
			FROM agent_sessions
			WHERE workspace_id = $1 AND user_id = $2
			  AND last_state <> 'disconnected'
			  AND last_seen_at > now() - interval '30 seconds'`,
			update.Auth.WorkspaceID, update.Auth.UserID, update.AgentID,
		).Scan(&alreadyActive, &activeCount); err != nil {
			return false, fmt.Errorf("hosted: count active agents: %w", err)
		}
		if !alreadyActive && activeCount >= presenceCap {
			if err := tx.Commit(ctx); err != nil {
				return false, fmt.Errorf("hosted: commit capped presence update: %w", err)
			}
			return false, nil
		}
	}

	tag, err := tx.Exec(ctx, `
		UPDATE repositories SET last_seen_at = now()
		WHERE workspace_id = $1 AND id = $2 AND room_key = $3`,
		update.Auth.WorkspaceID, update.Auth.RepositoryID, update.Auth.RoomKey,
	)
	if err != nil {
		return false, fmt.Errorf("hosted: update repository activity: %w", err)
	}
	if tag.RowsAffected() != 1 {
		return false, fmt.Errorf("%w: authenticated repository scope does not match room", ErrInvalidInput)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO agent_sessions (
			workspace_id, repository_id, user_id, agent_id, human_id,
			last_state, last_verb, last_path, last_symbol, last_intent,
			first_seen_at, last_seen_at
		) VALUES ($1, $2, $3, $4, $5, $6, NULLIF($7, ''), NULLIF($8, ''), $9, NULLIF($10, ''), now(), now())
		ON CONFLICT (workspace_id, user_id, agent_id) DO UPDATE SET
			repository_id = EXCLUDED.repository_id,
			human_id = EXCLUDED.human_id,
			last_state = EXCLUDED.last_state,
			last_verb = EXCLUDED.last_verb,
			last_path = EXCLUDED.last_path,
			last_symbol = EXCLUDED.last_symbol,
			last_intent = EXCLUDED.last_intent,
			last_seen_at = now()`,
		update.Auth.WorkspaceID, update.Auth.RepositoryID, update.Auth.UserID,
		update.AgentID, update.HumanID, update.State, update.Verb, update.Path,
		update.Symbol, update.Intent,
	); err != nil {
		return false, fmt.Errorf("hosted: upsert agent session: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("hosted: commit presence update: %w", err)
	}
	return true, nil
}

func normalizeResolution(r ResolutionUpdate) (ResolutionUpdate, error) {
	if err := validateAuth(r.Auth); err != nil {
		return ResolutionUpdate{}, err
	}
	r.EventType = strings.TrimSpace(r.EventType)
	r.Outcome = strings.TrimSpace(r.Outcome)
	r.RegionPath = strings.TrimSpace(r.RegionPath)
	r.ActorAgentID = strings.TrimSpace(r.ActorAgentID)
	r.ActorHumanID = strings.TrimSpace(r.ActorHumanID)
	if !validResolutionTypes[r.EventType] || !validResolutionOutcomes[r.Outcome] {
		return ResolutionUpdate{}, fmt.Errorf("%w: unknown resolution type or outcome", ErrInvalidInput)
	}
	if r.Rung != nil && (*r.Rung < 0 || *r.Rung > 4) {
		return ResolutionUpdate{}, fmt.Errorf("%w: rung must be between 0 and 4", ErrInvalidInput)
	}
	if r.RegionPath == "" || len(r.RegionPath) > 4096 || r.ActorAgentID == "" || len(r.ActorAgentID) > 256 || r.ActorHumanID == "" || len(r.ActorHumanID) > 256 {
		return ResolutionUpdate{}, fmt.Errorf("%w: resolution identity or region is invalid", ErrInvalidInput)
	}
	if r.RegionSymbol != nil && len(*r.RegionSymbol) > 512 {
		return ResolutionUpdate{}, fmt.Errorf("%w: resolution symbol exceeds storage limit", ErrInvalidInput)
	}
	if r.WaitedMS != nil && *r.WaitedMS < 0 {
		return ResolutionUpdate{}, fmt.Errorf("%w: waited milliseconds cannot be negative", ErrInvalidInput)
	}
	for name, value := range map[string]*string{
		"peer user": r.PeerUserID, "peer agent": r.PeerAgentID, "peer human": r.PeerHumanID,
	} {
		if value != nil && (strings.TrimSpace(*value) == "" || len(*value) > 256) {
			return ResolutionUpdate{}, fmt.Errorf("%w: %s is invalid", ErrInvalidInput, name)
		}
	}
	return r, nil
}

func (s *Store) RecordResolution(ctx context.Context, update ResolutionUpdate) error {
	update, err := normalizeResolution(update)
	if err != nil {
		return err
	}
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO resolution_events (
			workspace_id, repository_id, actor_user_id, peer_user_id,
			event_type, outcome, rung, region_path, region_symbol,
			actor_agent_id, actor_human_id, peer_agent_id, peer_human_id, waited_ms
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
		update.Auth.WorkspaceID, update.Auth.RepositoryID, update.Auth.UserID, update.PeerUserID,
		update.EventType, update.Outcome, update.Rung, update.RegionPath, update.RegionSymbol,
		update.ActorAgentID, update.ActorHumanID, update.PeerAgentID, update.PeerHumanID, update.WaitedMS,
	); err != nil {
		return fmt.Errorf("hosted: record resolution: %w", err)
	}
	return nil
}
