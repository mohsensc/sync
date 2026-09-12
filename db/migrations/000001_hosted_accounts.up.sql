CREATE TABLE IF NOT EXISTS app_users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    clerk_user_id text NOT NULL UNIQUE,
    CONSTRAINT app_users_clerk_user_id_nonempty CHECK (btrim(clerk_user_id) <> '')
);

CREATE TABLE IF NOT EXISTS workspaces (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    personal_owner_user_id uuid UNIQUE REFERENCES app_users(id) ON DELETE CASCADE,
    CONSTRAINT workspaces_name_nonempty CHECK (btrim(name) <> '')
);

CREATE TABLE IF NOT EXISTS workspace_memberships (
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    role text NOT NULL,
    PRIMARY KEY (workspace_id, user_id),
    CONSTRAINT workspace_memberships_role_valid CHECK (role IN ('owner', 'admin', 'member', 'viewer'))
);

CREATE TABLE IF NOT EXISTS account_tokens (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    token_prefix text NOT NULL UNIQUE,
    secret_sha256 bytea NOT NULL UNIQUE,
    label text,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz,
    revoked_at timestamptz,
    FOREIGN KEY (workspace_id, user_id)
        REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE CASCADE,
    CONSTRAINT account_tokens_prefix_valid CHECK (token_prefix ~ '^ags_[0-9a-f]{32}$'),
    CONSTRAINT account_tokens_hash_length CHECK (octet_length(secret_sha256) = 32),
    CONSTRAINT account_tokens_label_nonempty CHECK (label IS NULL OR btrim(label) <> '')
);

CREATE UNIQUE INDEX IF NOT EXISTS account_tokens_active_user_idx
    ON account_tokens (workspace_id, user_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS repositories (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    room_key text NOT NULL,
    label text,
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, room_key),
    UNIQUE (workspace_id, id),
    CONSTRAINT repositories_room_key_valid CHECK (room_key ~ '^[0-9a-f]{16}$'),
    CONSTRAINT repositories_label_nonempty CHECK (label IS NULL OR btrim(label) <> '')
);

CREATE INDEX IF NOT EXISTS repositories_workspace_last_seen_idx
    ON repositories (workspace_id, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS agent_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL,
    repository_id uuid NOT NULL,
    user_id uuid NOT NULL,
    agent_id text NOT NULL,
    human_id text NOT NULL,
    last_state text NOT NULL DEFAULT 'active',
    last_verb text,
    last_path text,
    last_symbol text,
    last_intent text,
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, user_id, agent_id),
    UNIQUE (workspace_id, id),
    FOREIGN KEY (workspace_id, user_id)
        REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, repository_id)
        REFERENCES repositories(workspace_id, id) ON DELETE CASCADE,
    CONSTRAINT agent_sessions_agent_id_nonempty CHECK (btrim(agent_id) <> ''),
    CONSTRAINT agent_sessions_human_id_nonempty CHECK (btrim(human_id) <> ''),
    CONSTRAINT agent_sessions_state_valid CHECK (last_state IN ('active', 'idle', 'disconnected')),
    CONSTRAINT agent_sessions_seen_ordered CHECK (last_seen_at >= first_seen_at)
);

CREATE INDEX IF NOT EXISTS agent_sessions_user_seen_idx
    ON agent_sessions (user_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS agent_sessions_repo_seen_idx
    ON agent_sessions (workspace_id, repository_id, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS resolution_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL,
    repository_id uuid NOT NULL,
    actor_user_id uuid NOT NULL,
    peer_user_id uuid,
    event_type text NOT NULL,
    outcome text NOT NULL,
    rung smallint,
    region_path text NOT NULL,
    region_symbol text,
    actor_agent_id text NOT NULL,
    actor_human_id text NOT NULL,
    peer_agent_id text,
    peer_human_id text,
    waited_ms integer,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (workspace_id, repository_id)
        REFERENCES repositories(workspace_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, actor_user_id)
        REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, peer_user_id)
        REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE SET NULL (peer_user_id),
    CONSTRAINT resolution_events_type_valid
        CHECK (event_type IN ('contention', 'handover', 'override', 'redundant')),
    CONSTRAINT resolution_events_outcome_valid
        CHECK (outcome IN ('wait', 'abort', 'handover', 'proceed', 'redundant')),
    CONSTRAINT resolution_events_rung_valid CHECK (rung IS NULL OR rung BETWEEN 0 AND 4),
    CONSTRAINT resolution_events_region_nonempty CHECK (btrim(region_path) <> ''),
    CONSTRAINT resolution_events_actor_agent_nonempty CHECK (btrim(actor_agent_id) <> ''),
    CONSTRAINT resolution_events_actor_human_nonempty CHECK (btrim(actor_human_id) <> ''),
    CONSTRAINT resolution_events_wait_nonnegative CHECK (waited_ms IS NULL OR waited_ms >= 0)
);

CREATE INDEX IF NOT EXISTS resolution_events_repo_time_idx
    ON resolution_events (workspace_id, repository_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS resolution_events_actor_time_idx
    ON resolution_events (actor_user_id, occurred_at DESC);
