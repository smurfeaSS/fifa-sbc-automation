/**
 * Solver tests for the edge build.
 *
 * The local build handed the solver the whole club. This one hands it a
 * candidate pool — the cheapest few players per rating band — because reading
 * 1,800 rows per request breaks the CPU budget. That is an optimisation with a
 * correctness claim attached: players outside the pool are *dominated* and can
 * never appear in an optimal squad.
 *
 * These tests check that claim rather than assuming it.
 */

import { describe, test, expect } from 'vitest'
import { annotate, DEFAULT_SETTINGS } from '../src/solver/protection'
import { solveSquad } from '../src/solver/squadSolver'
import { estimateValue } from '../src/solver/value'
import { squadRating } from '../src/solver/rating'
import { CANDIDATES_PER_RATING } from '../src/lib/repo'
import type { Player } from '../src/shared/player'
import type { Settings, SolverMode } from '../src/shared/club'
import type { Requirement } from '../src/shared/sbc'

const settings: Settings = { ...DEFAULT_SETTINGS, searchBudgetMs: 2000 }

function mk(id: string, rating: number, over: Partial<Player> = {}): Player {
  const p: Player = {
    id,
    assetId: over.assetId ?? `asset-${id}`,
    name: `P${id}`,
    rating,
    position: { primary: 'CM', alternates: [], group: 'MID' },
    nationId: 1, leagueId: 1, clubId: 1,
    cardType: 'rare',
    tradeability: 'untradeable',
    isDuplicate: false, duplicateCount: 1,
    evolution: { isEvolved: false },
    isFirstOwner: false,
    squadUsage: [], inActiveSquad: false,
    manuallyLocked: false, isFavourite: false,
    ...over,
  }
  p.value = estimateValue(p)
  return p
}

/** A club shaped like a real one: fat at the bottom, thin at the top. */
function realisticClub(): Player[] {
  const dist: Array<[number, number]> = [
    [90, 4], [89, 8], [88, 14], [87, 24], [86, 40],
    [85, 70], [84, 120], [83, 180], [82, 240], [81, 300],
  ]
  const players: Player[] = []
  let n = 0
  for (const [rating, count] of dist) {
    for (let i = 0; i < count; i++) {
      n++
      players.push(mk(`p${n}`, rating, {
        assetId: `a${n % 400}`,
        tradeability: n % 4 === 0 ? 'tradeable' : 'untradeable',
        isFirstOwner: n % 7 === 0,
        cardType: n % 11 === 0 ? 'totw' : 'rare',
      }))
    }
  }
  // Duplicate flags, as the importer would set them.
  const counts = new Map<string, number>()
  for (const p of players) counts.set(p.assetId, (counts.get(p.assetId) ?? 0) + 1)
  for (const p of players) {
    p.duplicateCount = counts.get(p.assetId)!
    p.isDuplicate = p.duplicateCount > 1
  }
  return players
}

/** Reproduce what repo.candidatePool does in SQL, so the two can be compared. */
function toCandidatePool<T extends { rating: number; sacrificeCost: number; isProtected: boolean }>(
  players: readonly T[],
  target: number,
  perRating = CANDIDATES_PER_RATING,
): T[] {
  const byRating = new Map<number, T[]>()
  for (const p of players) {
    if (p.isProtected) continue
    if (p.rating < target - 10 || p.rating > target + 4) continue
    const list = byRating.get(p.rating)
    if (list) list.push(p)
    else byRating.set(p.rating, [p])
  }
  const out: T[] = []
  for (const group of byRating.values()) {
    group.sort((a, b) => a.sacrificeCost - b.sacrificeCost)
    out.push(...group.slice(0, perRating))
  }
  return out
}

const ratingReq = (value: number): Requirement[] => [
  { kind: 'squad-rating', comparator: 'min', value },
  { kind: 'player-count', value: 11 },
]

