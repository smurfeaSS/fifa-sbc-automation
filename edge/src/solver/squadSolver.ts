/**
 * Squad solver — automation.md §6, §25.
 *
 * Not random selection and not greedy: a branch-and-bound search over *rating
 * multisets*, which is the structure that makes this tractable.
 *
 * The key observation: for any fixed multiset of ratings (say "two 86s, four
 * 84s, five 83s"), the cheapest squad with those ratings is simply the cheapest
 * available players at each rating. So instead of searching over 11-player
 * combinations from a pool of thousands — astronomically large — we search over
 * rating multisets, of which there are few, and read off the players.
 *
 * Constraints that are not about rating (nations, rare counts, leagues) are
 * then satisfied by a repair pass that swaps players *within the same rating*,
 * which cannot disturb the squad rating the search just optimised.
 *
 * The objective is the §25 cost function:
 *   tradeable_value_loss + rating_waste + protected_penalty
 *   + rare_card_penalty + purchase_cost
 * with protected players at Infinity under strict mode (§20).
 */

import { exactSquadRating, squadRating, ratingWaste } from './rating';
import { checkSquad, toCountable, requiredRating, requiredSize, type RequirementCheck, type CountableConstraint } from './requirements';
import { marketValue, untradeableValue } from './value';
import type { AnnotatedPlayer } from '../shared/player';
import type { Requirement } from '../shared/sbc';
import type { Settings } from '../shared/club';

/** A player the club does not have and would need to buy (§14, §15). */
export interface MissingPlayer {
  rating: number;
  /** Estimated coins to buy a card of roughly this rating. */
  estimatedCost: number;
  /** Generic description, e.g. "86 rated card under ~9,000 coins" (§15). */
  description: string;
}

export interface SolvedSquad {
  players: AnnotatedPlayer[];
  /** Players that must be bought. Empty when the club can complete the SBC. */
  missing: MissingPlayer[];
  rating: number;
  exactRating: number;
  ratingWaste: number;
  /** Objective value. Lower is better. Not a coin amount. */
  cost: number;
  /** Recoverable coins given up. This is the number that actually hurts. */
  tradeableValue: number;
  /** Notional replacement cost of untradeables consumed. */
  untradeableValue: number;
  duplicatesUsed: number;
  protectedUsed: number;
  purchaseCost: number;
  checks: RequirementCheck[];
  satisfied: boolean;
  /** True when some requirement could not be verified locally. */
  needsManualCheck: boolean;
}

export type SolveResult =
  | { ok: true; squad: SolvedSquad }
  | {
      ok: false;
      reason: 'empty-pool' | 'no-feasible-squad' | 'constraints-unsatisfiable';
      message: string;
      /** Best partial attempt, for explaining *why* it failed. */
      bestAttempt?: SolvedSquad;
    };

export interface SolveOptions {
  settings: Settings;
  /** Item ids reserved by other challenges in the same SBC set. */
  exclude?: ReadonlySet<string>;
  /** Wall-clock search budget. Defaults to settings.searchBudgetMs. */
  budgetMs?: number;
  /**
   * Allow the solver to propose cards the club does not own (§14).
   * On by default: "you need one more 86" is far more useful than "cannot
   * complete", which §14 explicitly rejects.
   */
  allowPurchases?: boolean;
}

/**
 * Ratings we are willing to suggest buying, given a target squad rating.
 *
 * Deliberately a narrow band: nobody buys a 92 to complete an 84 squad, and
 * every extra rating here adds a whole level to the search tree. When no rating
 * is required we fall back to a small default band.
 */
function purchasableRatings(required: number | null): number[] {
  const centre = required ?? 84;
  const lo = Math.max(75, centre - 4);
  const hi = Math.min(92, centre + 4);
  return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
}

/**
 * How much worse a purchase is than an owned card of the same estimated value.
 * See syntheticPlayer below for why this must be comfortably above 1.
 */
const PURCHASE_AVERSION = 2.0;

function purchaseEstimate(rating: number): number {
  // Deliberately conservative — over-estimating a purchase makes the solver
  // prefer club players, which is the whole point of the tool.
  const anchors: Array<[number, number]> = [
    [75, 250], [80, 500], [82, 800], [83, 1200], [84, 2000],
    [85, 3500], [86, 8000], [87, 16000], [88, 32000], [92, 400000],
  ];
  let lo = anchors[0]!;
  for (const a of anchors) {
    if (rating >= a[0]) lo = a;
  }
  const hi = anchors.find((a) => a[0] > rating) ?? lo;
  if (hi[0] === lo[0]) return lo[1];
  const t = (rating - lo[0]) / (hi[0] - lo[0]);
  return Math.round(lo[1] * Math.pow(hi[1] / lo[1], t));
}

