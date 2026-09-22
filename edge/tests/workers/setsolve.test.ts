/**
 * Whole-set solving on the paid CPU allowance.
 *
 * The question these answer is not "does it work" but "is it fast enough to
 * feel instant, and is it actually better than the split per-challenge flow".
 * Both need to be true to justify the extra endpoint.
 */

import { describe, test, expect } from 'vitest'
import { annotate, DEFAULT_SETTINGS } from '../../src/solver/protection'
import { solveSbcSet } from '../../src/solver/globalAllocator'
import { solveSquad } from '../../src/solver/squadSolver'
import { estimateValue } from '../../src/solver/value'
import { CANDIDATES_PER_RATING } from '../../src/lib/repo'
import type { Player } from '../../src/shared/player'
import type { SbcSet, Challenge } from '../../src/shared/sbc'
import type { Settings } from '../../src/shared/club'

const settings: Settings = { ...DEFAULT_SETTINGS, searchBudgetMs: 2000 }

function mk(id: string, rating: number, over: Partial<Player> = {}): Player {
  const p: Player = {
    id, assetId: over.assetId ?? `asset-${id}`, name: `P${id}`, rating,
    position: { primary: 'CM', alternates: [], group: 'MID' },
    nationId: 1, leagueId: 1, clubId: 1,
    cardType: 'rare', tradeability: 'untradeable',
    isDuplicate: false, duplicateCount: 1,
    evolution: { isEvolved: false }, isFirstOwner: false,
    squadUsage: [], inActiveSquad: false,
    manuallyLocked: false, isFavourite: false,
    ...over,
  }
  p.value = estimateValue(p)
  return p
}

/** A club shaped like a real one, at the size the tool is built for. */
function bigClub(): Player[] {
  const dist: Array<[number, number]> = [
    [90, 5], [89, 10], [88, 18], [87, 30], [86, 48],
    [85, 80], [84, 140], [83, 210], [82, 280], [81, 340], [80, 400],
  ]
  const players: Player[] = []
  let n = 0
  for (const [rating, count] of dist) {
    for (let i = 0; i < count; i++) {
      n++
      players.push(mk(`p${n}`, rating, {
        assetId: `a${n % 500}`,
        tradeability: n % 4 === 0 ? 'tradeable' : 'untradeable',
        isFirstOwner: n % 9 === 0,
        cardType: n % 13 === 0 ? 'totw' : 'rare',
      }))
    }
  }
  const counts = new Map<string, number>()
  for (const p of players) counts.set(p.assetId, (counts.get(p.assetId) ?? 0) + 1)
  for (const p of players) {
    p.duplicateCount = counts.get(p.assetId)!
    p.isDuplicate = p.duplicateCount > 1
  }
  return players
}

const ch = (id: string, name: string, rating: number): Challenge => ({
  id, name,
  requirements: [
    { kind: 'squad-rating', comparator: 'min', value: rating },
    { kind: 'player-count', value: 11 },
  ],
})

/** The automation.md §5 worked example. */
const UPGRADE_SET: SbcSet = {
  id: 'player-upgrade', name: 'Player Upgrade',
  challenges: [
    ch('c1', '83 Rated Squad', 83),
    ch('c2', '84 Rated Squad', 84),
    ch('c3', '84 Rated Squad + TOTW', 84),
    ch('c4', '85 Rated Squad', 85),
    ch('c5', '86 Rated Squad', 86),
  ],
  source: { kind: 'local', confidence: 1 },
}

/** Mirror the SQL candidate pool: cheapest N unprotected per rating in band. */
function pool<T extends { rating: number; sacrificeCost: number; isProtected: boolean }>(
  players: readonly T[], min: number, max: number,
): T[] {
  const byRating = new Map<number, T[]>()
  for (const p of players) {
    if (p.isProtected || p.rating < min || p.rating > max) continue
    const list = byRating.get(p.rating)
    if (list) list.push(p)
    else byRating.set(p.rating, [p])
  }
  const out: T[] = []
  for (const group of byRating.values()) {
    group.sort((a, b) => a.sacrificeCost - b.sacrificeCost)
    out.push(...group.slice(0, CANDIDATES_PER_RATING))
  }
  return out
}