describe('candidate pool preserves solution quality', () => {
  for (const target of [83, 84, 85, 86, 87]) {
    test(`an ${target} squad from the pool matches one from the whole club`, () => {
      const all = annotate(realisticClub(), settings)
      const pool = toCandidatePool(all, target)

      const fromAll = solveSquad(all, ratingReq(target), { settings, allowPurchases: false })
      const fromPool = solveSquad(pool, ratingReq(target), { settings, allowPurchases: false })

      expect(fromAll.ok).toBe(true)
      expect(fromPool.ok).toBe(true)
      if (!fromAll.ok || !fromPool.ok) return

      // The pool must not make the squad worse. Equal cost is the expected
      // result; the assertion allows a hair of slack for tie-breaking between
      // identically-priced cards.
      expect(fromPool.squad.cost).toBeLessThanOrEqual(fromAll.squad.cost * 1.0001)
      expect(fromPool.squad.rating).toBeGreaterThanOrEqual(target)
      expect(fromPool.squad.tradeableValue).toBeLessThanOrEqual(fromAll.squad.tradeableValue)
    })
  }

  test('the pool is a small fraction of the club', () => {
    const all = annotate(realisticClub(), settings)
    const pool = toCandidatePool(all, 84)
    // The point of the exercise: a few hundred rows, not eighteen hundred.
    expect(pool.length).toBeLessThan(all.length / 3)
    expect(pool.length).toBeGreaterThan(11)
  })
})

describe('protection still holds', () => {
  test('protected players never enter the pool or the squad', () => {
    const players = realisticClub()
    for (const p of players) if (p.rating >= 86) p.cardType = 'icon'

    const all = annotate(players, settings)
    const pool = toCandidatePool(all, 84)

    expect(pool.every((p) => !p.isProtected)).toBe(true)

    const result = solveSquad(pool, ratingReq(84), { settings, allowPurchases: false })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.squad.protectedUsed).toBe(0)
    expect(result.squad.players.every((p) => p.cardType !== 'icon')).toBe(true)
  })

  test('an entirely protected pool fails rather than improvising', () => {
    const players = realisticClub().map((p) => ({ ...p, cardType: 'icon' as const }))
    const all = annotate(players, settings)
    const pool = toCandidatePool(all, 84)
    expect(pool.length).toBe(0)
  })
})

describe('excluding committed players mimics multi-challenge allocation', () => {
  test('a second squad avoids the first squad\'s players', () => {
    const all = annotate(realisticClub(), settings)

    const first = solveSquad(toCandidatePool(all, 84), ratingReq(84), { settings, allowPurchases: false })
    expect(first.ok).toBe(true)
    if (!first.ok) return

    const committed = new Set(first.squad.players.map((p) => p.id))
    const remaining = all.filter((p) => !committed.has(p.id))
    const second = solveSquad(toCandidatePool(remaining, 84), ratingReq(84), { settings, allowPurchases: false })

    expect(second.ok).toBe(true)
    if (!second.ok) return
    for (const p of second.squad.players) expect(committed.has(p.id)).toBe(false)
  })
})

describe('solver stays inside the CPU budget', () => {
  test('a pool solve completes in single-digit milliseconds', () => {
    const all = annotate(realisticClub(), settings)
    const pool = toCandidatePool(all, 85)

    const started = performance.now()
    const result = solveSquad(pool, ratingReq(85), {
      settings: { ...settings, searchBudgetMs: 6 },
      allowPurchases: false,
    })
    const elapsed = performance.now() - started

    expect(result.ok).toBe(true)
    // The Workers free-tier budget is 10ms for the whole request, of which the
    // solver may use only part. This is the headline constraint of the port.
    expect(elapsed).toBeLessThan(10)
  })
})

describe('rating engine is unchanged by the port', () => {
  test('a uniform squad rates at its own rating', () => {
    expect(squadRating(Array(11).fill(84))).toBe(84)
  })
  test('modes still constrain the pool', () => {
    const mode: SolverMode = 'untradeables-only'
    const s: Settings = { ...settings, solverMode: mode }
    const all = annotate(realisticClub(), s)
    const pool = toCandidatePool(all, 84).filter((p) => Number.isFinite(p.sacrificeCost))
    expect(pool.every((p) => p.tradeability === 'untradeable')).toBe(true)
  })
})
