/**
 * Global multi-squad allocation — automation.md §5.
 *
 * The failure this exists to prevent: an SBC set of [83, 84, 84+TOTW, 85, 86]
 * solved one squad at a time, in the order the game lists them, spends your
 * cheap 86s inside the 84 squad and then leaves you buying 86s for the squad
 * that actually needed them.
 *
 * Three ideas do the work:
 *
 *  1. Solve the most *constrained* challenge first, not the first listed.
 *     Scarce high-rated cards get claimed by the squad that has no alternative.
 *  2. Try several orderings and keep the cheapest overall result, because
 *     "most constrained" is a heuristic and occasionally the wrong call.
 *  3. Refine: release one challenge's players back into the pool, re-solve it
 *     against everything now free, and keep the change only if the *total*
 *     across all challenges improves. Repeat until nothing improves.
 *
 * Step 3 is what actually fixes cross-squad mistakes, since it can undo a bad
 * early commitment that looked locally optimal.
 */

import { solveSquad, type SolveResult, type SolvedSquad } from './squadSolver.js';
import { requiredRating, toCountable } from './requirements.js';
import type { AnnotatedPlayer } from '../shared/types/player.js';
import type { Challenge, SbcSet } from '../shared/types/sbc.js';
import type { Settings } from '../shared/types/club.js';

export interface AllocatedChallenge {
  challenge: Challenge;
  squad?: SolvedSquad;
  /** Present when this challenge could not be solved. */
  failure?: { reason: string; message: string };
}

export interface SetSolution {
  set: SbcSet;
  challenges: AllocatedChallenge[];
  /** True only when every challenge was solved without purchases. */
  completable: boolean;
  totals: {
    cost: number;
    tradeableValue: number;
    untradeableValue: number;
    purchaseCost: number;
    duplicatesUsed: number;
    protectedUsed: number;
    playersUsed: number;
  };
  /** Requirements no challenge could satisfy, for the §14 report. */
  unsolved: string[];
}

/**
 * How hard a challenge is to fill from this pool. Higher goes first.
 *
 * Rating dominates because high-rated cards are the genuinely scarce resource.
 * Side constraints add to it in proportion to how few pool players satisfy
 * them — a "5 from the Bundesliga" clause is only difficult if you are short
 * of Bundesliga cards, and scoring it by actual scarcity rather than by its
 * existence is what makes the ordering track reality.
 */
export function difficultyScore(challenge: Challenge, pool: readonly AnnotatedPlayer[]): number {
  const rating = requiredRating(challenge.requirements) ?? 0;
  let score = rating * 100;

  for (const req of challenge.requirements) {
    const countable = toCountable(req);
    if (!countable || countable.comparator === 'max') continue;
    const available = pool.filter(countable.matches).length;
    // Scarcity ratio: needing 5 of something you have 6 of is near-critical;
    // needing 5 of something you have 500 of is free.
    const scarcity = available === 0 ? 1000 : Math.min(1000, (countable.target / available) * 500);
    score += scarcity;
  }

  // An unparsed requirement makes a challenge risky to defer, since we cannot
  // tell what it will consume.
  if (challenge.requirements.some((r) => r.kind === 'unparsed')) score += 50;

  return score;
}

function emptyTotals(): SetSolution['totals'] {
  return {
    cost: 0, tradeableValue: 0, untradeableValue: 0, purchaseCost: 0,
    duplicatesUsed: 0, protectedUsed: 0, playersUsed: 0,
  };
}

function accumulate(allocations: readonly AllocatedChallenge[]): SetSolution['totals'] {
  const t = emptyTotals();
  for (const a of allocations) {
    if (!a.squad) continue;
    t.cost += a.squad.cost;
    t.tradeableValue += a.squad.tradeableValue;
    t.untradeableValue += a.squad.untradeableValue;
    t.purchaseCost += a.squad.purchaseCost;
    t.duplicatesUsed += a.squad.duplicatesUsed;
    t.protectedUsed += a.squad.protectedUsed;
    t.playersUsed += a.squad.players.length;
  }
  return t;
}

/**
 * Total objective for an allocation.
 *
 * Purchases are weighted heavily on top of their coin cost: a solution that
 * completes from the club is worth more than one that is marginally cheaper on
 * paper but sends the user to the transfer market.
 */
function totalObjective(allocations: readonly AllocatedChallenge[]): number {
  let total = 0;
  for (const a of allocations) {
    if (!a.squad) {
      // An unsolved challenge is worse than any solved one.
      total += 1e12;
      continue;
    }
    total += a.squad.cost + a.squad.purchaseCost * 2;
  }
  return total;
}

