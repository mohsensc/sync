import { database } from './_lib/db.js'
import { endpoint, json } from './_lib/http.js'

// Deliberately the one endpoint that stays open: no requireUser(), no
// tenant-scoped table, nothing to leak. Its only job is to force the
// serverless cold-start chain (this Lambda's module graph, including
// @neondatabase/serverless, plus Neon's compute if it was suspended) to
// happen while the visitor is still looking at the sign-in screen instead
// of after Clerk hands back a session. `SELECT 1` is the cheapest possible
// real round trip to Neon — no table, no rows, nothing tenant-specific.
export default {
  async fetch(request: Request): Promise<Response> {
    return endpoint(request, ['GET'], async () => {
      const sql = database()
      await sql`SELECT 1`
      return json({ ok: true })
    })
  },
}
