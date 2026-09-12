import { ensurePersonalAccount } from './_lib/account.js'
import { requireUser } from './_lib/auth.js'
import { database } from './_lib/db.js'
import { endpoint, json } from './_lib/http.js'

interface RepoRow { id: string; room_key: string; label: string | null; last_seen_at: string }
interface AgentRow {
  id: string; repository_id: string; agent_id: string; human_id: string
  last_verb: string | null; last_path: string | null; last_intent: string | null; last_seen_at: string
}
interface EventRow {
  id: string; repository_id: string; rung: number | null; event_type: string; outcome: string
  actor_agent_id: string; actor_human_id: string; peer_agent_id: string | null
  peer_human_id: string | null; region_path: string; waited_ms: number | null; occurred_at: string
}

export default {
  async fetch(request: Request): Promise<Response> {
    return endpoint(request, ['GET'], async () => {
      const user = await requireUser(request)
      const account = await ensurePersonalAccount(user.clerkUserId)
      const sql = database()
      const results = await Promise.all([
        sql`
          SELECT id, room_key, label, last_seen_at
          FROM repositories
          WHERE workspace_id = ${account.workspaceId}
          ORDER BY last_seen_at DESC
          LIMIT 100
        `,
        sql`
          SELECT id, repository_id, agent_id, human_id, last_verb, last_path, last_intent, last_seen_at
          FROM agent_sessions
          WHERE workspace_id = ${account.workspaceId}
            AND last_state <> 'disconnected'
            AND last_seen_at >= now() - interval '30 seconds'
          ORDER BY last_seen_at DESC
          LIMIT 500
        `,
        sql`
          SELECT id, repository_id, rung, event_type, outcome,
                 actor_agent_id, actor_human_id, peer_agent_id, peer_human_id,
                 region_path, waited_ms, occurred_at
          FROM resolution_events
          WHERE workspace_id = ${account.workspaceId}
          ORDER BY occurred_at DESC
          LIMIT 200
        `,
      ])
      const repositories = results[0] as unknown as RepoRow[]
      const agents = results[1] as unknown as AgentRow[]
      const events = results[2] as unknown as EventRow[]

      const agentsByRepo = new Map<string, AgentRow[]>()
      for (const agent of agents) {
        const group = agentsByRepo.get(agent.repository_id) ?? []
        group.push(agent)
        agentsByRepo.set(agent.repository_id, group)
      }
      const eventsByRepo = new Map<string, EventRow[]>()
      for (const event of events) {
        const group = eventsByRepo.get(event.repository_id) ?? []
        if (group.length < 25) group.push(event)
        eventsByRepo.set(event.repository_id, group)
      }

      return json({
        workspace: { id: account.workspaceId, name: account.workspaceName },
        generatedAt: new Date().toISOString(),
        repositories: repositories.map((repo) => ({
          id: repo.id,
          name: repo.label || repo.room_key,
          roomKey: repo.room_key,
          lastSeenAt: repo.last_seen_at,
          agents: (agentsByRepo.get(repo.id) ?? []).map((agent) => ({
            id: agent.id,
            agentId: agent.agent_id,
            human: agent.human_id === account.userId ? 'You' : agent.human_id,
            verb: agent.last_verb,
            path: agent.last_path,
            intent: agent.last_intent,
            lastSeenAt: agent.last_seen_at,
          })),
          resolutions: (eventsByRepo.get(repo.id) ?? []).map((event) => ({
            id: event.id,
            rung: event.rung ?? 0,
            kind: event.outcome || event.event_type,
            actorAgent: event.actor_agent_id,
            actorHuman: event.actor_human_id === account.userId ? 'You' : event.actor_human_id,
            peerAgent: event.peer_agent_id,
            peerHuman: event.peer_human_id === account.userId ? 'You' : event.peer_human_id,
            path: event.region_path,
            detail: event.waited_ms == null ? null : `waited ${event.waited_ms}ms`,
            occurredAt: event.occurred_at,
          })),
        })),
      })
    })
  },
}
