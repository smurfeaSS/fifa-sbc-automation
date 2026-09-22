/** Price list import and inspection. */

import { Hono } from 'hono'
import { sql } from 'drizzle-orm'
import { getDb, schema } from '../lib/db'
import { parsePriceList } from '../lib/parsePrices'
import { MAX_ROWS } from '../lib/repo'
import type { AppEnv } from '../types'
import type { PriceRow } from '../lib/schema'

const app = new Hono<AppEnv>()

/** Rows per insert batch, so one paste cannot produce an oversized statement. */
const BATCH = 100

app.post('/import', async (c) => {
  const body = await c.req.json<{ text?: string; replace?: boolean }>().catch(() => null)
  if (!body?.text) {
    return c.json({ success: false, error: 'text is required', code: 'BAD_REQUEST', requestId: c.get('requestId') }, 400)
  }

  const parsed = parsePriceList(body.text)
  if (parsed.prices.length === 0) {
    return c.json({
      success: false,
      error: 'No prices could be read from that. Expected rows like "Mbappé, 91, 1200000" or "91, 1200000".',
      code: 'NO_PRICES',
      requestId: c.get('requestId'),
    }, 400)
  }

  const db = getDb(c.env)
  // Replacing wholesale is the default for a reason: a stale price is worse
  // than no price, because the solver will act on it.
  if (body.replace !== false) await db.delete(schema.prices)

  const updatedAt = new Date().toISOString()
  const rows = parsed.prices.map((p, i) => ({
    id: `${p.rating}-${p.name ?? 'band'}-${i}`.slice(0, 120),
    assetId: null,
    name: p.name ?? null,
    rating: p.rating,
    quality: p.rating >= 75 ? 'gold' : p.rating >= 65 ? 'silver' : 'bronze',
    rarity: p.rarity,
    position: p.position ?? null,
    nationId: null,
    nationName: p.nationName ?? null,
    leagueId: null,
    leagueName: p.leagueName ?? null,
    clubId: null,
    clubName: p.clubName ?? null,
    priceCoins: p.priceCoins,
    source: 'import',
    updatedAt,
  }))

  for (let i = 0; i < rows.length; i += BATCH) {
    await db.insert(schema.prices).values(rows.slice(i, i + BATCH)).onConflictDoNothing()
  }

  return c.json({
    success: true,
    data: {
      imported: rows.length,
      skipped: parsed.skipped,
      // Returned rather than counted: a line that failed to parse is something
      // you can fix, and only seeing it lets you fix it.
      errors: parsed.errors.slice(0, 20),
      errorCount: parsed.errors.length,
    },
    requestId: c.get('requestId'),
  })
})

app.get('/', async (c) => {
  const db = getDb(c.env)
  const countRow = await db.get<{ n: number; updated: string | null }>(
    sql`SELECT COUNT(*) AS n, MAX(updated_at) AS updated FROM prices`,
  )
  const rows = await db.all<PriceRow>(sql`
    SELECT * FROM prices ORDER BY rating DESC, price_coins ASC LIMIT ${MAX_ROWS}
  `)
  return c.json({
    success: true,
    data: { total: countRow?.n ?? 0, updatedAt: countRow?.updated ?? null, prices: rows },
    requestId: c.get('requestId'),
  })
})

app.delete('/', async (c) => {
  await getDb(c.env).delete(schema.prices)
  return c.json({ success: true, data: { cleared: true }, requestId: c.get('requestId') })
})

export default app
