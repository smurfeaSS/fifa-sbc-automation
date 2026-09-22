/**
 * Squad rating engine.
 *
 * FUT does not use a plain average. It computes the mean, then adds back the
 * amount by which above-average players exceed it, which is why one very high
 * card lifts a squad more than averaging suggests. Concretely:
 *
 *     S = sum of the 11 ratings
 *     A = S / 11
 *     E = sum over players of max(0, rating - A)
 *     squad rating = floor((S + E) / 11)
 *
 * !! CALIBRATION NOTE !!
 * This formula reproduces the behaviour the game is known for, but EA has never
 * published it and the rounding step in particular has varied by title. Before
 * relying on this for real submissions, run `npm run cli -- verify-rating` and
 * compare a handful of squads against what the Web App shows. Everything about
 * the rule lives in this file precisely so recalibration is a one-file change.
 */

import { SQUAD_SIZE } from '../shared/constants.js';

/** Rounding applied to the final squad rating. */
export type RatingRounding = 'floor' | 'round';

export interface RatingOptions {
  rounding?: RatingRounding;
  /** Squad size. Defaults to 11; some special challenges differ. */
  size?: number;
}

/**
 * The squad rating before rounding, e.g. 84.08.
 * This is the number the preview shows, because the fractional part is exactly
 * the "rating waste" the user cares about (§6).
 */
export function exactSquadRating(ratings: readonly number[]): number {
  if (ratings.length === 0) return 0;
  const n = ratings.length;
  const sum = ratings.reduce((a, b) => a + b, 0);
  const average = sum / n;
  let excess = 0;
  for (const r of ratings) {
    if (r > average) excess += r - average;
  }
  return (sum + excess) / n;
}

/** The squad rating as the game displays it. */
export function squadRating(ratings: readonly number[], opts: RatingOptions = {}): number {
  const exact = exactSquadRating(ratings);
  return opts.rounding === 'round' ? Math.round(exact) : Math.floor(exact);
}

/**
 * How much rating is being thrown away.
 *
 * A squad that computes to 84.08 against an 84 requirement wastes 0.08 and is
 * near-perfect. One that computes to 86.2 against the same requirement wastes
 * 2.2 and is burning fodder for nothing — exactly the case §6 calls out.
 */
export function ratingWaste(ratings: readonly number[], required: number): number {
  return Math.max(0, exactSquadRating(ratings) - required);
}

/** Whether these ratings satisfy a minimum squad rating. */
export function meetsRating(
  ratings: readonly number[],
  required: number,
  opts: RatingOptions = {},
): boolean {
  return squadRating(ratings, opts) >= required;
}

/**
 * Lowest total rating sum that can reach `required` for a squad of `size`.
 *
 * Used to prune the search: any partial squad whose best possible completion
 * cannot reach this sum is abandoned. With all ratings equal, E is zero and the
 * rating is exactly the mean, so `required * size` is the floor — any real
 * squad needs at least this much, because excess only helps once some player is
 * above the mean, and that requires the sum to already be there or above.
 */
export function minimumRatingSum(required: number, size: number = SQUAD_SIZE): number {
  return required * size;
}

/**
 * Upper bound on the squad rating achievable by extending `current` with
 * `remaining` more players, none rated above `maxAvailableRating`.
 *
 * Admissible (never underestimates), so branch-and-bound using it stays exact.
 */
export function ratingUpperBound(
  current: readonly number[],
  remaining: number,
  maxAvailableRating: number,
): number {
  if (remaining <= 0) return exactSquadRating(current);
  const best = [...current, ...Array<number>(remaining).fill(maxAvailableRating)];
  return exactSquadRating(best);
}