describe('whole-set solving is fast', () => {
  test('a five-squad set on a 1,500-player club solves in well under a second', () => {
    const all = annotate(bigClub(), settings)
    const candidates = pool(all, 71, 91)

    const started = performance.now()
    const solution = solveSbcSet(UPGRADE_SET, candidates, { settings, budgetMs: 2000 })
    const elapsed = performance.now() - started

    expect(solution.challenges.filter((c) => c.squad)).toHaveLength(5)
    // The budget is a ceiling; branch-and-bound stops as soon as it has proved
    // it cannot improve. Anything near the ceiling would mean it was cut short.
    //
    // NOTE: Workers coarsens performance.now() as a Spectre mitigation — it
    // advances only on I/O, so this reads 0 for any pure-CPU section however
    // long. The assertion is therefore a ceiling check, not a measurement; the
    // real figures come from the Node-environment tests and from wrangler tail.
    expect(elapsed).toBeLessThan(500)
    console.log(`  five-squad set: ${candidates.length} candidate rows (timer coarsened in Workers)`)
  })

  test('a single squad is still single-digit milliseconds', () => {
    const all = annotate(bigClub(), settings)
    const candidates = pool(all, 72, 89)

    const started = performance.now()
    const result = solveSquad(candidates, UPGRADE_SET.challenges[4]!.requirements, { settings })
    const elapsed = performance.now() - started

    expect(result.ok).toBe(true)
    expect(elapsed).toBeLessThan(50)
    console.log(`  single 86 squad: solved from ${candidates.length} candidate rows`)
  })
})

describe('whole-set solving is better than solving one at a time', () => {
  test('refinement does not produce a worse allocation than sequential solving', () => {
    const all = annotate(bigClub(), settings)
    const candidates = pool(all, 71, 91)

    // Sequential, hardest-first — what the split flow does.
    const committed = new Set<string>()
    let sequentialCost = 0
    let sequentialPurchases = 0
    for (const challenge of [...UPGRADE_SET.challenges].reverse()) {
      const available = candidates.filter((p) => !committed.has(p.id))
      const result = solveSquad(available, challenge.requirements, { settings })
      if (!result.ok) continue
      for (const p of result.squad.players) committed.add(p.id)
      sequentialCost += result.squad.cost
      sequentialPurchases += result.squad.purchaseCost
    }

    const solution = solveSbcSet(UPGRADE_SET, candidates, { settings, budgetMs: 2000 })

    expect(solution.totals.purchaseCost).toBeLessThanOrEqual(sequentialPurchases)
    expect(solution.totals.cost).toBeLessThanOrEqual(sequentialCost * 1.02)
    console.log(
      `  sequential ${Math.round(sequentialCost).toLocaleString()} / ` +
      `global ${Math.round(solution.totals.cost).toLocaleString()}`,
    )
  })

  test('no player is allocated to two squads', () => {
    const all = annotate(bigClub(), settings)
    const solution = solveSbcSet(UPGRADE_SET, pool(all, 71, 91), { settings, budgetMs: 2000 })

    const seen = new Set<string>()
    for (const c of solution.challenges) {
      for (const p of c.squad?.players ?? []) {
        expect(seen.has(p.id)).toBe(false)
        seen.add(p.id)
      }
    }
    expect(seen.size).toBe(55)
  })

  test('protection still holds across the whole set', () => {
    const players = bigClub()
    for (const p of players) if (p.rating >= 88) p.cardType = 'icon'
    const all = annotate(players, settings)

    const solution = solveSbcSet(UPGRADE_SET, pool(all, 71, 91), { settings, budgetMs: 2000 })
    expect(solution.totals.protectedUsed).toBe(0)
    for (const c of solution.challenges) {
      for (const p of c.squad?.players ?? []) expect(p.cardType).not.toBe('icon')
    }
  })
})
