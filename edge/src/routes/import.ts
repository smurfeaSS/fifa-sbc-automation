/**
 * Chunked club import.
 *
 * A full export is ~3MB of JSON and ~1,800 players. Parsing and annotating
 * that in one request would exceed the 10ms CPU budget several times over
 * (CLAUDE.md §17 names JSON.parse on large payloads as a forbidden pattern),
 * so the client splits it and posts a few hundred players at a time.
 *
 * The flow is:
 *   POST /api/import/begin    — clear the old club, open an import
 *   POST /api/import/chunk    — normalise, annotate and insert a slice
 *   POST /api/import/finish   — compute duplicates and squad usage, close it
 *
 * Duplicate detection and squad membership are deliberately deferred to
 * `finish`: both are whole-club properties and cannot be known while players
 * are still arriving. They run as bounded SQL updates rather than in JS.
 */

import { Hono } from 'hono'
import { eq, sql } from 'drizzle-orm'
import { getDb, schema } from '../lib/db'
import { annotatedToRow } from '../lib/repo'
import { normalizeItem, type RawItem } from '../lib/normalizers'
import { annotate } from '../solver/protection'
import { estimateValue } from '../solver/value'
import { loadSettings } from '../lib/settings'
import type { AppEnv } from '../types'

const app = new Hono<AppEnv>()

/** Players per chunk. Kept low enough that annotate() stays well inside budget. */
export const MAX_CHUNK = 250

app.post('/begin', async (c) => {
  type BeginBody = { exportedAt?: string; gameVersion?: string }
  const body = await c.req.json<BeginBody>().catch((): BeginBody => ({}))
  const db = getDb(c.env)
  const token = crypto.randomUUID()

  // A new import replaces the old club outright. Merging would leave cards you
  // have since spent still sitting in the database.
  await db.delete(schema.players)
  await db.delete(schema.squads)
  await db.delete(schema.clubMeta)

  await db.insert(schema.clubMeta).values({
    id: 1,
    exportedAt: body.exportedAt ?? new Date().toISOString(),
    gameVersion: body.gameVersion ?? 'unknown',
    playerCount: 0,
    importInProgress: true,
    importToken: token,
  })

  return c.json({ success: true, data: { token, maxChunk: MAX_CHUNK }, requestId: c.get('requestId') })
})

app.post('/chunk', async (c) => {
  const body = await c.req.json<{ token?: string; items?: RawItem[] }>().catch(() => null)
  if (!body?.token || !Array.isArray(body.items)) {
    return c.json({ success: false, error: 'token and items are required', code: 'BAD_REQUEST', requestId: c.get('requestId') }, 400)
  }
  if (body.items.length > MAX_CHUNK) {
    return c.json({ success: false, error: `chunk too large, max ${MAX_CHUNK}`, code: 'CHUNK_TOO_LARGE', requestId: c.get('requestId') }, 413)
  }

  const db = getDb(c.env)
  const meta = await db.select().from(schema.clubMeta).where(eq(schema.clubMeta.id, 1)).get()
  if (!meta || meta.importToken !== body.token) {
    return c.json({ success: false, error: 'no matching import in progress', code: 'NO_IMPORT', requestId: c.get('requestId') }, 409)
  }

  const settings = await loadSettings(c.env)
  const importedAt = new Date().toISOString()

  const skipped: string[] = []
  const players = []
  for (const raw of body.items) {
    const result = normalizeItem(raw)
    if (!result.ok) { skipped.push(result.reason); continue }
    result.player.value = estimateValue(result.player)
    players.push(result.player)
  }

  // Annotated now, against current settings. Duplicate flags are still false at
  // this point, so the duplicate bonus is applied in `finish` instead.
  const annotated = annotate(players, settings)
  const rows = annotated.map((p) => annotatedToRow(p, importedAt))

  if (rows.length > 0) {
    // D1 batch is transactional. Insert in sub-batches so a chunk never
    // produces a single statement larger than D1 will accept.
    const BATCH = 50
    for (let i = 0; i < rows.length; i += BATCH) {
      await db.insert(schema.players).values(rows.slice(i, i + BATCH)).onConflictDoNothing()
    }
  }

  await db
    .update(schema.clubMeta)
    .set({ playerCount: meta.playerCount + rows.length })
    .where(eq(schema.clubMeta.id, 1))

  return c.json({
    success: true,
    data: { inserted: rows.length, skipped: skipped.length, total: meta.playerCount + rows.length },
    requestId: c.get('requestId'),
  })
})

