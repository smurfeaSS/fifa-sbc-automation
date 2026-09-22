/**
 * Solving, one challenge per request.
 *
 * The local build solved a whole SBC set in a single call, with refinement
 * rounds. That is ~19ms of CPU and does not fit the 10ms budget, so the work is
 * split:
 *
 *   GET  /api/solve/plan?sbcId=…   — server computes the hardest-first order
 *   POST /api/solve/challenge      — solve one, given the ids already committed
 *
 * The client walks the plan, accumulating committed ids. That preserves the
 * thing §5 is actually about — the scarce high-rated cards go to the squad
 * that has no alternative — while each request stays small.
 *
 * The other half of staying in budget is never reading the whole club: the
 * solver is handed a candidate pool of the cheapest few players per rating
 * band, which is all an optimal squad can ever draw from.
 */

import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { getDb, schema } from '../lib/db'
import { candidatePool, ratingHistogram } from '../lib/repo'
import { loadSettings } from '../lib/settings'
import { solveSquad } from '../solver/squadSolver'
import { buildPreview } from '../solver/preview'
import { requiredRating } from '../solver/requirements'
import { solveOrder, poolStats, type PoolStats } from '../solver/ordering'
import type { AppEnv } from '../types'
import type { SbcSet, Challenge } from '../shared/sbc'

const app = new Hono<AppEnv>()

/**
 * How far below the target rating to draw candidates.
 *
 * A squad rated N is built mostly from cards around N, with some below. Ten
 * points down is generous; widening it costs rows and CPU for combinations that
 * never win. Upward headroom is small because overshooting is penalised anyway.
 */
const BAND_BELOW = 10
const BAND_ABOVE = 4

/** Hard ceiling on solver search time, well inside the CPU budget. */
const SOLVE_BUDGET_MS = 6

async function loadSet(env: AppEnv['Bindings'], sbcId: string): Promise<SbcSet | null> {
  const db = getDb(env)
  const row = await db.select().from(schema.sbcs).where(eq(schema.sbcs.id, sbcId)).get()
  if (!row) return null
  try {
    return JSON.parse(row.json) as SbcSet
  } catch {
    console.error(`[solve] SBC ${sbcId} has unreadable JSON`)
    return null
  }
}

/**
 * Pool statistics for ordering, built from a rating histogram rather than the
 * player rows. Counting by rating is an indexed GROUP BY; pulling every player
 * to count them in JS is exactly what the budget forbids.
 */
async function orderingStats(env: AppEnv['Bindings']): Promise<PoolStats> {
  const histogram = await ratingHistogram(env)
  const total = histogram.reduce((a, h) => a + h.n, 0)
  return {
    total,
    countAtOrAbove: (rating) =>
      histogram.reduce((a, h) => (h.rating >= rating ? a + h.n : a), 0),
    // Predicate counting needs real rows, which ordering deliberately avoids.
    // Returning the total makes an unknown constraint look abundant rather than
    // scarce, so it never fabricates urgency the histogram cannot support.
    countMatching: () => total,
  }
}

app.get('/plan', async (c) => {
  const sbcId = c.req.query('sbcId')
  if (!sbcId) {
    return c.json({ success: false, error: 'sbcId is required', code: 'BAD_REQUEST', requestId: c.get('requestId') }, 400)
  }

  const set = await loadSet(c.env, sbcId)
  if (!set) {
    return c.json({ success: false, error: 'SBC not found', code: 'NOT_FOUND', requestId: c.get('requestId') }, 404)
  }

  const stats = await orderingStats(c.env)
  const ordered = solveOrder(set.challenges, stats)

  return c.json({
    success: true,
    data: {
      set: { id: set.id, name: set.name, source: set.source },
      // Hardest first. The client must solve in this order for the allocation
      // to come out right — solving in the game's display order is the §5 trap.
      order: ordered.map((ch) => ({ id: ch.id, name: ch.name })),
      poolSize: stats.total,
    },
    requestId: c.get('requestId'),
  })
})

app.post('/challenge', async (c) => {
  const body = await c.req
    .json<{ sbcId?: string; challengeId?: string; committedIds?: string[] }>()
    .catch(() => null)

  if (!body?.sbcId || !body.challengeId) {
    return c.json({ success: false, error: 'sbcId and challengeId are required', code: 'BAD_REQUEST', requestId: c.get('requestId') }, 400)
  }

  const set = await loadSet(c.env, body.sbcId)
  if (!set) {
    return c.json({ success: false, error: 'SBC not found', code: 'NOT_FOUND', requestId: c.get('requestId') }, 404)
  }

  const challenge: Challenge | undefined = set.challenges.find((ch) => ch.id === body.challengeId)
  if (!challenge) {
    return c.json({ success: false, error: 'challenge not found', code: 'NOT_FOUND', requestId: c.get('requestId') }, 404)
  }

  const settings = await loadSettings(c.env)
  const target = requiredRating(challenge.requirements)

  // With no rating requirement there is no band to centre on, so draw from the
  // cheap end — those are the cards a chemistry- or nation-only SBC wants.
  const minRating = target !== null ? Math.max(0, target - BAND_BELOW) : 0
  const maxRating = target !== null ? Math.min(99, target + BAND_ABOVE) : 99

  const committed = body.committedIds ?? []
  const pool = await candidatePool(c.env, { minRating, maxRating, excludeIds: committed })

  if (pool.length === 0) {
    return c.json({
      success: true,
      data: {
        challenge: { id: challenge.id, name: challenge.name },
        solved: false,
        reason: 'empty-pool',
        message:
          'No usable players in range. Either every candidate is protected, or ' +
          'the club has nothing near this rating.',
      },
      requestId: c.get('requestId'),
    })
  }

  const result = solveSquad(pool, challenge.requirements, {
    settings,
    budgetMs: SOLVE_BUDGET_MS,
  })

  if (!result.ok) {
    return c.json({
      success: true,
      data: {
        challenge: { id: challenge.id, name: challenge.name },
        solved: false,
        reason: result.reason,
        message: result.message,
      },
      requestId: c.get('requestId'),
    })
  }

  const preview = buildPreview(result.squad, settings, target)

  return c.json({
    success: true,
    data: {
      challenge: { id: challenge.id, name: challenge.name },
      solved: true,
      preview,
      // The client adds these to committedIds before solving the next one.
      usedIds: result.squad.players.map((p) => p.id),
    },
    requestId: c.get('requestId'),
  })
})

export default app
