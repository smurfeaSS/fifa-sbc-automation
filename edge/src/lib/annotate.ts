/**
 * Re-apply protection rules to stored players.
 *
 * Annotations live in columns so a solve never has to recompute them. The cost
 * of that is this: when protection settings change, or when duplicate and squad
 * flags are filled in at the end of an import, every row needs revisiting.
 *
 * It runs in bounded pages so no single request annotates the whole club — that
 * would breach the CPU budget on a large one. The caller loops until `done`.
 */

import { sql } from 'drizzle-orm'
import { getDb, schema } from './db'
import { rowToAnnotated, annotatedToRow } from './repo'
import { protectionReasons, priorityTier, sacrificeCost } from '../solver/protection'
import { loadSettings } from './settings'
import type { Bindings } from '../types'
import type { PlayerRow } from './schema'

/**
 * Rows per pass.
 *
 * Protection is a handful of comparisons per player. On the paid CPU allowance
 * a whole ordinary club fits in one pass, so this is sized to make re-annotation
 * a single round trip for most people while still paging a very large one.
 */
export const ANNOTATE_PAGE = 2500

export interface AnnotatePage {
  updated: number
  done: boolean
  nextOffset: number
}

export async function reannotatePage(
  env: Bindings,
  offset: number,
): Promise<AnnotatePage> {
  const db = getDb(env)
  const settings = await loadSettings(env)

  const rows = await db.all<PlayerRow>(sql`
    SELECT * FROM players ORDER BY id LIMIT ${ANNOTATE_PAGE} OFFSET ${offset}
  `)
  if (rows.length === 0) return { updated: 0, done: true, nextOffset: offset }

  const statements = rows.map((row) => {
    const player = rowToAnnotated(row)
    const reasons = protectionReasons(player, settings.protection)
    const isProtected = reasons.length > 0
    const cost = sacrificeCost(player, isProtected, settings)

    const updated = annotatedToRow(
      {
        ...player,
        isProtected,
        protectionReasons: reasons,
        sacrificeCost: cost,
        priorityTier: priorityTier(player),
      },
      row.importedAt,
    )

    return sql`
      UPDATE players SET
        is_protected = ${updated.isProtected ? 1 : 0},
        protection_reasons = ${updated.protectionReasons},
        sacrifice_cost = ${updated.sacrificeCost},
        priority_tier = ${updated.priorityTier}
      WHERE id = ${row.id}
    `
  })

  // One batch, one transaction — a half-annotated club would silently change
  // which cards the solver considers safe.
  await db.batch(statements.map((s) => db.run(s)) as never)

  return {
    updated: rows.length,
    done: rows.length < ANNOTATE_PAGE,
    nextOffset: offset + rows.length,
  }
}

/**
 * Annotate every player, page by page.
 *
 * Only safe to call where a larger CPU allowance exists — at the end of an
 * import the club is at most a few thousand rows and the pages are batched, but
 * on a very large club prefer driving `reannotatePage` from the client.
 */
export async function reannotateAll(env: Bindings, maxPages = 20): Promise<number> {
  let offset = 0
  let total = 0
  for (let page = 0; page < maxPages; page++) {
    const result = await reannotatePage(env, offset)
    total += result.updated
    offset = result.nextOffset
    if (result.done) break
  }
  return total
}
