/** Settings, locks, SBC definitions and history. */

import { Hono } from 'hono'
import { eq, desc, sql } from 'drizzle-orm'
import { getDb, schema } from '../lib/db'
import { loadSettings, saveSettings } from '../lib/settings'
import { reannotatePage, ANNOTATE_PAGE } from '../lib/annotate'
import { parseRequirements } from '../lib/parseRequirements'
import { MAX_ROWS } from '../lib/repo'
import type { AppEnv } from '../types'
import type { Settings } from '../shared/club'
import type { SbcSet } from '../shared/sbc'

const app = new Hono<AppEnv>()

// ─── settings ────────────────────────────────────────────────────────────────

app.get('/settings', async (c) =>
  c.json({ success: true, data: await loadSettings(c.env), requestId: c.get('requestId') }),
)

app.post('/settings', async (c) => {
  const body = await c.req.json<Partial<Settings>>().catch(() => null)
  if (!body) {
    return c.json({ success: false, error: 'invalid body', code: 'BAD_REQUEST', requestId: c.get('requestId') }, 400)
  }

  const current = await loadSettings(c.env)
  const next: Settings = {
    ...current,
    ...body,
    protection: { ...current.protection, ...(body.protection ?? {}) },
    weights: { ...current.weights, ...(body.weights ?? {}) },
    sbcSources: { ...current.sbcSources, ...(body.sbcSources ?? {}) },
  }
  await saveSettings(c.env, next)

  // Protection columns are now stale. Re-annotation is paged and driven by the
  // client, because doing the whole club here would exceed the CPU budget on
  // any real club — the response says where to resume.
  const first = await reannotatePage(c.env, 0)

  return c.json({
    success: true,
    data: {
      settings: next,
      reannotate: { updated: first.updated, done: first.done, nextOffset: first.nextOffset, pageSize: ANNOTATE_PAGE },
    },
    requestId: c.get('requestId'),
  })
})

/** Continue a paged re-annotation. The client loops until `done`. */
app.post('/reannotate', async (c) => {
  const body = await c.req.json<{ offset?: number }>().catch(() => ({ offset: 0 }))
  const page = await reannotatePage(c.env, Math.max(0, body.offset ?? 0))
  return c.json({ success: true, data: page, requestId: c.get('requestId') })
})

// ─── locks ───────────────────────────────────────────────────────────────────

app.post('/lock', async (c) => {
  const body = await c.req.json<{ itemId?: string; locked?: boolean }>().catch(() => null)
  if (!body?.itemId) {
    return c.json({ success: false, error: 'itemId is required', code: 'BAD_REQUEST', requestId: c.get('requestId') }, 400)
  }

  const settings = await loadSettings(c.env)
  const locking = body.locked !== false
  const locks = new Set(settings.protection.manualLocks)
  const overrides = new Set(settings.protection.manualOverrides)

  if (locking) { locks.add(body.itemId); overrides.delete(body.itemId) }
  else { locks.delete(body.itemId) }

  settings.protection.manualLocks = [...locks]
  settings.protection.manualOverrides = [...overrides]
  await saveSettings(c.env, settings)

  // Only this one player's annotation changed, so update that row rather than
  // re-annotating the club.
  const db = getDb(c.env)
  await db
    .update(schema.players)
    .set({
      manuallyLocked: locking,
      isProtected: locking ? true : undefined,
      protectionReasons: locking ? JSON.stringify(['Manually locked']) : undefined,
    })
    .where(eq(schema.players.id, body.itemId))

  // Unlocking can re-expose the player to other rules, so recompute that row.
  if (!locking) {
    const { reannotateOne } = await import('../lib/annotateOne')
    await reannotateOne(c.env, body.itemId)
  }

  return c.json({ success: true, data: { locked: locking }, requestId: c.get('requestId') })
})

// ─── SBCs ────────────────────────────────────────────────────────────────────