/** Synthetic "buy this" entry, distinguishable by its id prefix. */
function syntheticPlayer(rating: number, n: number, settings: Settings): AnnotatedPlayer {
  const cost = purchaseEstimate(rating);
  return {
    id: `buy:${rating}:${n}`,
    assetId: `buy:${rating}`,
    name: `(buy) ${rating} rated`,
    rating,
    position: { primary: 'UNK', alternates: [], group: 'MID' },
    nationId: 0, leagueId: 0, clubId: 0,
    cardType: 'common',
    tradeability: 'tradeable',
    isDuplicate: false,
    duplicateCount: 1,
    evolution: { isEvolved: false },
    isFirstOwner: false,
    squadUsage: [],
    inActiveSquad: false,
    manuallyLocked: false,
    isFavourite: false,
    value: { coins: cost, source: 'heuristic', asOf: new Date().toISOString(), confidence: 0.3 },
    isProtected: false,
    protectionReasons: [],
    // Purchases are charged at full price and then doubled, so buying is always
    // strictly worse than spending a club card of equal value — the card is a
    // sunk asset, the coins are not. At a smaller multiplier this ties with an
    // owned card of the same rating and the solver sends you to the market for
    // no reason.
    sacrificeCost: cost * settings.weights.purchaseCost * PURCHASE_AVERSION,
    priorityTier: 9,
  };
}

const isSynthetic = (p: AnnotatedPlayer): boolean => p.id.startsWith('buy:');

interface Bucket {
  rating: number;
  /** Ascending by sacrificeCost. */
  players: AnnotatedPlayer[];
  /** prefix[k] = cost of the k cheapest players at this rating. */
  prefix: number[];
}

function buildBuckets(pool: readonly AnnotatedPlayer[]): Bucket[] {
  const byRating = new Map<number, AnnotatedPlayer[]>();
  for (const p of pool) {
    const list = byRating.get(p.rating);
    if (list) list.push(p);
    else byRating.set(p.rating, [p]);
  }
  const buckets: Bucket[] = [];
  for (const [rating, players] of byRating) {
    players.sort((a, b) => a.sacrificeCost - b.sacrificeCost);
    const prefix = [0];
    for (const p of players) prefix.push(prefix[prefix.length - 1]! + p.sacrificeCost);
    buckets.push({ rating, players, prefix });
  }
  // Descending rating: taking the expensive, high-rated decisions first makes
  // the cost bound bite early and prunes far more of the tree.
  buckets.sort((a, b) => b.rating - a.rating);
  return buckets;
}

/**
 * Repair countable constraints by swapping within the same rating.
 *
 * Returns the repaired selection, or null when no same-rating swap can satisfy
 * the constraints — in which case the caller moves on to the next multiset.
 */
function repairConstraints(
  selected: AnnotatedPlayer[],
  buckets: readonly Bucket[],
  constraints: readonly CountableConstraint[],
): AnnotatedPlayer[] | null {
  if (constraints.length === 0) return selected;

  const current = [...selected];
  const bucketByRating = new Map(buckets.map((b) => [b.rating, b]));

  // Bounded: each pass fixes at least one unit of shortfall, and total
  // shortfall is bounded by squad size times constraint count.
  const maxPasses = current.length * constraints.length + 1;

  for (let pass = 0; pass < maxPasses; pass++) {
    const unmet = constraints
      .map((c) => {
        const actual = current.filter(c.matches).length;
        const need =
          c.comparator === 'min' ? c.target - actual
          : c.comparator === 'max' ? actual - c.target
          : actual - c.target;
        return { c, need, direction: c.comparator === 'max' ? -1 : Math.sign(need) };
      })
      .filter((x) => (x.c.comparator === 'exact' ? x.need !== 0 : x.need > 0));

    if (unmet.length === 0) return current;

    // Fix the most-violated constraint first.
    unmet.sort((a, b) => Math.abs(b.need) - Math.abs(a.need));
    const target = unmet[0]!;
    const wantMore = target.c.comparator === 'max' ? false : target.need > 0;

    // Cheapest swap that moves this constraint in the right direction without
    // breaking an already-satisfied one.
    let best: { outIdx: number; inPlayer: AnnotatedPlayer; delta: number } | null = null;

    for (let i = 0; i < current.length; i++) {
      const out = current[i]!;
      const outMatches = target.c.matches(out);
      // Removing a matcher helps only when we have too many, and vice versa.
      if (wantMore ? outMatches : !outMatches) continue;

      const bucket = bucketByRating.get(out.rating);
      if (!bucket) continue;

      const chosenIds = new Set(current.map((p) => p.id));
      for (const cand of bucket.players) {
        if (chosenIds.has(cand.id)) continue;
        if (wantMore ? !target.c.matches(cand) : target.c.matches(cand)) continue;

        // Reject swaps that break a constraint currently satisfied.
        const trial = current.slice();
        trial[i] = cand;
        const breaksOther = constraints.some((other) => {
          if (other === target.c) return false;
          const before = current.filter(other.matches).length;
          const after = trial.filter(other.matches).length;
          const wasOk =
            other.comparator === 'min' ? before >= other.target
            : other.comparator === 'max' ? before <= other.target
            : before === other.target;
          const nowOk =
            other.comparator === 'min' ? after >= other.target
            : other.comparator === 'max' ? after <= other.target
            : after === other.target;
          return wasOk && !nowOk;
        });
        if (breaksOther) continue;

        const delta = cand.sacrificeCost - out.sacrificeCost;
        if (!best || delta < best.delta) best = { outIdx: i, inPlayer: cand, delta };
      }
    }

    if (!best) return null;
    current[best.outIdx] = best.inPlayer;
  }

  return null;
}

