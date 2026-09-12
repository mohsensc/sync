import { Clerk } from '@clerk/clerk-js'
import { inject } from '@vercel/analytics'
import {
  activeAgents,
  relativeTime,
  selectRepository,
  type DashboardPayload,
  type RepositorySummary,
} from './dashboard-model.js'

declare global {
  interface Window { __internal_ClerkUICtor?: unknown }
}

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const clerkKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY
const configError = byId<HTMLElement>('configuration-error')
const authGate = byId<HTMLElement>('auth-gate')
const dashboard = byId<HTMLElement>('dashboard')
const dashboardError = byId<HTMLElement>('dashboard-error')
const repoList = byId<HTMLElement>('repo-list')
const agentList = byId<HTMLElement>('agent-list')
const resolutionList = byId<HTMLElement>('resolution-list')

let payload: DashboardPayload | null = null
let selectedRepoId: string | null = null
let refreshTimer: number | null = null
let visibleTokenId: string | null = null

function setText(el: HTMLElement, value: string) { el.textContent = value }

function empty(message: string): HTMLDivElement {
  const el = document.createElement('div')
  el.className = 'empty-state'
  el.textContent = message
  return el
}

function repoButton(repo: RepositorySummary): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = `repo-row${repo.id === selectedRepoId ? ' selected' : ''}`
  const copy = document.createElement('span')
  const title = document.createElement('strong')
  title.textContent = repo.name
  const detail = document.createElement('small')
  const active = activeAgents(repo).length
  detail.textContent = `${active} active · ${repo.lastSeenAt ? relativeTime(repo.lastSeenAt) : 'not seen yet'}`
  copy.append(title, detail)
  const dot = document.createElement('span')
  dot.className = active > 0 ? 'status-dot active' : 'status-dot'
  button.append(dot, copy)
  button.onclick = () => { selectedRepoId = repo.id; render() }
  return button
}

function renderAgents(repo: RepositorySummary | null) {
  const agents = activeAgents(repo)
  agentList.replaceChildren()
  setText(byId('agent-count'), `${agents.length} live`)
  setText(byId('agents-title'), repo ? `Active agents · ${repo.name}` : 'Active agents')
  if (agents.length === 0) {
    agentList.append(empty(repo ? 'No agent has checked in during the last 30 seconds.' : 'Connect an agent to create your first repository room.'))
    return
  }
  for (const agent of agents) {
    const row = document.createElement('article')
    row.className = 'agent-row'
    const avatar = document.createElement('span')
    avatar.className = 'agent-avatar'
    avatar.textContent = (agent.human || agent.agentId).slice(0, 1).toUpperCase()
    const copy = document.createElement('span')
    const title = document.createElement('strong')
    title.textContent = agent.agentId
    const detail = document.createElement('small')
    detail.textContent = [agent.intent, agent.verb, agent.path, agent.human].filter(Boolean).join(' · ')
    copy.append(title, detail)
    const seen = document.createElement('time')
    seen.dateTime = agent.lastSeenAt
    seen.textContent = relativeTime(agent.lastSeenAt)
    row.append(avatar, copy, seen)
    agentList.append(row)
  }
}

function renderResolutions(repo: RepositorySummary | null) {
  resolutionList.replaceChildren()
  const events = repo?.resolutions ?? []
  if (events.length === 0) {
    resolutionList.append(empty('No resolved conflicts recorded for this repository.'))
    return
  }
  for (const event of events) {
    const row = document.createElement('article')
    row.className = 'resolution-row'
    const rung = document.createElement('span')
    rung.className = 'rung'
    rung.dataset.rung = String(event.rung)
    rung.textContent = `R${event.rung}`
    const copy = document.createElement('span')
    const title = document.createElement('strong')
    const actor = event.actorHuman || event.actorAgent || 'agent'
    const peer = event.peerHuman || event.peerAgent
    title.textContent = peer ? `${actor} · ${event.kind} · ${peer}` : `${actor} · ${event.kind}`
    const detail = document.createElement('small')
    detail.textContent = [event.path, event.detail].filter(Boolean).join(' · ')
    copy.append(title, detail)
    const seen = document.createElement('time')
    seen.dateTime = event.occurredAt
    seen.textContent = relativeTime(event.occurredAt)
    row.append(rung, copy, seen)
    resolutionList.append(row)
  }
}

