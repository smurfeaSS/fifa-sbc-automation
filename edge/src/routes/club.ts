/**
 * Club read endpoints. Every response is bounded (CLAUDE.md §17: never return
 * unbounded results — a 1,800-row JSON.stringify would blow the CPU budget on
 * serialisation alone).
 */

import { Hono } from 'hono'
import { eq, sql } from 'drizzle-orm'
import { getDb, schema } from '../lib/db'
import { searchPlayers, rowToAnnotated, MAX_ROWS } from '../lib/repo'
import type { AppEnv } from '../types'
import type { PlayerRow } from '../lib/schema'

const app = new Hono<AppEnv>()

app.get('/summary', async (c) => {
  const db = getDb(c.env)
  const meta = await db.select().from(schema.clubMeta).where(eq(schema.clubMeta.id, 1)).get()

  if (!meta) {
    return c.json({ success: true, data: { imported: false }, requestId: c.get('requestId') })
  }

  // Aggregated in SQL. Computing these in JS would mean reading every player.
  const totals = await db.get<{
    total: number
    protectedCount: number
    duplicates: number
    highRated: number
    estValue: number
    tradeableValue: number
    untradeableValue: number
  }>(sql`
    SELECT
      COUNT(*)                                                           AS total,
      SUM(is_protected)                                                  AS protectedCount,
      SUM(is_duplicate)                                                  AS duplicates,
      SUM(CASE WHEN is_protected = 0 AND rating >= 84 THEN 1 ELSE 0 END) AS highRated,
      COALESCE(SUM(value_coins), 0)                                      AS estValue,
      COALESCE(SUM(CASE WHEN tradeability = 'tradeable'   THEN value_coins ELSE 0 END), 0) AS tradeableValue,
      COALESCE(SUM(CASE WHEN tradeability = 'untradeable' THEN value_coins ELSE 0 END), 0) AS untradeableValue
    FROM players
  `)

  return c.json({
    success: true,
    data: {
      imported: true,
      exportedAt: meta.exportedAt,
      gameVersion: meta.gameVersion,
      importInProgress: meta.importInProgress,
      summary: {
        totalPlayers: totals?.total ?? 0,
        protectedCount: totals?.protectedCount ?? 0,
        usableCount: (totals?.total ?? 0) - (totals?.protectedCount ?? 0),
        duplicateCount: totals?.duplicates ?? 0,
        highRatedFodderCount: totals?.highRated ?? 0,
        estimatedValue: totals?.estValue ?? 0,
        tradeableValue: totals?.tradeableValue ?? 0,
        untradeableValue: totals?.untradeableValue ?? 0,
      },
    },
    requestId: c.get('requestId'),
  })
})

app.get('/players', async (c) => {
  const q = c.req.query()
  const { total, rows } = await searchPlayers(c.env, {
    name: q['name'],
    minRating: q['minRating'] ? Number(q['minRating']) : undefined,
    maxRating: q['maxRating'] ? Number(q['maxRating']) : undefined,
    cardType: q['cardType'],
    tradeability: q['tradeability'] as 'tradeable' | 'untradeable' | undefined,
    duplicatesOnly: q['duplicatesOnly'] === 'true',
    protectedOnly: q['protectedOnly'] === 'true',
    unprotectedOnly: q['unprotectedOnly'] === 'true',
    limit: Math.min(Number(q['limit'] ?? 50), MAX_ROWS),
    offset: Number(q['offset'] ?? 0),
  })

  return c.json({
    success: true,
    data: { total, players: rows.map(rowToAnnotated) },
    requestId: c.get('requestId'),
  })
})

app.get('/fodder', async (c) => {
  const db = getDb(c.env)
  // One row per rating band — at most ~25 rows regardless of club size.
  const bands = await db.all<{
    rating: number; total: number; tradeable: number; untradeable: number
    duplicate: number; protectedCount: number; estimatedValue: number
  }>(sql`
    SELECT
      rating,
      COUNT(*)                                                       AS total,
      SUM(CASE WHEN tradeability = 'tradeable'   THEN 1 ELSE 0 END)  AS tradeable,
      SUM(CASE WHEN tradeability = 'untradeable' THEN 1 ELSE 0 END)  AS untradeable,
      SUM(is_duplicate)                                              AS duplicate,
      SUM(is_protected)                                              AS protectedCount,
      COALESCE(SUM(value_coins), 0)                                  AS estimatedValue
    FROM players
    WHERE rating >= 80
    GROUP BY rating
    ORDER BY rating DESC
  `)
  return c.json({ success: true, data: { bands }, requestId: c.get('requestId') })
})

app.get('/duplicates', async (c) => {
  const db = getDb(c.env)
  // Spare copies only: one of each card is always held back, which is why the
  // count subtracts one rather than reporting every copy as available.
  const groups = await db.all<{
    assetId: string; name: string; rating: number; copies: number
    spare: number; spareValue: number
  }>(sql`
    SELECT
      asset_id                                                        AS assetId,
      MIN(name)                                                       AS name,
      MAX(rating)                                                     AS rating,
      COUNT(*)                                                        AS copies,
      MAX(0, SUM(CASE WHEN is_protected = 0 THEN 1 ELSE 0 END) - 1)   AS spare,
      COALESCE(SUM(CASE WHEN is_protected = 0 THEN value_coins ELSE 0 END), 0) AS spareValue
    FROM players
    GROUP BY asset_id
    HAVING COUNT(*) > 1 AND spare > 0
    ORDER BY rating DESC
    LIMIT ${MAX_ROWS}
  `)
  return c.json({ success: true, data: { groups }, requestId: c.get('requestId') })
})

app.get('/protected', async (c) => {
  const db = getDb(c.env)
  const countRow = await db.get<{ n: number }>(
    sql`SELECT COUNT(*) AS n FROM players WHERE is_protected = 1`,
  )
  const rows = await db.all<PlayerRow>(sql`
    SELECT * FROM players WHERE is_protected = 1
    ORDER BY rating DESC, value_coins DESC
    LIMIT ${MAX_ROWS} OFFSET ${Number(c.req.query('offset') ?? 0)}
  `)
  return c.json({
    success: true,
    data: { total: countRow?.n ?? 0, players: rows.map(rowToAnnotated) },
    requestId: c.get('requestId'),
  })
})

export default app
