import { database } from './db.js'

export interface PersonalAccount {
  userId: string
  workspaceId: string
  workspaceName: string
}

interface AccountRow {
  user_id: string
  workspace_id: string
  workspace_name: string
}

export async function ensurePersonalAccount(clerkUserId: string): Promise<PersonalAccount> {
  const sql = database()
  const rows = await sql`
    WITH upserted_user AS (
      INSERT INTO app_users (clerk_user_id)
      VALUES (${clerkUserId})
      ON CONFLICT (clerk_user_id) DO UPDATE
        SET clerk_user_id = EXCLUDED.clerk_user_id
      RETURNING id
    ), upserted_workspace AS (
      INSERT INTO workspaces (name, personal_owner_user_id)
      SELECT 'Personal workspace', id FROM upserted_user
      ON CONFLICT (personal_owner_user_id) DO UPDATE
        SET name = workspaces.name
      RETURNING id, name, personal_owner_user_id
    ), membership AS (
      INSERT INTO workspace_memberships (workspace_id, user_id, role)
      SELECT id, personal_owner_user_id, 'owner' FROM upserted_workspace
      ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = 'owner'
      RETURNING workspace_id, user_id
    )
    SELECT membership.user_id, membership.workspace_id,
           upserted_workspace.name AS workspace_name
    FROM membership
    JOIN upserted_workspace ON upserted_workspace.id = membership.workspace_id
  ` as AccountRow[]
  const row = rows[0]
  if (!row) throw new Error('personal workspace upsert returned no row')
  return { userId: row.user_id, workspaceId: row.workspace_id, workspaceName: row.workspace_name }
}