app.post('/finish', async (c) => {
  const body = await c.req.json<{ token?: string; squads?: unknown[] }>().catch(() => null)
  const db = getDb(c.env)
  const meta = await db.select().from(schema.clubMeta).where(eq(schema.clubMeta.id, 1)).get()
  if (!meta || meta.importToken !== body?.token) {
    return c.json({ success: false, error: 'no matching import in progress', code: 'NO_IMPORT', requestId: c.get('requestId') }, 409)
  }

  // Squads first — squad membership feeds protection.
  const squadRows = normalizeSquads(body?.squads ?? [])
  if (squadRows.length > 0) {
    await db.insert(schema.squads).values(squadRows).onConflictDoNothing()
  }

  // Duplicates are a whole-club property: set them in SQL rather than pulling
  // every player into the isolate to count asset ids.
  await db.run(sql`
    UPDATE players SET
      duplicate_count = (SELECT COUNT(*) FROM players p2 WHERE p2.asset_id = players.asset_id),
      is_duplicate = (SELECT COUNT(*) FROM players p2 WHERE p2.asset_id = players.asset_id) > 1
  `)

  // Squad usage, likewise. json_each is available in D1's SQLite build.
  for (const squad of squadRows) {
    await db.run(sql`
      UPDATE players
      SET squad_usage = json_insert(squad_usage, '$[#]', ${squad.id}),
          in_active_squad = CASE WHEN ${squad.isActive ? 1 : 0} = 1 THEN 1 ELSE in_active_squad END
      WHERE id IN (SELECT value FROM json_each(${squad.playerIds}))
    `)
  }

  // Duplicate and squad flags changed, so the annotations written during
  // chunking are now stale. Re-annotating is the one unavoidable whole-club
  // pass; it runs in bounded pages (see reannotate) rather than in one go.
  const { reannotateAll } = await import('../lib/annotate')
  const updated = await reannotateAll(c.env)

  await db
    .update(schema.clubMeta)
    .set({ importInProgress: false, importToken: null })
    .where(eq(schema.clubMeta.id, 1))

  return c.json({
    success: true,
    data: { players: meta.playerCount, squads: squadRows.length, reannotated: updated },
    requestId: c.get('requestId'),
  })
})

function normalizeSquads(raw: unknown[]): Array<typeof schema.squads.$inferInsert> {
  const out: Array<typeof schema.squads.$inferInsert> = []
  for (const rs of raw) {
    if (!rs || typeof rs !== 'object') continue
    const r = rs as Record<string, unknown>
    const id = String(r['id'] ?? r['squadId'] ?? out.length)

    let playerIds: string[] = []
    const players = r['players']
    if (Array.isArray(players)) {
      playerIds = players
        .map((p) => {
          if (!p || typeof p !== 'object') return undefined
          const pr = p as Record<string, unknown>
          const nested = pr['itemData'] as Record<string, unknown> | undefined
          const v = nested?.['id'] ?? pr['id'] ?? pr['itemId']
          return v === undefined || v === null ? undefined : String(v)
        })
        .filter((x): x is string => !!x && x !== '0')
    }

    out.push({
      id,
      name: String(r['squadName'] ?? r['name'] ?? `Squad ${id}`),
      formation: typeof r['formation'] === 'string' ? r['formation'] : null,
      playerIds: JSON.stringify(playerIds),
      isActive: r['isActive'] === true || id === '0',
    })
  }
  if (out.length > 0 && !out.some((s) => s.isActive)) out[0]!.isActive = true
  return out
}

export default app