function solveInOrder(
  order: readonly Challenge[],
  pool: readonly AnnotatedPlayer[],
  settings: Settings,
  budgetPerChallengeMs: number,
): AllocatedChallenge[] {
  const committed = new Set<string>();
  const out: AllocatedChallenge[] = [];

  for (const challenge of order) {
    const res = solveSquad(pool, challenge.requirements, {
      settings,
      exclude: committed,
      budgetMs: budgetPerChallengeMs,
    });
    if (res.ok) {
      for (const p of res.squad.players) committed.add(p.id);
      out.push({ challenge, squad: res.squad });
    } else {
      out.push({ challenge, failure: { reason: res.reason, message: res.message } });
    }
  }
  return out;
}

/**
 * Release each challenge in turn and re-solve it against the freed pool,
 * keeping only changes that improve the total.
 */
function refine(
  allocations: AllocatedChallenge[],
  pool: readonly AnnotatedPlayer[],
  settings: Settings,
  budgetPerChallengeMs: number,
  deadline: number,
): AllocatedChallenge[] {
  let current = [...allocations];
  let bestTotal = totalObjective(current);

  for (let pass = 0; pass < 3; pass++) {
    let improvedThisPass = false;

    for (let i = 0; i < current.length; i++) {
      if (Date.now() > deadline) return current;

      // Everything committed except the challenge under reconsideration.
      const committed = new Set<string>();
      for (let j = 0; j < current.length; j++) {
        if (j === i) continue;
        for (const p of current[j]!.squad?.players ?? []) committed.add(p.id);
      }

      const entry = current[i]!;
      const res = solveSquad(pool, entry.challenge.requirements, {
        settings,
        exclude: committed,
        budgetMs: budgetPerChallengeMs,
      });
      if (!res.ok) continue;

      const trial = [...current];
      trial[i] = { challenge: entry.challenge, squad: res.squad };
      const trialTotal = totalObjective(trial);
      if (trialTotal < bestTotal - 1e-6) {
        current = trial;
        bestTotal = trialTotal;
        improvedThisPass = true;
      }
    }

    if (!improvedThisPass) break;
  }

  return current;
}

export interface AllocateOptions {
  settings: Settings;
  /** Total wall-clock budget for the whole set. Defaults to 8x the per-squad budget. */
  budgetMs?: number;
}

/**
 * Solve every challenge in an SBC set together.
 *
 * Only incomplete challenges are solved; completed ones are passed through so
 * the preview still shows the whole set.
 */
export function solveSbcSet(
  set: SbcSet,
  pool: readonly AnnotatedPlayer[],
  opts: AllocateOptions,
): SetSolution {
  const { settings } = opts;
  const pending = set.challenges.filter((c) => !c.completed);
  const totalBudget = opts.budgetMs ?? settings.searchBudgetMs * 8;
  const deadline = Date.now() + totalBudget;

  if (pending.length === 0) {
    return {
      set, challenges: [], completable: true, totals: emptyTotals(), unsolved: [],
    };
  }

  // Per-challenge budget leaves room for the refinement passes that follow.
  const perChallenge = Math.max(
    250,
    Math.floor(totalBudget / (pending.length * 4)),
  );

  const byDifficulty = [...pending].sort(
    (a, b) => difficultyScore(b, pool) - difficultyScore(a, pool),
  );

  /**
   * Candidate orderings. Hardest-first is the principled one; the other two are
   * cheap insurance against the heuristic misjudging a set.
   */
  const orderings: Challenge[][] = [
    byDifficulty,
    [...byDifficulty].reverse(),
    pending,
  ];

  let best: AllocatedChallenge[] | null = null;
  let bestTotal = Infinity;

  for (const order of orderings) {
    if (Date.now() > deadline && best) break;
    const allocated = solveInOrder(order, pool, settings, perChallenge);
    const refined = refine(allocated, pool, settings, perChallenge, deadline);
    const total = totalObjective(refined);
    if (total < bestTotal) {
      bestTotal = total;
      best = refined;
    }
  }

  // Restore the game's own ordering for display, so the preview matches what
  // the user sees in the Web App.
  const indexOf = new Map(set.challenges.map((c, i) => [c.id, i]));
  const challenges = (best ?? []).sort(
    (a, b) => (indexOf.get(a.challenge.id) ?? 0) - (indexOf.get(b.challenge.id) ?? 0),
  );

  const unsolved = challenges
    .filter((c) => !c.squad)
    .map((c) => `${c.challenge.name}: ${c.failure?.message ?? 'no solution'}`);

  const totals = accumulate(challenges);

  return {
    set,
    challenges,
    completable: unsolved.length === 0 && totals.purchaseCost === 0,
    totals,
    unsolved,
  };
}
