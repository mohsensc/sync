package hosted

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	presenceCap          = 5
	presenceActiveWindow = 30 * time.Second
)

// Store owns hosted account, repository, and dashboard persistence. Live
// leases deliberately remain in the relay's bounded, TTL-backed memory.
type Store struct {
	pool *pgxpool.Pool

	closeOnce sync.Once
	closed    chan struct{}
}

func Open(ctx context.Context, databaseURL string) (*Store, error) {
	if strings.TrimSpace(databaseURL) == "" {
		return nil, fmt.Errorf("%w: database URL is empty", ErrInvalidInput)
	}
	cfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("hosted: parse database URL: %w", err)
	}
	cfg.ConnConfig.RuntimeParams["application_name"] = "agent-sync-hosted"
	// Hosted relay projections are best-effort and bounded. Keep the database
	// side bounded too so a small deployment cannot create an unbounded pool
	// during a reconnect burst.
	cfg.MaxConns = 5
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("hosted: open database: %w", err)
	}
	return &Store{pool: pool, closed: make(chan struct{})}, nil
}

// Close accepts a context so shutdown cannot be held indefinitely by a
// checked-out connection. The pool continues closing in the background if the
// caller's shutdown deadline expires.
func (s *Store) Close(ctx context.Context) error {
	if s == nil || s.pool == nil {
		return nil
	}
	s.closeOnce.Do(func() {
		go func() {
			s.pool.Close()
			close(s.closed)
		}()
	})
	select {
	case <-s.closed:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *Store) Ping(ctx context.Context) error {
	if s == nil || s.pool == nil {
		return errors.New("hosted: store is not open")
	}
	if err := s.pool.Ping(ctx); err != nil {
		return fmt.Errorf("hosted: ping database: %w", err)
	}
	return nil
}

// Migrate applies the embedded copy of db/migrations/000001. The migration is
// idempotent and versioned in the database; an advisory transaction lock keeps
// concurrent relay starts from racing it.
func (s *Store) Migrate(ctx context.Context) error {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("hosted: begin migration: %w", err)
	}
	defer tx.Rollback(context.Background())

	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(734907214165)`); err != nil {
		return fmt.Errorf("hosted: lock migrations: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS agent_sync_schema_migrations (
			version bigint PRIMARY KEY,
			applied_at timestamptz NOT NULL DEFAULT now()
		)`); err != nil {
		return fmt.Errorf("hosted: create migration ledger: %w", err)
	}
	var applied bool
	if err := tx.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM agent_sync_schema_migrations WHERE version = $1)`,
		initialMigrationVersion,
	).Scan(&applied); err != nil {
		return fmt.Errorf("hosted: read migration ledger: %w", err)
	}
	if !applied {
		if _, err := tx.Exec(ctx, initialMigrationSQL); err != nil {
			return fmt.Errorf("hosted: apply migration %d: %w", initialMigrationVersion, err)
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO agent_sync_schema_migrations(version) VALUES ($1)`,
			initialMigrationVersion,
		); err != nil {
			return fmt.Errorf("hosted: record migration %d: %w", initialMigrationVersion, err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("hosted: commit migrations: %w", err)
	}
	return nil
}