app.get('/sbcs', async (c) => {
  const db = getDb(c.env)
  const rows = await db
    .select({
      id: schema.sbcs.id, name: schema.sbcs.name, category: schema.sbcs.category,
      sourceKind: schema.sbcs.sourceKind, confidence: schema.sbcs.confidence, json: schema.sbcs.json,
    })
    .from(schema.sbcs)
    .limit(MAX_ROWS)

  const sets = rows.map((r) => {
    let challengeCount = 0
    try { challengeCount = (JSON.parse(r.json) as SbcSet).challenges.length } catch { /* shown as 0 */ }
    return { id: r.id, name: r.name, category: r.category, sourceKind: r.sourceKind, confidence: r.confidence, challengeCount }
  })

  return c.json({ success: true, data: { sets }, requestId: c.get('requestId') })
})

app.post('/sbc', async (c) => {
  const body = await c.req.json<{ set?: SbcSet }>().catch(() => null)
  if (!body?.set?.id || !Array.isArray(body.set.challenges)) {
    return c.json({ success: false, error: 'a valid SBC set is required', code: 'BAD_REQUEST', requestId: c.get('requestId') }, 400)
  }

  const set = body.set
  const db = getDb(c.env)
  const json = JSON.stringify(set)
  const updatedAt = new Date().toISOString()

  await db
    .insert(schema.sbcs)
    .values({
      id: set.id, name: set.name, category: set.category ?? null, json,
      sourceKind: set.source?.kind ?? 'manual', confidence: set.source?.confidence ?? 1, updatedAt,
    })
    .onConflictDoUpdate({
      target: schema.sbcs.id,
      set: { name: set.name, category: set.category ?? null, json, confidence: set.source?.confidence ?? 1, updatedAt },
    })

  return c.json({ success: true, data: { saved: true, id: set.id }, requestId: c.get('requestId') })
})

app.delete('/sbc/:id', async (c) => {
  const db = getDb(c.env)
  await db.delete(schema.sbcs).where(eq(schema.sbcs.id, c.req.param('id')))
  return c.json({ success: true, data: { deleted: true }, requestId: c.get('requestId') })
})

/** Turn pasted requirement text into structured constraints. */
app.post('/parse-sbc', async (c) => {
  const body = await c.req.json<{ text?: string }>().catch(() => null)
  const parsed = parseRequirements((body?.text ?? '').split('\n'))
  return c.json({ success: true, data: parsed, requestId: c.get('requestId') })
})

// ─── history ─────────────────────────────────────────────────────────────────

app.get('/history', async (c) => {
  const db = getDb(c.env)
  const entries = await db
    .select()
    .from(schema.history)
    .orderBy(desc(schema.history.date))
    .limit(MAX_ROWS)
  return c.json({ success: true, data: { entries }, requestId: c.get('requestId') })
})

app.post('/history', async (c) => {
  type HistoryBody = Record<string, unknown>
  const body = await c.req.json<HistoryBody>().catch((): HistoryBody => ({}))
  const db = getDb(c.env)
  await db.insert(schema.history).values({
    id: crypto.randomUUID(),
    sbcName: String(body['sbcName'] ?? 'Unknown'),
    challengeName: String(body['challengeName'] ?? ''),
    date: new Date().toISOString(),
    playersSubmitted: Number(body['playersSubmitted'] ?? 0),
    playerIds: JSON.stringify(body['playerIds'] ?? []),
    estimatedValue: Math.round(Number(body['estimatedValue'] ?? 0)),
    tradeableValue: Math.round(Number(body['tradeableValue'] ?? 0)),
    untradeableValue: Math.round(Number(body['untradeableValue'] ?? 0)),
    duplicatesUsed: Number(body['duplicatesUsed'] ?? 0),
    notes: body['notes'] ? String(body['notes']) : null,
  })
  return c.json({ success: true, data: { recorded: true }, requestId: c.get('requestId') })
})

export default app
