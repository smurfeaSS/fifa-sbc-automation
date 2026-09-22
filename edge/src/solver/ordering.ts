/**
 * Challenge ordering — the part of the global allocator that survives the move
 * to Workers.
 *
 * The local build solved a whole SBC set in one pass, with refinement rounds
 * that re-solved challenges against a freed pool. That costs ~19ms of CPU,
 * which does not fit the 10ms per-request budget (CLAUDE.md §17), so the edge
 * build solves one challenge per request and the client walks the set.
 *
 * What carries over is the thing that actually prevents the §5 trap: solving
 * the most *constrained* challenge first, so scarce high-rated cards are
 * claimed by the squad that has no alternative rather than spent on the low
 * squad that merely found them cheap. Ordering is O(challenges x pool) and
 * costs well under a millisecond.
 *
 * What is lost is the refinement pass, which could undo a bad early commitment.
 * In practice ordering does most of the work; the difference shows up only on
 * sets where two challenges compete for the same narrow band of cards.
 */

import { requiredRating, toCountable } from './requirements'
import type { AnnotatedPlayer } from '../shared/player'
import type { Challenge } from '../shared/sbc'

/** A compact view of the pool, so ordering does not need every player row. */
export interface PoolStats {
  /** How many unprotected players exist at or above each rating. */
  countAtOrAbove: (rating: number) => number
  /** How many unprotected players match an arbitrary predicate. */
  countMatching: (predicate: (p: AnnotatedPlayer) => boolean) => number
  total: number
}

export function poolStats(players: readonly AnnotatedPlayer[]): PoolStats {
  const sortedRatings = players.map((p) => p.rating).sort((a, b) => a - b)
  return {
    total: players.length,
    countAtOrAbove(rating) {
      // Binary search for the first index at or above `rating`.
      let lo = 0
      let hi = sortedRatings.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (sortedRatings[mid]! < rating) lo = mid + 1
        else hi = mid
      }
      return sortedRatings.length - lo
    },
    countMatching: (predicate) => players.filter(predicate).length,
  }
}

/**
 * How hard a challenge is to fill from this pool. Higher goes first.
 *
 * Rating dominates, because high-rated cards are the genuinely scarce resource.
 * Side constraints add in proportion to how few pool players satisfy them — a
 * "5 from the Bundesliga" clause is only difficult if you are short of
 * Bundesliga cards, and scoring by real scarcity rather than by the mere
 * existence of a clause is what makes the ordering track reality.
 */
export function difficultyScore(challenge: Challenge, stats: PoolStats): number {
  const rating = requiredRating(challenge.requirements) ?? 0
  let score = rating * 100

  // Squads needing cards this club barely has are the ones to satisfy first.
  if (rating > 0) {
    const availableAtRating = stats.countAtOrAbove(rating)
    score += availableAtRating === 0 ? 1000 : Math.min(1000, (11 / availableAtRating) * 500)
  }

  for (const req of challenge.requirements) {
    const countable = toCountable(req)
    if (!countable || countable.comparator === 'max') continue
    const available = stats.countMatching(countable.matches)
    const scarcity = available === 0 ? 1000 : Math.min(1000, (countable.target / available) * 500)
    score += scarcity
  }

  // An unparsed requirement makes a challenge risky to defer — we cannot tell
  // what it will consume.
  if (challenge.requirements.some((r) => r.kind === 'unparsed')) score += 50

  return score
}

/** Challenges hardest-first, which is the order the client should solve them. */
export function solveOrder(
  challenges: readonly Challenge[],
  stats: PoolStats,
): Challenge[] {
  return [...challenges]
    .filter((c) => !c.completed)
    .sort((a, b) => difficultyScore(b, stats) - difficultyScore(a, stats))
}