func (s *Store) BootstrapPersonalAccount(ctx context.Context, clerkUserID, workspaceName string) (PersonalAccount, error) {
	clerkUserID = strings.TrimSpace(clerkUserID)
	workspaceName = strings.TrimSpace(workspaceName)
	if clerkUserID == "" {
		return PersonalAccount{}, fmt.Errorf("%w: Clerk user id is empty", ErrInvalidInput)
	}
	if workspaceName == "" {
		workspaceName = "Personal"
	}

	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return PersonalAccount{}, fmt.Errorf("hosted: begin account bootstrap: %w", err)
	}
	defer tx.Rollback(context.Background())

	var out PersonalAccount
	out.ClerkUserID = clerkUserID
	if err := tx.QueryRow(ctx, `
		INSERT INTO app_users (clerk_user_id) VALUES ($1)
		ON CONFLICT (clerk_user_id) DO UPDATE SET clerk_user_id = EXCLUDED.clerk_user_id
		RETURNING id`, clerkUserID).Scan(&out.UserID); err != nil {
		return PersonalAccount{}, fmt.Errorf("hosted: upsert app user: %w", err)
	}
	if err := tx.QueryRow(ctx, `
		INSERT INTO workspaces (name, personal_owner_user_id) VALUES ($1, $2)
		ON CONFLICT (personal_owner_user_id) DO UPDATE
		SET personal_owner_user_id = EXCLUDED.personal_owner_user_id
		RETURNING id`, workspaceName, out.UserID).Scan(&out.WorkspaceID); err != nil {
		return PersonalAccount{}, fmt.Errorf("hosted: upsert personal workspace: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO workspace_memberships (workspace_id, user_id, role)
		VALUES ($1, $2, 'owner')
		ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = 'owner'`,
		out.WorkspaceID, out.UserID,
	); err != nil {
		return PersonalAccount{}, fmt.Errorf("hosted: upsert personal workspace membership: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return PersonalAccount{}, fmt.Errorf("hosted: commit account bootstrap: %w", err)
	}
	return out, nil
}

// RotateAccountToken revokes the user's live tokens in this workspace and
// returns a new raw token exactly once. Only its public lookup prefix and
// SHA-256 secret digest are stored.
func (s *Store) RotateAccountToken(ctx context.Context, workspaceID, userID, label string) (IssuedToken, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	userID = strings.TrimSpace(userID)
	if workspaceID == "" || userID == "" {
		return IssuedToken{}, fmt.Errorf("%w: workspace and user ids are required", ErrInvalidInput)
	}
	material, err := mintToken()
	if err != nil {
		return IssuedToken{}, err
	}

	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return IssuedToken{}, fmt.Errorf("hosted: begin token rotation: %w", err)
	}
	defer tx.Rollback(context.Background())
	if _, err := tx.Exec(ctx,
		`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
		workspaceID+":"+userID,
	); err != nil {
		return IssuedToken{}, fmt.Errorf("hosted: lock token rotation: %w", err)
	}

	var member bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM workspace_memberships
			WHERE workspace_id = $1 AND user_id = $2
		)`, workspaceID, userID).Scan(&member); err != nil {
		return IssuedToken{}, fmt.Errorf("hosted: check token membership: %w", err)
	}
	if !member {
		return IssuedToken{}, ErrNotMember
	}
	if _, err := tx.Exec(ctx, `
		UPDATE account_tokens SET revoked_at = now()
		WHERE workspace_id = $1 AND user_id = $2 AND revoked_at IS NULL`, workspaceID, userID); err != nil {
		return IssuedToken{}, fmt.Errorf("hosted: revoke old account tokens: %w", err)
	}

	var labelArg any
	if trimmed := strings.TrimSpace(label); trimmed != "" {
		labelArg = trimmed
	}
	out := IssuedToken{
		WorkspaceID: workspaceID,
		UserID:      userID,
		Prefix:      material.prefix,
		Raw:         material.raw,
	}
	if labelArg != nil {
		v := labelArg.(string)
		out.Label = &v
	}
	if err := tx.QueryRow(ctx, `
		INSERT INTO account_tokens
			(workspace_id, user_id, token_prefix, secret_sha256, label)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id, created_at`,
		workspaceID, userID, material.prefix, material.hash[:], labelArg,
	).Scan(&out.ID, &out.CreatedAt); err != nil {
		return IssuedToken{}, fmt.Errorf("hosted: insert account token: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return IssuedToken{}, fmt.Errorf("hosted: commit token rotation: %w", err)
	}
	return out, nil
}

// AuthenticateAgentToken resolves a raw token and a client-derived room hash
// into the immutable workspace/repository scope the relay should latch.
func (s *Store) AuthenticateAgentToken(ctx context.Context, raw, roomKey string) (AgentAuth, error) {
	if !validRoomKey(roomKey) {
		return AgentAuth{}, fmt.Errorf("%w: room key must be 16 lowercase hex characters", ErrInvalidInput)
	}
	prefix, presentedHash, err := parseToken(raw)
	if err != nil {
		return AgentAuth{}, err
	}

	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return AgentAuth{}, fmt.Errorf("hosted: begin token authentication: %w", err)
	}
	defer tx.Rollback(context.Background())

	var out AgentAuth
	var storedHash []byte
	var revokedAt *time.Time
	if err := tx.QueryRow(ctx, `
		SELECT t.id, t.workspace_id, t.user_id, t.secret_sha256, t.revoked_at,
		       u.clerk_user_id, m.role
		FROM account_tokens t
		JOIN app_users u ON u.id = t.user_id
		JOIN workspace_memberships m
		  ON m.workspace_id = t.workspace_id AND m.user_id = t.user_id
		WHERE t.token_prefix = $1
		FOR UPDATE OF t`, prefix,
	).Scan(&out.TokenID, &out.WorkspaceID, &out.UserID, &storedHash, &revokedAt, &out.ClerkUserID, &out.Role); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return AgentAuth{}, ErrInvalidToken
		}
		return AgentAuth{}, fmt.Errorf("hosted: look up account token: %w", err)
	}
	// Compare before inspecting revocation so a known prefix does not create a
	// distinct secret-validation path.
	if !tokenHashMatches(storedHash, presentedHash) || revokedAt != nil {
		return AgentAuth{}, ErrInvalidToken
	}

	out.RoomKey = roomKey
	if err := tx.QueryRow(ctx, `
		INSERT INTO repositories (workspace_id, room_key, last_seen_at)
		VALUES ($1, $2, now())
		ON CONFLICT (workspace_id, room_key) DO UPDATE SET last_seen_at = now()
		RETURNING id`, out.WorkspaceID, roomKey).Scan(&out.RepositoryID); err != nil {
		return AgentAuth{}, fmt.Errorf("hosted: resolve repository: %w", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE account_tokens SET last_used_at = now() WHERE id = $1`, out.TokenID); err != nil {
		return AgentAuth{}, fmt.Errorf("hosted: mark account token used: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return AgentAuth{}, fmt.Errorf("hosted: commit token authentication: %w", err)
	}
	return out, nil
}
