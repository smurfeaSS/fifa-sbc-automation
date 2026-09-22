/**
 * Mapping tables between EA's raw export values and our domain model.
 *
 * IMPORTANT: these ids shift between game versions and mid-cycle content drops.
 * They are isolated here so that recalibrating against a real FC 27 export is a
 * single-file change. `src/ingest/normalizers.ts` is the only consumer.
 */

import type { CardType, PositionGroup } from './player';

/**
 * EA `rareflag` / rarity id to card family.
 *
 * Historically 0 = common, 1 = rare, 3 = TOTW, 12 = icon, and promo rarities
 * occupy a wide, content-dependent range. Anything unmapped falls through to
 * `promo` when the id is high, because treating an unknown special card as a
 * protected promo fails safe — the cost of wrongly protecting a card is a
 * slightly worse squad, the cost of wrongly burning one is unrecoverable.
 */
export const RARITY_ID_TO_CARD_TYPE: Readonly<Record<number, CardType>> = Object.freeze({
  0: 'common',
  1: 'rare',
  3: 'totw',
  12: 'icon',
  // Hero rarity ids have varied; the ingest layer also matches on name lists.
  92: 'hero',
});

/**
 * Rarity ids at or above this are assumed to be special/promo content when not
 * explicitly mapped above. Fails safe toward protection.
 */
export const UNKNOWN_SPECIAL_RARITY_FLOOR = 2;

export const POSITION_GROUPS: Readonly<Record<string, PositionGroup>> = Object.freeze({
  GK: 'GK',
  CB: 'DEF', LB: 'DEF', RB: 'DEF', LWB: 'DEF', RWB: 'DEF',
  CDM: 'MID', CM: 'MID', CAM: 'MID', LM: 'MID', RM: 'MID',
  LW: 'ATT', RW: 'ATT', CF: 'ATT', ST: 'ATT', LF: 'ATT', RF: 'ATT',
});

/** Card families the protection engine treats as inherently precious. */
export const INHERENTLY_SPECIAL: ReadonlySet<CardType> = new Set<CardType>([
  'icon',
  'hero',
  'promo',
  'evolution',
]);

/**
 * Fallback coin values by rating for tradeable cards with no market data.
 *
 * These are order-of-magnitude anchors for the discard/fodder curve, not real
 * prices. They exist so the solver can rank cards sensibly before any market
 * data is attached, and are always marked `confidence: 0.3` so the UI can say
 * so. Interpolated between anchors by `estimateValue`.
 */
export const RATING_VALUE_ANCHORS: ReadonlyArray<readonly [rating: number, coins: number]> =
  Object.freeze([
    [0, 200], [75, 300], [80, 600], [82, 900], [83, 1300],
    [84, 2200], [85, 4000], [86, 9000], [87, 18000], [88, 35000],
    [89, 70000], [90, 150000], [91, 300000], [99, 1500000],
  ] as const);

/** Quick-sell / discard value, the floor under any untradeable card. */
export const DISCARD_VALUE_ANCHORS: ReadonlyArray<readonly [rating: number, coins: number]> =
  Object.freeze([
    [0, 100], [75, 200], [80, 400], [84, 700], [86, 1000], [99, 2000],
  ] as const);

/** Squad size for every standard SBC challenge. */
export const SQUAD_SIZE = 11;

/** Chemistry ceiling under the FC24+ model (3 per player x 11). */
export const MAX_TEAM_CHEMISTRY = 33;
