import { neon, type NeonQueryFunction } from '@neondatabase/serverless'
import { HttpError } from './http.js'

let query: NeonQueryFunction<false, false> | null = null

export function database(): NeonQueryFunction<false, false> {
  const url = process.env.DATABASE_URL
  if (!url) throw new HttpError(503, 'Database is not configured.')
  if (!query) query = neon(url)
  return query
}
