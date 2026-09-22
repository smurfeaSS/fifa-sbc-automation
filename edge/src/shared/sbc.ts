/**
 * SBC domain model.
 *
 * An SBC "set" (what the game shows as one tile, e.g. "Marquee Matchups") holds
 * one or more challenges. The global optimizer in src/solver/globalAllocator.ts
 * plans across every challenge in a set at once, which is the whole point of
 * automation.md §5.
 */

import type { CardType } from './player';

/** Comparison used by a numeric requirement. */
export type Comparator = 'min' | 'max' | 'exact';

/**
 * A single structured constraint on a squad.
 *
 * Every requirement kind carries enough information to be checked against a
 * candidate squad without re-parsing text. Adding a new kind means adding a
 * case to `checkRequirement` in src/solver/requirements.ts — the compiler will
 * point at it.
 */
export type Requirement =
  | { kind: 'squad-rating'; comparator: Comparator; value: number }
  | { kind: 'team-chemistry'; comparator: Comparator; value: number }
  | { kind: 'player-count'; value: number }
  | { kind: 'min-rating'; comparator: Comparator; value: number; count: number }
  | { kind: 'rare-count'; comparator: Comparator; value: number }
  | { kind: 'card-type-count'; cardType: CardType; comparator: Comparator; value: number }
  | { kind: 'nation-count'; nationId?: number; nationName?: string; comparator: Comparator; value: number }
  | { kind: 'league-count'; leagueId?: number; leagueName?: string; comparator: Comparator; value: number }
  | { kind: 'club-count'; clubId?: number; clubName?: string; comparator: Comparator; value: number }
  | { kind: 'distinct-nations'; comparator: Comparator; value: number }
  | { kind: 'distinct-leagues'; comparator: Comparator; value: number }
  | { kind: 'distinct-clubs'; comparator: Comparator; value: number }
  | { kind: 'same-league'; value: number }
  | { kind: 'same-nation'; value: number }
  | { kind: 'same-club'; value: number }
  | { kind: 'item-score'; comparator: Comparator; value: number }
  | { kind: 'specific-player'; assetId: string; name?: string }
  /**
   * Escape hatch for requirement text the parser could not map. Carries the raw
   * text so the UI can show it and the user can resolve it by hand. A squad
   * containing an unparsed requirement is never reported as SAFE.
   */
  | { kind: 'unparsed'; text: string };

export interface Reward {
  /** Human-readable description, e.g. "Rare Players Pack". */
  description: string;
  /** Estimated coin value of the reward, when known. */
  estimatedValue?: number;
  /** True for untradeable pack rewards. */
  untradeable?: boolean;
}

/** One challenge (one squad to submit) inside an SBC set. */
export interface Challenge {
  id: string;
  name: string;
  requirements: Requirement[];
  reward?: Reward;
  /** Formation the challenge forces, if any. Affects chemistry. */
  formation?: string;
  /** True when the user has already completed this challenge. */
  completed?: boolean;
  /** Times this repeatable challenge may still be completed. */
  repeatsRemaining?: number;
}

/** A full SBC set as shown in-game. */
export interface SbcSet {
  id: string;
  name: string;
  /** e.g. "Players", "Foundations", "Icons", "Upgrades". */
  category?: string;
  description?: string;
  challenges: Challenge[];
  /** ISO date the set expires, when known. */
  expiresAt?: string;
  /** True when the whole set may be completed more than once. */
  repeatable?: boolean;
  reward?: Reward;

  /** Where this definition came from, for provenance in the UI. */
  source: {
    kind: 'local' | 'scraped' | 'manual';
    /** Site or file the definition was read from. */
    origin?: string;
    fetchedAt?: string;
    /**
     * Parser confidence 0..1. Scraped sets with unparsed requirements score
     * low; the dashboard warns before solving against a low-confidence set.
     */
    confidence: number;
  };
}
