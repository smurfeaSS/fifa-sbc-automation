/**
 * Club analytics — automation.md §11, §12, §16, §18.
 *
 * Read-only summaries over an annotated club, for the dashboard tiles and the
 * Duplicates / Fodder pages.
 */

import { protectionValue, marketValue, untradeableValue } from './solver/value.js';
import type { AnnotatedPlayer } from './shared/types/player.js';

export interface FodderBand {
  rating: number;
  total: number;
  tradeable: number;
  untradeable: number;
  duplicate: number;
  protected: number;
  estimatedValue: number;
}

/** Rating distribution of usable fodder, high to low (§12). */
export function fodderOverview(players: readonly AnnotatedPlayer[], minRating = 80): FodderBand[] {
  const bands = new Map<number, FodderBand>();

  for (const p of players) {
    if (p.rating < minRating) continue;
    let band = bands.get(p.rating);
    if (!band) {
      band = {
        rating: p.rating, total: 0, tradeable: 0, untradeable: 0,
        duplicate: 0, protected: 0, estimatedValue: 0,
      };
      bands.set(p.rating, band);
    }
    band.total++;
    if (p.tradeability === 'tradeable') band.tradeable++;
    else band.untradeable++;
    if (p.isDuplicate) band.duplicate++;
    if (p.isProtected) band.protected++;
    band.estimatedValue += protectionValue(p);
  }

  return [...bands.values()].sort((a, b) => b.rating - a.rating);
}

export interface DuplicateGroup {
  assetId: string;
  name: string;
  rating: number;
  copies: AnnotatedPlayer[];
  /** Copies that are not protected and so are usable as fodder. */
  spare: AnnotatedPlayer[];
  estimatedSpareValue: number;
}

/**
 * Duplicate storage (§11).
 *
 * "Spare" excludes one copy per group — keeping a copy of a card you own is
 * almost always the right default, so the tool never suggests burning your last
 * one just because you happen to hold two.
 */
export function duplicateGroups(players: readonly AnnotatedPlayer[]): DuplicateGroup[] {
  const byAsset = new Map<string, AnnotatedPlayer[]>();
  for (const p of players) {
    if (!p.isDuplicate) continue;
    const list = byAsset.get(p.assetId);
    if (list) list.push(p);
    else byAsset.set(p.assetId, [p]);
  }

  const groups: DuplicateGroup[] = [];
  for (const [assetId, copies] of byAsset) {
    copies.sort((a, b) => a.sacrificeCost - b.sacrificeCost);
    const first = copies[0]!;
    // Hold one back, then only the unprotected ones count as spare.
    const spare = copies.slice(0, -1).filter((p) => !p.isProtected);
    groups.push({
      assetId,
      name: first.name,
      rating: first.rating,
      copies,
      spare,
      estimatedSpareValue: spare.reduce((a, p) => a + protectionValue(p), 0),
    });
  }

  return groups.sort((a, b) => b.rating - a.rating);
}

export interface ClubSummary {
  totalPlayers: number;
  estimatedValue: number;
  tradeableValue: number;
  untradeableValue: number;
  protectedCount: number;
  duplicateCount: number;
  duplicateFodderCount: number;
  highRatedFodderCount: number;
  usableCount: number;
  byCardType: Record<string, number>;
}

export function clubSummary(players: readonly AnnotatedPlayer[]): ClubSummary {
  const byCardType: Record<string, number> = {};
  let estimatedValue = 0;
  let tradeable = 0;
  let untradeable = 0;
  let protectedCount = 0;
  let duplicates = 0;
  let usable = 0;
  let highRatedFodder = 0;

  for (const p of players) {
    byCardType[p.cardType] = (byCardType[p.cardType] ?? 0) + 1;
    estimatedValue += protectionValue(p);
    tradeable += marketValue(p);
    untradeable += untradeableValue(p);
    if (p.isProtected) protectedCount++;
    else usable++;
    if (p.isDuplicate) duplicates++;
    if (!p.isProtected && p.rating >= 84) highRatedFodder++;
  }

  const dupGroups = duplicateGroups(players);

  return {
    totalPlayers: players.length,
    estimatedValue,
    tradeableValue: tradeable,
    untradeableValue: untradeable,
    protectedCount,
    duplicateCount: duplicates,
    duplicateFodderCount: dupGroups.reduce((a, g) => a + g.spare.length, 0),
    highRatedFodderCount: highRatedFodder,
    usableCount: usable,
    byCardType,
  };
}

export interface SearchFilters {
  name?: string;
  minRating?: number;
  maxRating?: number;
  league?: string;
  club?: string;
  nation?: string;
  cardType?: string;
  tradeability?: 'tradeable' | 'untradeable';
  duplicatesOnly?: boolean;
  protectedOnly?: boolean;
  unprotectedOnly?: boolean;
  minValue?: number;
  maxValue?: number;
}

/** Player search (§18). */
export function searchPlayers(
  players: readonly AnnotatedPlayer[],
  f: SearchFilters,
): AnnotatedPlayer[] {
  const needle = f.name?.toLowerCase();
  return players.filter((p) => {
    if (needle && !p.name.toLowerCase().includes(needle)) return false;
    if (f.minRating !== undefined && p.rating < f.minRating) return false;
    if (f.maxRating !== undefined && p.rating > f.maxRating) return false;
    if (f.league && p.leagueName?.toLowerCase() !== f.league.toLowerCase()) return false;
    if (f.club && p.clubName?.toLowerCase() !== f.club.toLowerCase()) return false;
    if (f.nation && p.nationName?.toLowerCase() !== f.nation.toLowerCase()) return false;
    if (f.cardType && p.cardType !== f.cardType) return false;
    if (f.tradeability && p.tradeability !== f.tradeability) return false;
    if (f.duplicatesOnly && !p.isDuplicate) return false;
    if (f.protectedOnly && !p.isProtected) return false;
    if (f.unprotectedOnly && p.isProtected) return false;
    const v = protectionValue(p);
    if (f.minValue !== undefined && v < f.minValue) return false;
    if (f.maxValue !== undefined && v > f.maxValue) return false;
    return true;
  });
}
