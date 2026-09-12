export const ACTIVE_WINDOW_MS = 30_000

export interface AgentSummary {
  id: string
  agentId: string
  human: string
  verb: string | null
  path: string | null
  intent: string | null
  lastSeenAt: string
}

export interface ResolutionSummary {
  id: string
  rung: number
  kind: string
  actorAgent: string | null
  actorHuman: string | null
  peerAgent: string | null
  peerHuman: string | null
  path: string | null
  detail: string | null
  occurredAt: string
}

export interface RepositorySummary {
  id: string
  name: string
  roomKey: string
  lastSeenAt: string | null
  agents: AgentSummary[]
  resolutions: ResolutionSummary[]
}

export interface DashboardPayload {
  workspace: { id: string; name: string }
  repositories: RepositorySummary[]
  generatedAt: string
}

export function isActive(lastSeenAt: string, now = Date.now()): boolean {
  const seen = Date.parse(lastSeenAt)
  return Number.isFinite(seen) && now - seen <= ACTIVE_WINDOW_MS && seen <= now + 5_000
}

export function activeAgents(repo: RepositorySummary | null, now = Date.now()): AgentSummary[] {
  if (!repo) return []
  return repo.agents.filter((agent) => isActive(agent.lastSeenAt, now))
}

export function selectRepository(
  repositories: RepositorySummary[],
  selectedId: string | null,
): RepositorySummary | null {
  return repositories.find((repo) => repo.id === selectedId) ?? repositories[0] ?? null
}

export function relativeTime(iso: string, now = Date.now()): string {
  const elapsed = Math.max(0, now - Date.parse(iso))
  if (!Number.isFinite(elapsed) || elapsed < 5_000) return 'just now'
  if (elapsed < 60_000) return `${Math.round(elapsed / 1_000)}s ago`
  if (elapsed < 3_600_000) return `${Math.round(elapsed / 60_000)}m ago`
  if (elapsed < 86_400_000) return `${Math.round(elapsed / 3_600_000)}h ago`
  return `${Math.round(elapsed / 86_400_000)}d ago`
}
