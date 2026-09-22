/** Club, squad and settings models. */

import type { Player } from './player.js';

export interface Squad {
  id: string;
  name: string;
  formation?: string;
  /** Item ids of the players in this squad. */
  playerIds: string[];
  isActive: boolean;
}

export interface Club {
  /** Stable id for this club snapshot's owner, derived from the export. */
  ownerRef?: string;
  /** ISO timestamp of when the export was taken. */
  exportedAt: string;
  /** Game version the export came from, e.g. "fc27". */
  gameVersion: string;
  players: Player[];
  squads: Squad[];
  /** Untradeable coin balance is not exported; tradeable coins when available. */
  coins?: number;
}

/** Protection rules from automation.md §2. All are user-editable. */
export interface ProtectionSettings {
  /** Protect any tradeable card estimated above this many coins. */
  valueThreshold: number;
  protectActiveSquad: boolean;
  protectAllSquads: boolean;
  protectEvolutions: boolean;
  protectIcons: boolean;
  protectHeroes: boolean;
  protectPromos: boolean;
  /** Protect promo/special cards above this value. Separate, usually lower. */
  promoValueThreshold: number;
  protectFavourites: boolean;
  /** Protect rare cards the club holds exactly one of. */
  protectSingletonRares: boolean;
  /** Protect anything at or above this rating outright. 0 disables. */
  protectAboveRating: number;
  /** Protect cards appearing in at least this many saved squads. 0 disables. */
  protectUsedInSquadsAtLeast: number;
  /** Item ids the user locked by hand. Always protected. */
  manualLocks: string[];
  /** Item ids the user explicitly unlocked, overriding every auto rule. */
  manualOverrides: string[];
}

/** Solver modes from automation.md §19. */
export type SolverMode =
  | 'maximum-savings'
  | 'duplicate-cleanup'
  | 'untradeables-only'
  | 'balanced'
  | 'rating-efficient';

/** Weights for the cost function in automation.md §25. */
export interface SolverWeights {
  tradeableValueLoss: number;
  untradeableValueLoss: number;
  ratingWaste: number;
  protectedPenalty: number;
  rareCardPenalty: number;
  purchaseCost: number;
  duplicateBonus: number;
  firstOwnerPenalty: number;
}

export interface Settings {
  protection: ProtectionSettings;
  /** automation.md §20. When true, protected players are never usable. */
  strictProtection: boolean;
  solverMode: SolverMode;
  weights: SolverWeights;
  /** Search effort. Higher finds better squads and takes longer. */
  searchBudgetMs: number;
  sbcSources: {
    /** automation.md §4 — community-site scraping, off unless enabled. */
    scraperEnabled: boolean;
    scraperBaseUrl: string;
    /** Minutes a scraped set stays cached before being refetched. */
    cacheTtlMinutes: number;
  };
}
