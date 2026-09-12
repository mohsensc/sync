import { ensurePersonalAccount } from './_lib/account.js'
import { requireUser } from './_lib/auth.js'
import { endpoint, json } from './_lib/http.js'

export default {
  async fetch(request: Request): Promise<Response> {
    return endpoint(request, ['POST'], async () => {
      const user = await requireUser(request)
      const account = await ensurePersonalAccount(user.clerkUserId)
      return json({ workspace: { id: account.workspaceId, name: account.workspaceName } }, 201)
    })
  },
}
