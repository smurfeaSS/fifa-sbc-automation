/**
 * Requirement checking.
 *
 * Two jobs: verify a finished squad, and expose the subset of requirements the
 * solver can satisfy by swapping individual players ("countable" ones). The
 * latter is what lets the repair loop in squadSolver fix a nation or rare-count
 * shortfall without disturbing the rating multiset it worked hard to find.
 */

import { squadRating, exactSquadRating } from './rating.js';
import { computeChemistry, type SquadSlot } from './chemistry.js';
import type { Player } from '../shared/types/player.js';
import type { Comparator, Requirement } from '../shared/types/sbc.js';

export interface RequirementCheck {
  requirement: Requirement;
  satisfied: boolean;
  /** Human-readable status, e.g. "84 rated, need 84" or "3 of 5 Premier League". */
  detail: string;
  /** How far short the squad falls. 0 when satisfied. Used to rank repairs. */
  shortfall: number;
}

function compare(actual: number, comparator: Comparator, target: number): boolean {
  switch (comparator) {
    case 'min': return actual >= target;
    case 'max': return actual <= target;
    case 'exact': return actual === target;
  }
}

function shortfallOf(actual: number, comparator: Comparator, target: number): number {
  switch (comparator) {
    case 'min': return Math.max(0, target - actual);
    case 'max': return Math.max(0, actual - target);
    case 'exact': return Math.abs(actual - target);
  }
}

/**
 * A requirement expressible as "count the players matching P, compare to N".
 *
 * These are the ones the repair loop can act on, because swapping one player
 * for another of the same rating changes the count without changing the squad
 * rating. Rating and chemistry requirements are deliberately excluded — they
 * are structural and handled by the search itself.
 */
export interface CountableConstraint {
  requirement: Requirement;
  matches: (p: Player) => boolean;
  comparator: Comparator;
  target: number;
  label: string;
}

const RARE_TYPES = new Set(['rare', 'totw', 'icon', 'hero', 'promo', 'evolution', 'sbc-reward']);

export function toCountable(req: Requirement): CountableConstraint | null {
  switch (req.kind) {
    case 'rare-count':
      return {
        requirement: req,
        matches: (p) => RARE_TYPES.has(p.cardType),
        comparator: req.comparator,
        target: req.value,
        label: 'rare players',
      };
    case 'card-type-count':
      return {
        requirement: req,
        matches: (p) => p.cardType === req.cardType,
        comparator: req.comparator,
        target: req.value,
        label: `${req.cardType} cards`,
      };
    case 'min-rating':
      return {
        requirement: req,
        matches: (p) => p.rating >= req.value,
        comparator: req.comparator,
        target: req.count,
        label: `players rated ${req.value}+`,
      };
    case 'nation-count':
      return {
        requirement: req,
        matches: (p) =>
          req.nationId !== undefined ? p.nationId === req.nationId : p.nationName === req.nationName,
        comparator: req.comparator,
        target: req.value,
        label: `players from ${req.nationName ?? `nation ${req.nationId}`}`,
      };
    case 'league-count':
      return {
        requirement: req,
        matches: (p) =>
          req.leagueId !== undefined ? p.leagueId === req.leagueId : p.leagueName === req.leagueName,
        comparator: req.comparator,
        target: req.value,
        label: `players from ${req.leagueName ?? `league ${req.leagueId}`}`,
      };
    case 'club-count':
      return {
        requirement: req,
        matches: (p) =>
          req.clubId !== undefined ? p.clubId === req.clubId : p.clubName === req.clubName,
        comparator: req.comparator,
        target: req.value,
        label: `players from ${req.clubName ?? `club ${req.clubId}`}`,
      };
    default:
      return null;
  }
}

/** Largest group sharing a key, for the "N from the same league" family. */
function largestGroup<K>(players: readonly Player[], key: (p: Player) => K): number {
  const counts = new Map<K, number>();
  let max = 0;
  for (const p of players) {
    const n = (counts.get(key(p)) ?? 0) + 1;
    counts.set(key(p), n);
    if (n > max) max = n;
  }
  return max;
}

function distinctCount<K>(players: readonly Player[], key: (p: Player) => K): number {
  return new Set(players.map(key)).size;
}

export interface CheckOptions {
  /** Slotted squad, required only to evaluate chemistry requirements. */
  slots?: readonly SquadSlot[];
}

