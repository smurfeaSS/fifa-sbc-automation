/**
 * Chemistry engine, FC24-style model.
 *
 * Each player earns 0-3 chemistry from how many squadmates share their club,
 * league and nation, and only while played in a position they can play. Team
 * chemistry is the sum, capped at 33.
 *
 * !! CALIBRATION NOTE !!
 * The thresholds below are the FC24/FC25 values. EA adjusts them between
 * titles, and Icon/Hero bonuses in particular have moved. They are isolated as
 * exported constants so they can be corrected without touching the logic.
 */

import { MAX_TEAM_CHEMISTRY } from '../shared/constants';
import type { Player } from '../shared/player';

/** [count needed, chemistry points] pairs, highest first. */
export const CLUB_THRESHOLDS: ReadonlyArray<readonly [number, number]> = [[7, 3], [4, 2], [2, 1]];
export const LEAGUE_THRESHOLDS: ReadonlyArray<readonly [number, number]> = [[8, 3], [5, 2], [3, 1]];
export const NATION_THRESHOLDS: ReadonlyArray<readonly [number, number]> = [[8, 3], [5, 2], [2, 1]];

/** A player placed into a formation slot. */
export interface SquadSlot {
  player: Player;
  /** The formation position this slot demands, e.g. "CB". */
  slotPosition: string;
}

function pointsFor(count: number, thresholds: ReadonlyArray<readonly [number, number]>): number {
  for (const [need, pts] of thresholds) {
    if (count >= need) return pts;
  }
  return 0;
}

/** Whether a player is in a position they can play without a modifier. */
export function isInPosition(slot: SquadSlot): boolean {
  const p = slot.player.position;
  return p.primary === slot.slotPosition || p.alternates.includes(slot.slotPosition);
}

export interface ChemistryResult {
  /** Team chemistry, 0..33. */
  total: number;
  /** Per-player chemistry, keyed by item id. */
  perPlayer: Map<string, number>;
  /** Item ids of players contributing nothing because they are out of position. */
  outOfPosition: string[];
}

/**
 * Compute chemistry for a slotted squad.
 *
 * Out-of-position players score zero and do not count toward anyone else's
 * club/league/nation totals — they are effectively absent for chemistry.
 * Icons contribute to every nation count and Heroes to their league, which is
 * why they are counted separately below.
 */
export function computeChemistry(slots: readonly SquadSlot[]): ChemistryResult {
  const contributing = slots.filter(isInPosition);
  const outOfPosition = slots.filter((s) => !isInPosition(s)).map((s) => s.player.id);

  const clubCounts = new Map<number, number>();
  const leagueCounts = new Map<number, number>();
  const nationCounts = new Map<number, number>();
  let iconCount = 0;
  const heroLeagues = new Map<number, number>();

  for (const { player } of contributing) {
    clubCounts.set(player.clubId, (clubCounts.get(player.clubId) ?? 0) + 1);
    leagueCounts.set(player.leagueId, (leagueCounts.get(player.leagueId) ?? 0) + 1);
    nationCounts.set(player.nationId, (nationCounts.get(player.nationId) ?? 0) + 1);
    if (player.cardType === 'icon') iconCount++;
    if (player.cardType === 'hero') {
      heroLeagues.set(player.leagueId, (heroLeagues.get(player.leagueId) ?? 0) + 1);
    }
  }

  const perPlayer = new Map<string, number>();
  for (const id of outOfPosition) perPlayer.set(id, 0);

  let total = 0;
  for (const { player } of contributing) {
    const club = pointsFor(clubCounts.get(player.clubId) ?? 0, CLUB_THRESHOLDS);

    // Icons boost every nation, Heroes boost their own league.
    const leagueCount = (leagueCounts.get(player.leagueId) ?? 0) + (heroLeagues.get(player.leagueId) ?? 0);
    const league = pointsFor(leagueCount, LEAGUE_THRESHOLDS);

    const nationCount = (nationCounts.get(player.nationId) ?? 0) + iconCount;
    const nation = pointsFor(nationCount, NATION_THRESHOLDS);

    // Icons and Heroes sit at full chemistry whenever they are in position.
    const chem =
      player.cardType === 'icon' || player.cardType === 'hero'
        ? 3
        : Math.min(3, club + league + nation);

    perPlayer.set(player.id, chem);
    total += chem;
  }

  return { total: Math.min(total, MAX_TEAM_CHEMISTRY), perPlayer, outOfPosition };
}

/**
 * Upper bound on chemistry reachable from a set of players.
 *
 * Used to reject a candidate squad early when a chemistry requirement cannot
 * possibly be met, without searching every slot assignment. Optimistic: assumes
 * every player can be placed in position.
 */
export function chemistryUpperBound(players: readonly Player[]): number {
  return Math.min(players.length * 3, MAX_TEAM_CHEMISTRY);
}
