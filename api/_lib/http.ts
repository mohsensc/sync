export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message)
  }
}

export function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    },
  })
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json()
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new HttpError(400, 'Request body must be a JSON object.')
    }
    return body as Record<string, unknown>
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(400, 'Request body must be valid JSON.')
  }
}

export async function endpoint(
  request: Request,
  methods: readonly string[],
  run: () => Promise<Response>,
): Promise<Response> {
  if (!methods.includes(request.method)) {
    return new Response(null, {
      status: 405,
      headers: { Allow: methods.join(', '), 'Cache-Control': 'no-store' },
    })
  }
  try {
    return await run()
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message }, error.status)
    console.error('API request failed:', error)
    return json({ error: 'Service temporarily unavailable.' }, 503)
  }
}
