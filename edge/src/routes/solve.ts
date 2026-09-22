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
import { solveSbcSet } from '../solver/globalAllocator'
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
const BAND_BELOW = 12
const BAND_ABOVE = 5

/**
 * Ceilings on solver search time. These are limits, not targets.
 *
 * Branch-and-bound returns the moment it has proved it cannot do better, which
 * on an ordinary club is single-digit milliseconds — the measured figures are
 * 1-3ms for one squad and ~19ms for a five-squad set. The budget only matters
 * on a club or an SBC awkward enough that the search would otherwise be cut
 * short and hand back a worse squad.
 *
 * On the free plan these had to be 6ms, which meant occasionally settling. With
 * the paid CPU allowance they are set to values a person still experiences as
 * instant, so the search is limited by having found the answer rather than by
 * running out of time.
 */
const SOLVE_BUDGET_MS = 250
const SET_BUDGET_MS = 2000

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

/**
 * Solve an entire SBC set in one request.
 *
 * This is what the free plan could not afford. It runs the real global
 * allocator — hardest challenge first, several candidate orderings, and
 * refinement passes that release a challenge's players and re-solve it against
 * the freed pool, keeping the change only when the total improves.
 *
 * The refinement is the part the split per-challenge flow cannot do: it is what
 * undoes a bad early commitment that looked locally optimal, which is exactly
 * the automation.md §5 failure mode.
 *
 * The client still has POST /challenge available and falls back to it if this
 * ever times out.
 */
app.post('/set', async (c) => {
  const body = await c.req.json<{ sbcId?: string }>().catch(() => null)
  if (!body?.sbcId) {
    return c.json({ success: false, error: 'sbcId is required', code: 'BAD_REQUEST', requestId: c.get('requestId') }, 400)
  }

  const set = await loadSet(c.env, body.sbcId)
  if (!set) {
    return c.json({ success: false, error: 'SBC not found', code: 'NOT_FOUND', requestId: c.get('requestId') }, 404)
  }

  const settings = await loadSettings(c.env)
  const pending = set.challenges.filter((ch) => !ch.completed)
  if (pending.length === 0) {
    return c.json({ success: true, data: { set: { id: set.id, name: set.name }, challenges: [], totals: null }, requestId: c.get('requestId') })
  }

  // One pool covering every challenge's band, fetched once. Reading it per
  // challenge would be the same rows several times over.
  const targets = pending.map((ch) => requiredRating(ch.requirements)).filter((r): r is number => r !== null)
  const minRating = targets.length > 0 ? Math.max(0, Math.min(...targets) - BAND_BELOW) : 0
  const maxRating = targets.length > 0 ? Math.min(99, Math.max(...targets) + BAND_ABOVE) : 99

  const pool = await candidatePool(c.env, { minRating, maxRating })

  if (pool.length === 0) {
    return c.json({
      success: false,
      error: 'No usable players in range — either everything nearby is protected, or the club has nothing at these ratings.',
      code: 'EMPTY_POOL',
      requestId: c.get('requestId'),
    }, 409)
  }

  const solution = solveSbcSet(set, pool, { settings, budgetMs: SET_BUDGET_MS })

  return c.json({
    success: true,
    data: {
      set: { id: set.id, name: set.name, source: set.source },
      totals: solution.totals,
      completable: solution.completable,
      unsolved: solution.unsolved,
      challenges: solution.challenges.map((allocated) => ({
        challenge: { id: allocated.challenge.id, name: allocated.challenge.name },
        solved: Boolean(allocated.squad),
        message: allocated.failure?.message ?? null,
        preview: allocated.squad
          ? buildPreview(allocated.squad, settings, requiredRating(allocated.challenge.requirements))
          : null,
      })),
      /**
       * How much of the club the search had to look at.
       *
       * Deliberately NOT a duration: Workers coarsens Date.now() and
       * performance.now() as a Spectre mitigation — they advance only on I/O,
       * so timing a pure-CPU section in here reports 0 regardless of what it
       * cost. Real CPU time comes from `wrangler tail`, which reports it per
       * request. Reporting a measured-looking zero would be worse than
       * reporting nothing.
       */
      searched: { poolRows: pool.length, challenges: pending.length },
    },
    requestId: c.get('requestId'),
  })
})

export default app
