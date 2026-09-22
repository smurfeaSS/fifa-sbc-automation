/**
 * Player domain model.
 *
 * This is the normalized shape every part of the system works with. Raw club
 * exports (see src/ingest) are messy and version-specific; everything downstream
 * of the importer sees only this.
 */

/** Tradeability of a club item. Drives most of the value logic. */
export type Tradeability = 'tradeable' | 'untradeable';

/**
 * Broad card families we care about for protection and value decisions.
 *
 * This is deliberately coarser than EA's internal rarity ids — the solver only
 * needs to know "is this a thing I must never burn" and "roughly how special is
 * it". The raw id is kept on the player as `rawRarityId` for debugging.
 */
export type CardType =
  | 'common'
  | 'rare'
  | 'totw'
  | 'icon'
  | 'hero'
  | 'promo'
  | 'evolution'
  | 'sbc-reward'
  | 'objective-reward'
  | 'unknown';

/** Position groups, used for chemistry and for formation slotting. */
export type PositionGroup = 'GK' | 'DEF' | 'MID' | 'ATT';

export interface Position {
  /** Primary in-game position, e.g. "ST", "CB". */
  primary: string;
  /** Alternate positions the card can play without a position modifier. */
  alternates: string[];
  group: PositionGroup;
}

/** Where a value estimate came from, so the UI can show confidence. */
export type ValueSource =
  | 'market'        // live or cached market price
  | 'user'          // manually entered by the user
  | 'heuristic'     // derived from rating/rarity tables
  | 'untradeable';  // no market value; notional replacement cost

export interface ValueEstimate {
  /** Estimated coin value. For untradeables this is notional replacement cost. */
  coins: number;
  source: ValueSource;
  /** ISO timestamp of when this estimate was produced. */
  asOf: string;
  /**
   * 0..1 confidence. Heuristic estimates on unusual cards score low, and the
   * solver widens its safety margin when acting on low-confidence values.
   */
  confidence: number;
}

/**
 * A single club item.
 *
 * `id` is EA's item id and is the stable identity across exports — it is unique
 * per card instance, so two copies of the same player have different ids. Use
 * `assetId` to group duplicates of the same footballer.
 */
export interface Player {
  /** EA item id. Unique per physical card in the club. */
  id: string;
  /** EA asset id. Shared by every card of the same footballer. */
  assetId: string;
  /** Resource id, encodes the specific card version. */
  resourceId?: string;

  name: string;
  rating: number;
  position: Position;

  nationId: number;
  nationName?: string;
  leagueId: number;
  leagueName?: string;
  clubId: number;
  clubName?: string;

  cardType: CardType;
  /** EA's raw rarity id, preserved for debugging the card-type mapping. */
  rawRarityId?: number;

  tradeability: Tradeability;
  /** Set while the item is untradeable-until a date (loans, some rewards). */
  untradeableUntil?: string;

  /** True when the club holds more than one card with this assetId. */
  isDuplicate: boolean;
  /** How many copies of this assetId the club holds, including this one. */
  duplicateCount: number;

  /** Evolution state. Evolved cards are protected by default. */
  evolution: {
    isEvolved: boolean;
    /** Evolution path id, when the export exposes it. */
    pathId?: string;
    /** Rating gained through evolution, when derivable. */
    ratingGained?: number;
  };

  /** True when the user is this card's first owner. */
  isFirstOwner: boolean;

  /** Squad ids this player currently occupies. Empty when unused. */
  squadUsage: string[];
  /** True when the player is in the currently active squad. */
  inActiveSquad: boolean;

  /** Contract games remaining, when available. */
  contracts?: number;

  value?: ValueEstimate;

  /** True when the user has explicitly locked this card in the UI. */
  manuallyLocked: boolean;
  /** True when the user has marked this card a favourite. */
  isFavourite: boolean;

  /** Free-form note the user attached to this card. */
  note?: string;
}

/** Player plus everything the protection and solver layers derive about it. */
export interface AnnotatedPlayer extends Player {
  /** True when this player must not be used. See src/solver/protection.ts. */
  isProtected: boolean;
  /** Human-readable reasons the protection engine flagged this card. */
  protectionReasons: string[];
  /**
   * Cost the solver assigns to consuming this card, in coins-equivalent.
   * Protected cards carry a very large penalty (Infinity in strict mode).
   */
  sacrificeCost: number;
  /** Usage-priority tier from automation.md §3. Lower is used first. */
  priorityTier: number;
}