function summarise(
  players: AnnotatedPlayer[],
  requirements: readonly Requirement[],
  required: number | null,
): SolvedSquad {
  const real = players.filter((p) => !isSynthetic(p));
  const synth = players.filter(isSynthetic);
  const ratings = players.map((p) => p.rating);

  // Checked against the full proposed squad, purchases included — the status
  // should describe what the user would actually submit, not the club-only
  // subset, which would read as failing whenever a purchase is suggested.
  const fullCheck = checkSquad(players, requirements);

  const missing: MissingPlayer[] = synth.map((p) => {
    const cost = purchaseEstimate(p.rating);
    return {
      rating: p.rating,
      estimatedCost: cost,
      description: `${p.rating} rated card under ~${Math.round(cost * 1.2).toLocaleString()} coins`,
    };
  });

  return {
    players: real,
    missing,
    rating: squadRating(ratings),
    exactRating: exactSquadRating(ratings),
    ratingWaste: required !== null ? ratingWaste(ratings, required) : 0,
    cost: players.reduce((a, p) => a + p.sacrificeCost, 0),
    tradeableValue: real.reduce((a, p) => a + marketValue(p), 0),
    untradeableValue: real.reduce((a, p) => a + untradeableValue(p), 0),
    duplicatesUsed: real.filter((p) => p.isDuplicate).length,
    protectedUsed: real.filter((p) => p.isProtected).length,
    purchaseCost: missing.reduce((a, m) => a + m.estimatedCost, 0),
    checks: fullCheck.checks,
    satisfied: fullCheck.satisfied,
    needsManualCheck: fullCheck.unverifiable.length > 0,
  };
}

