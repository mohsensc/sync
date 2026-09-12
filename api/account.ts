import { createClerkClient } from '@clerk/backend'
import { requireUser } from './_lib/auth.js'
import { database } from './_lib/db.js'
import { endpoint, HttpError, json, readJson } from './_lib/http.js'

export default {
  async fetch(request: Request): Promise<Response> {
    return endpoint(request, ['DELETE'], async () => {
      const user = await requireUser(request)
      const origin = request.headers.get('origin')
      if (origin && origin !== new URL(request.url).origin) {
        throw new HttpError(403, 'Account deletion must be requested from this site.')
      }
      const body = await readJson(request)
      if (body.confirmation !== 'DELETE') throw new HttpError(400, 'Confirm account deletion by typing DELETE.')
      const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY })
      const sql = database()
      // The schema cascades this to the personal workspace, memberships,
      // tokens, repositories, sessions, and resolution history. Do this first:
      // database failure must not strand active tokens behind a deleted login.
      await sql`DELETE FROM app_users WHERE clerk_user_id = ${user.clerkUserId}`
      try {
        await clerk.users.deleteUser(user.clerkUserId)
      } catch {
        // Cross-service deletion is not atomic. Keep the remaining identity
        // usable for a retry and be explicit about the completed portion.
        throw new HttpError(503, 'Your workspace data and agent tokens were removed, but your sign-in account could not be deleted. Please retry Delete account.')
      }
      return json({ ok: true })
    })
  },
}
