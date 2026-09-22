/**
 * Value engine.
 *
 * Answers "what does it cost me to lose this card?", which is the quantity the
 * whole optimizer minimises. Two distinct numbers matter and must not be
 * conflated (automation.md §7, §13):
 *
 *   - market value: what a tradeable card would fetch. Real, recoverable coins.
 *   - replacement value: what an untradeable card is worth to you. Not coins,
 *     but not zero either — burning an untradeable 86 means buying an 86 later.
 */

import {
  RATING_VALUE_ANCHORS,
  DISCARD_VALUE_ANCHORS,
  INHERENTLY_SPECIAL,
} from '../shared/constants';
import type { Player, ValueEstimate } from '../shared/player';

/** Piecewise-linear interpolation over an anchor table. */
function interpolate(
  anchors: ReadonlyArray<readonly [number, number]>,
  rating: number,
): number {
  const first = anchors[0]!;
  if (rating <= first[0]) return first[1];

  for (let i = 1; i < anchors.length; i++) {
    const [hiR, hiV] = anchors[i]!;
    if (rating <= hiR) {
      const [loR, loV] = anchors[i - 1]!;
      const span = hiR - loR;
      if (span === 0) return hiV;
      const t = (rating - loR) / span;
      // Prices scale geometrically with rating, so interpolate in log space —
      // linear interpolation badly underprices the middle of each band.
      return Math.round(loV * Math.pow(hiV / loV, t));
    }
  }
  return anchors[anchors.length - 1]![1];
}

/** Multiplier applied to the base rating curve for special card families. */
function cardTypeMultiplier(player: Player): number {
  switch (player.cardType) {
    case 'icon': return 12;
    case 'hero': return 6;
    case 'promo': return 3;
    case 'totw': return 1.6;
    case 'evolution': return 2;
    case 'rare': return 1;
    default: return 0.85;
  }
}

/**
 * Estimate what this card is worth.
 *
 * Confidence is reported honestly and consumed downstream: the protection
 * engine widens its threshold for low-confidence estimates, so a card we are
 * unsure about is more likely to be protected than burned.
 */
export function estimateValue(player: Player): ValueEstimate {
  const asOf = new Date().toISOString();

  // A user-supplied value always wins.
  if (player.value?.source === 'user') return player.value;

  // A recent market price is the best signal we have.
  if (player.value?.source === 'market') return player.value;

  if (player.tradeability === 'untradeable') {
    // Replacement cost: what you would pay to get this card back. Floored at
    // discard value so even junk untradeables carry a small nonzero cost,
    // which is what makes the solver prefer fodder over good cards.
    const replacement = interpolate(RATING_VALUE_ANCHORS, player.rating) * cardTypeMultiplier(player);
    const floor = interpolate(DISCARD_VALUE_ANCHORS, player.rating);
    return {
      coins: Math.max(Math.round(replacement), floor),
      source: 'untradeable',
      asOf,
      confidence: INHERENTLY_SPECIAL.has(player.cardType) ? 0.25 : 0.45,
    };
  }

  const base = interpolate(RATING_VALUE_ANCHORS, player.rating) * cardTypeMultiplier(player);
  return {
    coins: Math.round(base),
    source: 'heuristic',
    asOf,
    // Special cards have wildly variable prices the rating curve cannot
    // capture, so we say so rather than pretending to know.
    confidence: INHERENTLY_SPECIAL.has(player.cardType) ? 0.15 : 0.3,
  };
}

/** Coins actually recoverable if this card were sold. Zero for untradeables. */
export function marketValue(player: Player): number {
  if (player.tradeability === 'untradeable') return 0;
  return player.value?.coins ?? estimateValue(player).coins;
}

/** Notional worth of an untradeable. Zero for tradeables, to avoid double counting. */
export function untradeableValue(player: Player): number {
  if (player.tradeability === 'tradeable') return 0;
  return player.value?.coins ?? estimateValue(player).coins;
}

/**
 * Value used for protection decisions, adjusted upward when confidence is low.
 *
 * A card we estimate at 12,000 with 0.15 confidence could easily be worth far
 * more. Inflating the uncertain ones means the protection threshold catches
 * them, which is the direction we want to be wrong in.
 */
export function protectionValue(player: Player): number {
  const v = player.value ?? estimateValue(player);
  const uncertainty = 1 - v.confidence;
  return Math.round(v.coins * (1 + uncertainty));
}