export function solveSquad(
  pool: readonly AnnotatedPlayer[],
  requirements: readonly Requirement[],
  opts: SolveOptions,
): SolveResult {
  const { settings } = opts;
  const budgetMs = opts.budgetMs ?? settings.searchBudgetMs;
  const deadline = Date.now() + budgetMs;

  const size = requiredSize(requirements);
  const required = requiredRating(requirements);

  // Usable pool: protected players are already Infinity-costed by the
  // protection engine, so filtering finite costs enforces §20 structurally.
  let usable = pool.filter(
    (p) => Number.isFinite(p.sacrificeCost) && !(opts.exclude?.has(p.id) ?? false),
  );

  if (usable.length === 0) {
    return {
      ok: false,
      reason: 'empty-pool',
      message:
        'No usable players. Every card in the club is protected under the current rules — ' +
        'loosen the protection settings or unlock specific players.',
    };
  }

  if (opts.allowPurchases !== false) {
    // A handful of synthetic cards per rating is enough: no sane squad buys
    // more than a few, and each extra one multiplies the search space.
    for (const r of purchasableRatings(required)) {
      for (let n = 0; n < 4; n++) usable.push(syntheticPlayer(r, n, settings));
    }
  }

  const buckets = buildBuckets(usable);
  if (buckets.length === 0 || usable.length < size) {
    return {
      ok: false,
      reason: 'no-feasible-squad',
      message: `Only ${usable.length} usable players, need ${size}.`,
    };
  }

  const constraints = requirements
    .map(toCountable)
    .filter((c): c is CountableConstraint => c !== null);

  /**
   * minCostFrom[i] = cheapest single player available in buckets i..end.
   *
   * A tighter admissible bound than one global minimum: deep in the tree the
   * cheap low-rated buckets are often already behind us, and knowing that
   * every remaining slot must cost at least this much prunes hard.
   */
  const minCostFrom = new Array<number>(buckets.length + 1).fill(Infinity);
  for (let i = buckets.length - 1; i >= 0; i--) {
    const cheapestHere = buckets[i]!.players[0]?.sacrificeCost ?? Infinity;
    minCostFrom[i] = Math.min(cheapestHere, minCostFrom[i + 1]!);
  }

  let best: { players: AnnotatedPlayer[]; cost: number } | null = null;
  let bestAttempt: { players: AnnotatedPlayer[]; cost: number } | null = null;
  let nodes = 0;
  let timedOut = false;

  /** Counts taken from each bucket, parallel to `buckets`. */
  const take: number[] = new Array(buckets.length).fill(0);

  function materialise(): AnnotatedPlayer[] {
    const out: AnnotatedPlayer[] = [];
    for (let i = 0; i < buckets.length; i++) {
      const k = take[i]!;
      if (k > 0) out.push(...buckets[i]!.players.slice(0, k));
    }
    return out;
  }

  function dfs(idx: number, remaining: number, ratings: number[], cost: number): void {
    if (timedOut) return;
    if ((++nodes & 0x3ff) === 0 && Date.now() > deadline) {
      timedOut = true;
      return;
    }

    // Cost bound: every remaining slot must be filled from buckets idx..end,
    // so it costs at least the cheapest card still reachable.
    if (best && cost + remaining * (minCostFrom[idx] ?? 0) >= best.cost) return;

    if (remaining === 0) {
      if (required !== null && squadRating(ratings) < required) return;

      const selected = materialise();
      const repaired = repairConstraints(selected, buckets, constraints);
      if (!repaired) {
        // Remember it anyway — if nothing ever satisfies the side constraints,
        // this is what we show to explain why.
        const attemptCost = selected.reduce((a, p) => a + p.sacrificeCost, 0);
        if (!bestAttempt || attemptCost < bestAttempt.cost) {
          bestAttempt = { players: selected, cost: attemptCost };
        }
        return;
      }

      let total = repaired.reduce((a, p) => a + p.sacrificeCost, 0);
      // Rating waste is part of the objective, not just a display value (§6):
      // it is what stops the solver handing over an 86.2 squad for an 84 SBC.
      if (required !== null) {
        total += ratingWaste(repaired.map((p) => p.rating), required) * settings.weights.ratingWaste;
      }
      if (!best || total < best.cost) best = { players: repaired, cost: total };
      return;
    }

    if (idx >= buckets.length) return;

    // Rating bound: even filling every remaining slot with the best card we
    // still have access to at this depth must be able to reach the target.
    if (required !== null) {
      const bestRemaining = buckets[idx]!.rating;
      const optimistic = [...ratings, ...Array<number>(remaining).fill(bestRemaining)];
      if (squadRating(optimistic) < required) return;
    }

    const bucket = buckets[idx]!;
    const maxTake = Math.min(bucket.players.length, remaining);
    // Ascending, and buckets run highest-rating-first, so the first branch
    // explored spends none of the best cards. That reaches a *cheap* feasible
    // squad early, and a low incumbent cost is what makes the bound above
    // prune the rest of the tree. Branching the other way finds an expensive
    // squad first and prunes almost nothing.
    for (let k = 0; k <= maxTake; k++) {
      take[idx] = k;
      const added = k > 0 ? Array<number>(k).fill(bucket.rating) : [];
      dfs(idx + 1, remaining - k, [...ratings, ...added], cost + bucket.prefix[k]!);
      if (timedOut) break;
    }
    take[idx] = 0;
  }

  dfs(0, size, [], 0);

  if (!best) {
    const attempt = bestAttempt
      ? summarise((bestAttempt as { players: AnnotatedPlayer[] }).players, requirements, required)
      : undefined;
    return {
      ok: false,
      reason: bestAttempt ? 'constraints-unsatisfiable' : 'no-feasible-squad',
      message: bestAttempt
        ? 'Found squads meeting the rating, but none that also satisfy the other ' +
          'requirements with unprotected players.'
        : timedOut
          ? `No squad found within the ${budgetMs}ms search budget. Raise searchBudgetMs in settings.`
          : 'No combination of usable players meets these requirements.',
      ...(attempt ? { bestAttempt: attempt } : {}),
    };
  }

  return { ok: true, squad: summarise((best as { players: AnnotatedPlayer[] }).players, requirements, required) };
}