/** Check one requirement against a squad. */
export function checkRequirement(
  players: readonly Player[],
  req: Requirement,
  opts: CheckOptions = {},
): RequirementCheck {
  const countable = toCountable(req);
  if (countable) {
    const actual = players.filter(countable.matches).length;
    return {
      requirement: req,
      satisfied: compare(actual, countable.comparator, countable.target),
      detail: `${actual} ${countable.label}, need ${countable.comparator} ${countable.target}`,
      shortfall: shortfallOf(actual, countable.comparator, countable.target),
    };
  }

  switch (req.kind) {
    case 'squad-rating': {
      const actual = squadRating(players.map((p) => p.rating));
      return {
        requirement: req,
        satisfied: compare(actual, req.comparator, req.value),
        detail: `rated ${actual} (${exactSquadRating(players.map((p) => p.rating)).toFixed(2)}), need ${req.comparator} ${req.value}`,
        shortfall: shortfallOf(actual, req.comparator, req.value),
      };
    }
    case 'player-count':
      return {
        requirement: req,
        satisfied: players.length === req.value,
        detail: `${players.length} players, need ${req.value}`,
        shortfall: Math.abs(players.length - req.value),
      };
    case 'team-chemistry': {
      if (!opts.slots) {
        // Without a slotted squad chemistry is unknowable. Report it unmet
        // rather than assume — a squad we cannot verify is never SAFE.
        return {
          requirement: req,
          satisfied: false,
          detail: `chemistry not evaluated (no formation assigned), need ${req.comparator} ${req.value}`,
          shortfall: req.value,
        };
      }
      const actual = computeChemistry(opts.slots).total;
      return {
        requirement: req,
        satisfied: compare(actual, req.comparator, req.value),
        detail: `${actual} chemistry, need ${req.comparator} ${req.value}`,
        shortfall: shortfallOf(actual, req.comparator, req.value),
      };
    }
    case 'distinct-nations': {
      const actual = distinctCount(players, (p) => p.nationId);
      return { requirement: req, satisfied: compare(actual, req.comparator, req.value), detail: `${actual} nations, need ${req.comparator} ${req.value}`, shortfall: shortfallOf(actual, req.comparator, req.value) };
    }
    case 'distinct-leagues': {
      const actual = distinctCount(players, (p) => p.leagueId);
      return { requirement: req, satisfied: compare(actual, req.comparator, req.value), detail: `${actual} leagues, need ${req.comparator} ${req.value}`, shortfall: shortfallOf(actual, req.comparator, req.value) };
    }
    case 'distinct-clubs': {
      const actual = distinctCount(players, (p) => p.clubId);
      return { requirement: req, satisfied: compare(actual, req.comparator, req.value), detail: `${actual} clubs, need ${req.comparator} ${req.value}`, shortfall: shortfallOf(actual, req.comparator, req.value) };
    }
    case 'same-league': {
      const actual = largestGroup(players, (p) => p.leagueId);
      return { requirement: req, satisfied: actual >= req.value, detail: `${actual} from one league, need ${req.value}`, shortfall: Math.max(0, req.value - actual) };
    }
    case 'same-nation': {
      const actual = largestGroup(players, (p) => p.nationId);
      return { requirement: req, satisfied: actual >= req.value, detail: `${actual} from one nation, need ${req.value}`, shortfall: Math.max(0, req.value - actual) };
    }
    case 'same-club': {
      const actual = largestGroup(players, (p) => p.clubId);
      return { requirement: req, satisfied: actual >= req.value, detail: `${actual} from one club, need ${req.value}`, shortfall: Math.max(0, req.value - actual) };
    }
    case 'item-score':
      // Item Score has no public formula and is not derivable from the export.
      // Report it as unverified rather than guess.
      return { requirement: req, satisfied: false, detail: `Item Score cannot be verified locally — check in-game (need ${req.comparator} ${req.value})`, shortfall: 1 };
    case 'specific-player': {
      const has = players.some((p) => p.assetId === req.assetId);
      return { requirement: req, satisfied: has, detail: has ? `${req.name ?? req.assetId} included` : `${req.name ?? req.assetId} missing`, shortfall: has ? 0 : 1 };
    }
    case 'unparsed':
      // Never silently pass something we failed to understand.
      return { requirement: req, satisfied: false, detail: `Unparsed requirement, check by hand: "${req.text}"`, shortfall: 1 };
    default:
      // Unreachable: every remaining kind is countable and handled above.
      // Present so adding a requirement kind without handling it is a
      // compile error rather than a silent pass.
      throw new Error(`Unhandled requirement kind: ${(req as Requirement).kind}`);
  }
}

export interface SquadCheckResult {
  satisfied: boolean;
  checks: RequirementCheck[];
  /** Requirements that could not be verified rather than definitely failed. */
  unverifiable: RequirementCheck[];
}

export function checkSquad(
  players: readonly Player[],
  requirements: readonly Requirement[],
  opts: CheckOptions = {},
): SquadCheckResult {
  const checks = requirements.map((r) => checkRequirement(players, r, opts));
  const unverifiable = checks.filter(
    (c) =>
      !c.satisfied &&
      (c.requirement.kind === 'unparsed' ||
        c.requirement.kind === 'item-score' ||
        (c.requirement.kind === 'team-chemistry' && !opts.slots)),
  );
  return {
    satisfied: checks.every((c) => c.satisfied),
    checks,
    unverifiable,
  };
}

/** The squad rating a set of requirements demands, if any. */
export function requiredRating(requirements: readonly Requirement[]): number | null {
  const r = requirements.find((x) => x.kind === 'squad-rating');
  return r && r.kind === 'squad-rating' ? r.value : null;
}

/** The squad size a set of requirements demands. Defaults to 11. */
export function requiredSize(requirements: readonly Requirement[]): number {
  const r = requirements.find((x) => x.kind === 'player-count');
  return r && r.kind === 'player-count' ? r.value : 11;
}