function render() {
  if (!payload) return
  const repo = selectRepository(payload.repositories, selectedRepoId)
  selectedRepoId = repo?.id ?? null
  repoList.replaceChildren()
  setText(byId('repo-count'), String(payload.repositories.length))
  if (payload.repositories.length === 0) repoList.append(empty('No repositories yet.'))
  else payload.repositories.forEach((item) => repoList.append(repoButton(item)))
  renderAgents(repo)
  renderResolutions(repo)
  setText(byId('last-updated'), `Updated ${relativeTime(payload.generatedAt)}`)
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  const body = await response.json().catch(() => ({})) as { error?: string }
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`)
  return body as T
}

async function refresh() {
  try {
    payload = await api<DashboardPayload>('/api/dashboard')
    dashboardError.hidden = true
    render()
  } catch (error) {
    dashboardError.textContent = error instanceof Error ? error.message : 'Could not refresh the dashboard.'
    dashboardError.hidden = false
  }
}

function beginPolling() {
  if (refreshTimer !== null) window.clearInterval(refreshTimer)
  void refresh()
  refreshTimer = window.setInterval(() => void refresh(), 5_000)
}

async function loadClerkUi(key: string): Promise<unknown> {
  const encodedDomain = key.split('_')[2]
  if (!encodedDomain) throw new Error('invalid Clerk publishable key')
  const domain = atob(encodedDomain).slice(0, -1)
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = `https://${domain}/npm/@clerk/ui@1/dist/ui.browser.js`
    script.async = true
    script.crossOrigin = 'anonymous'
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('failed to load Clerk UI'))
    document.head.append(script)
  })
  return window.__internal_ClerkUICtor
}

async function showDashboard(clerk: Clerk) {
  if (!clerk.user) return
  authGate.hidden = true
  dashboard.hidden = false
  const name = clerk.user.fullName || clerk.user.primaryEmailAddress?.emailAddress || 'Your account'
  setText(byId('user-name'), name)
  const image = byId<HTMLImageElement>('user-avatar')
  image.src = clerk.user.imageUrl
  image.alt = `${name} avatar`
  await api('/api/bootstrap', { method: 'POST' })
  beginPolling()

  byId<HTMLButtonElement>('account-settings').onclick = () => void clerk.openUserProfile()
  byId<HTMLButtonElement>('sign-out').onclick = () => void clerk.signOut({ redirectUrl: '/' })
}

async function boot() {
  inject()
  if (!clerkKey) {
    configError.hidden = false
    return
  }
  try {
    const ClerkUI = await loadClerkUi(clerkKey)
    const clerk = new Clerk(clerkKey)
    await clerk.load({ ui: { ClerkUI: ClerkUI as never } })
    if (clerk.isSignedIn) {
      await showDashboard(clerk)
      return
    }
    authGate.hidden = false
    clerk.mountSignIn(byId('clerk-signin'))
    clerk.addListener(({ user }) => { if (user) void showDashboard(clerk) })
  } catch (error) {
    console.error('dashboard auth unavailable:', error)
    authGate.hidden = false
    byId('auth-error').hidden = false
  }
}

byId<HTMLButtonElement>('rotate-token').onclick = async () => {
  const button = byId<HTMLButtonElement>('rotate-token')
  button.disabled = true
  try {
    const result = await api<{ id: string; instructions: string }>('/api/tokens', {
      method: 'POST', body: JSON.stringify({ label: 'dashboard setup' }),
    })
    visibleTokenId = result.id
    setText(byId('setup-instructions'), result.instructions)
    byId('setup-result').hidden = false
    button.textContent = 'Rotate setup token'
  } catch (error) {
    dashboardError.textContent = error instanceof Error ? error.message : 'Could not create setup instructions.'
    dashboardError.hidden = false
  } finally {
    button.disabled = false
  }
}

byId<HTMLButtonElement>('copy-setup').onclick = async () => {
  await navigator.clipboard.writeText(byId('setup-instructions').textContent || '')
  setText(byId('copy-setup'), 'Copied')
  window.setTimeout(() => setText(byId('copy-setup'), 'Copy instructions'), 1_500)
}

byId<HTMLButtonElement>('revoke-token').onclick = async () => {
  if (!visibleTokenId) return
  await api('/api/tokens', { method: 'DELETE', body: JSON.stringify({ id: visibleTokenId }) })
  visibleTokenId = null
  byId('setup-result').hidden = true
  setText(byId('rotate-token'), 'Create setup instructions')
}

void boot()
