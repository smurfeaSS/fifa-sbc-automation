/** Re-apply protection rules to a single player, after a manual unlock. */

import { sql } from 'drizzle-orm'
import { getDb } from './db'
import { rowToAnnotated } from './repo'
import { protectionReasons, priorityTier, sacrificeCost } from '../solver/protection'
import { loadSettings } from './settings'
import type { Bindings } from '../types'
import type { PlayerRow } from './schema'

export async function reannotateOne(env: Bindings, itemId: string): Promise<boolean> {
  const db = getDb(env)
  const row = await db.get<PlayerRow>(sql`SELECT * FROM players WHERE id = ${itemId}`)
  if (!row) return false

  const settings = await loadSettings(env)
  const player = rowToAnnotated(row)
  const reasons = protectionReasons(player, settings.protection)
  const isProtected = reasons.length > 0
  const cost = sacrificeCost(player, isProtected, settings)

  await db.run(sql`
    UPDATE players SET
      is_protected = ${isProtected ? 1 : 0},
      protection_reasons = ${JSON.stringify(reasons)},
      sacrifice_cost = ${Number.isFinite(cost) ? cost : 1e15},
      priority_tier = ${priorityTier(player)}
    WHERE id = ${itemId}
  `)
  return true
}
