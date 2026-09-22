/**
 * Protection engine — automation.md §2, §10, §20.
 *
 * This is the part of the system that exists to stop a bad outcome, so it is
 * written to fail safe throughout: when a rule cannot be evaluated, it protects.
 * Every protection carries a human-readable reason, because §26 requires the
 * user to understand *why* a card was withheld, and §8 requires warnings to
 * name the cause.
 *
 * Manual overrides are the one way past an automatic rule, and they are
 * deliberately per-item and explicit — there is no "unprotect everything".
 */

import { protectionValue } from './value.js';
import type { AnnotatedPlayer, Player } from '../shared/types/player.js';
import type { ProtectionSettings, Settings, SolverWeights } from '../shared/types/club.js';

/** Cost assigned to a protected card outside strict mode. */
export const PROTECTED_PENALTY_SOFT = 10_000_000;

export const DEFAULT_PROTECTION: ProtectionSettings = {
  valueThreshold: 15_000,
  protectActiveSquad: true,
  protectAllSquads: true,
  protectEvolutions: true,
  protectIcons: true,
  protectHeroes: true,
  protectPromos: true,
  promoValueThreshold: 8_000,
  protectFavourites: true,
  protectSingletonRares: false,
  protectAboveRating: 0,
  protectUsedInSquadsAtLeast: 0,
  manualLocks: [],
  manualOverrides: [],
};

export const DEFAULT_WEIGHTS: SolverWeights = {
  tradeableValueLoss: 1.0,
  // Untradeables are the currency we *want* spent, so their loss is discounted
  // heavily. Not to zero — an untradeable 88 is still worth more than an 84.
  untradeableValueLoss: 0.25,
  // Each point of rating overshoot is charged as coins. Tuned so that the
  // solver trades roughly one 84-rated card's value per whole rating point,
  // which matches how wasteful overshoot actually is.
  ratingWaste: 2_000,
  protectedPenalty: PROTECTED_PENALTY_SOFT,
  rareCardPenalty: 500,
  purchaseCost: 1.0,
  // Subtracted, not added: using a duplicate is actively good.
  duplicateBonus: 1_200,
  firstOwnerPenalty: 300,
};

export const DEFAULT_SETTINGS: Settings = {
  protection: DEFAULT_PROTECTION,
  strictProtection: true,
  solverMode: 'balanced',
  weights: DEFAULT_WEIGHTS,
  searchBudgetMs: 4_000,
  sbcSources: {
    scraperEnabled: false,
    scraperBaseUrl: '',
    cacheTtlMinutes: 60,
  },
};

/**
 * Evaluate every protection rule against one player.
 * Returns all matching reasons, not just the first — the UI shows them all.
 */
export function protectionReasons(player: Player, s: ProtectionSettings): string[] {
  // An explicit override clears automatic rules, but never a manual lock:
  // the user cannot accidentally override their own deliberate lock.
  if (s.manualLocks.includes(player.id)) {
    return ['Manually locked'];
  }
  if (s.manualOverrides.includes(player.id)) return [];

  const reasons: string[] = [];

  if (s.protectIcons && player.cardType === 'icon') reasons.push('Icon');
  if (s.protectHeroes && player.cardType === 'hero') reasons.push('Hero');
  if (s.protectEvolutions && (player.evolution.isEvolved || player.cardType === 'evolution')) {
    reasons.push('Evolution');
  }

  if (s.protectActiveSquad && player.inActiveSquad) reasons.push('In active squad');
  if (s.protectAllSquads && player.squadUsage.length > 0 && !player.inActiveSquad) {
    reasons.push(`In saved squad${player.squadUsage.length > 1 ? 's' : ''}`);
  }
  if (s.protectUsedInSquadsAtLeast > 0 && player.squadUsage.length >= s.protectUsedInSquadsAtLeast) {
    reasons.push(`Used in ${player.squadUsage.length} squads`);
  }

  if (s.protectFavourites && player.isFavourite) reasons.push('Favourite');

  const value = protectionValue(player);
  if (s.protectPromos && player.cardType === 'promo') {
    // Promos get their own, usually lower, threshold — they are the category
    // most likely to be worth far more than the rating curve suggests.
    if (value >= s.promoValueThreshold) {
      reasons.push(`Promo card worth ~${value.toLocaleString()} coins`);
    } else {
      reasons.push('Promo card');
    }
  }
  if (player.tradeability === 'tradeable' && value >= s.valueThreshold) {
    reasons.push(`Tradeable, worth ~${value.toLocaleString()} coins`);
  }

  if (s.protectAboveRating > 0 && player.rating >= s.protectAboveRating) {
    reasons.push(`Rated ${player.rating}, at or above the ${s.protectAboveRating} cutoff`);
  }

  if (s.protectSingletonRares && !player.isDuplicate && player.cardType !== 'common') {
    reasons.push('Only copy owned');
  }

  // Cards whose type we could not identify are not auto-protected by the rules
  // above, but they are flagged so the UI can surface them (see §8). We do not
  // protect them outright — that would withhold a lot of ordinary fodder.
  return reasons;
}

