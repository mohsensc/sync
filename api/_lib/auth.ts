import { createClerkClient } from '@clerk/backend'
import { HttpError } from './http.js'

export interface SignedInUser { clerkUserId: string }

function authorizedParties(): string[] {
  const configured = process.env.CLERK_AUTHORIZED_PARTIES || process.env.APP_ORIGIN || ''
  const parties = configured.split(',').map((value) => value.trim()).filter(Boolean)
  for (const host of [process.env.VERCEL_PROJECT_PRODUCTION_URL, process.env.VERCEL_URL]) {
    if (host) parties.push(host.startsWith('http') ? host : `https://${host}`)
  }
  return [...new Set(parties)]
}

export async function requireUser(request: Request): Promise<SignedInUser> {
  const secretKey = process.env.CLERK_SECRET_KEY
  const publishableKey = process.env.CLERK_PUBLISHABLE_KEY || process.env.VITE_CLERK_PUBLISHABLE_KEY
  const parties = authorizedParties()
  if (!secretKey || !publishableKey || parties.length === 0) {
    throw new HttpError(503, 'Authentication is not configured.')
  }
  const clerk = createClerkClient({ secretKey, publishableKey })
  const state = await clerk.authenticateRequest(request, { authorizedParties: parties })
  if (!state.isAuthenticated) throw new HttpError(401, 'Unauthorized.')
  const auth = state.toAuth()
  if (!auth.userId) throw new HttpError(401, 'Unauthorized.')
  return { clerkUserId: auth.userId }
}
