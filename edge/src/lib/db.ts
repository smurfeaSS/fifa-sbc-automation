/**
 * Drizzle instance, created once per isolate.
 *
 * CLAUDE.md §17 calls out initialising Drizzle inside a handler as a forbidden
 * pattern: it pays the setup cost on every request, which on a 10ms budget is
 * real money.
 */

import { drizzle } from 'drizzle-orm/d1'
import * as schema from './schema'
import type { Bindings } from '../types'

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null

export function getDb(env: Bindings) {
  if (!_db) _db = drizzle(env.DB, { schema })
  return _db
}

export { schema }