/**
 * Usage priority from automation.md §3. Lower tier is consumed first.
 *
 *   1  duplicate untradeable
 *   2  low-value untradeable
 *   3  untradeable fodder
 *   4  cheap duplicate tradeable
 *   5  cheap tradeable fodder
 *   6  higher-rated fodder, only when necessary
 */
export function priorityTier(player: Player): number {
  const value = protectionValue(player);
  const untradeable = player.tradeability === 'untradeable';
  const cheap = value < 2_000;

  if (untradeable && player.isDuplicate) return 1;
  if (untradeable && cheap) return 2;
  if (untradeable) return 3;
  if (player.isDuplicate && cheap) return 4;
  if (cheap) return 5;
  return 6;
}

/**
 * Cost of consuming this card, in coins-equivalent.
 *
 * This is the per-player term of the §25 objective. The solver sums it over a
 * squad and adds the rating-waste term.
 */
export function sacrificeCost(
  player: Player,
  isProtected: boolean,
  settings: Settings,
): number {
  if (isProtected) {
    // Under strict protection a protected card is not merely expensive, it is
    // unusable — Infinity makes that structural rather than a matter of the
    // weights happening to be large enough. §20.
    return settings.strictProtection ? Infinity : settings.weights.protectedPenalty;
  }

  const w = settings.weights;
  const value = player.value?.coins ?? protectionValue(player);

  let cost =
    player.tradeability === 'tradeable'
      ? value * w.tradeableValueLoss
      : value * w.untradeableValueLoss;

  if (player.isDuplicate) cost -= w.duplicateBonus;
  if (player.isFirstOwner) cost += w.firstOwnerPenalty;
  if (player.cardType !== 'common' && player.cardType !== 'rare') cost += w.rareCardPenalty;

  // Mode adjustments (§19) layer on top of the base weights rather than
  // replacing them, so a mode never silently disables protection.
  switch (settings.solverMode) {
    case 'duplicate-cleanup':
      if (player.isDuplicate) cost -= w.duplicateBonus * 2;
      break;
    case 'untradeables-only':
      // Not a preference — tradeables are excluded outright in this mode.
      if (player.tradeability === 'tradeable') return Infinity;
      break;
    case 'maximum-savings':
      if (player.tradeability === 'tradeable') cost *= 1.5;
      break;
    case 'rating-efficient':
    case 'balanced':
      break;
  }

  // Never let bonuses drive cost negative — a free card must not look like a
  // card the solver is paid to use, or it will pad squads with junk.
  return Math.max(cost, 1);
}

/** Annotate a whole club with protection state, priority and cost. */
export function annotate(players: Player[], settings: Settings): AnnotatedPlayer[] {
  return players.map((p) => {
    const reasons = protectionReasons(p, settings.protection);
    const isProtected = reasons.length > 0;
    return {
      ...p,
      isProtected,
      protectionReasons: reasons,
      sacrificeCost: sacrificeCost(p, isProtected, settings),
      priorityTier: priorityTier(p),
    };
  });
}

/** Players the solver may actually use. */
export function usablePool(annotated: AnnotatedPlayer[]): AnnotatedPlayer[] {
  return annotated.filter((p) => Number.isFinite(p.sacrificeCost));
}
