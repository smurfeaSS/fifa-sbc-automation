import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkPlayer } from './helpers.js';
import { annotate, DEFAULT_SETTINGS } from '../src/solver/protection.js';
import { estimateValue } from '../src/solver/value.js';
import { solveSbcSet, difficultyScore } from '../src/solver/globalAllocator.js';
import { solveSquad } from '../src/solver/squadSolver.js';
import type { Player } from '../src/shared/types/player.js';
import type { Challenge, SbcSet } from '../src/shared/types/sbc.js';
import type { Settings } from '../src/shared/types/club.js';

const settings: Settings = { ...DEFAULT_SETTINGS, searchBudgetMs: 1500 };

function make(
  prefix: string, rating: number, count: number, over: Partial<Player> = {},
): Player[] {
  return Array.from({ length: count }, (_, i) => {
    const p = mkPlayer({ id: `${prefix}${i}`, rating, ...over });
    p.assetId = over.assetId ?? `${prefix}-asset${i}`;
    p.value = estimateValue(p);
    return p;
  });
}

function challenge(id: string, name: string, rating: number): Challenge {
  return {
    id, name,
    requirements: [
      { kind: 'squad-rating', comparator: 'min', value: rating },
      { kind: 'player-count', value: 11 },
    ],
  };
}

/**
 * The exact trap automation.md §5 describes: the cheapest cards in the club
 * happen to be the high-rated ones, so solving the low squad first eats the
 * only cards the high squad could ever use.
 */
function trapClub(): Player[] {
  // Cheap 86s: untradeable duplicates. Attractive to a naive solver.
  const cheap86s = make('x', 86, 11, { tradeability: 'untradeable', isDuplicate: true, duplicateCount: 2 });
  // Expensive 84s: tradeable, first-owner. The "right" fodder for an 84 squad.
  const dear84s = make('y', 84, 14, { tradeability: 'tradeable', isFirstOwner: true });
  const filler = make('z', 83, 20, { tradeability: 'tradeable', isFirstOwner: true });
  return [...cheap86s, ...dear84s, ...filler];
}

const SET: SbcSet = {
  id: 'set1', name: 'Player Upgrade',
  challenges: [challenge('c1', '84 Rated Squad', 84), challenge('c2', '86 Rated Squad', 86)],
  source: { kind: 'local', confidence: 1 },
};

test('solving in listed order falls into the §5 trap', () => {
  // This is the behaviour the allocator exists to prevent — asserted so the
  // next test is proving something real rather than a tautology.
  const pool = annotate(trapClub(), settings);
  const committed = new Set<string>();

  const first = solveSquad(pool, SET.challenges[0]!.requirements, { settings, exclude: committed });
  assert.ok(first.ok);
  for (const p of first.squad.players) committed.add(p.id);

  const usedCheap86s = first.squad.players.filter((p) => p.rating === 86).length;
  assert.ok(usedCheap86s > 0, 'naive order should be tempted by the cheap 86s');

  const second = solveSquad(pool, SET.challenges[1]!.requirements, { settings, exclude: committed });
  assert.ok(second.ok);
  assert.ok(second.squad.purchaseCost > 0, 'and should then have to buy 86s');
});

test('the global allocator avoids it and completes from the club', () => {
  const pool = annotate(trapClub(), settings);
  const solution = solveSbcSet(SET, pool, { settings });

  assert.equal(solution.challenges.length, 2);
  for (const c of solution.challenges) {
    assert.ok(c.squad, `${c.challenge.name} was not solved: ${c.failure?.message}`);
  }
  assert.equal(solution.totals.purchaseCost, 0, 'should complete the whole set from the club');
  assert.ok(solution.completable);

  // The 86 squad must have got the 86s.
  const high = solution.challenges.find((c) => c.challenge.id === 'c2')!;
  assert.equal(high.squad!.players.filter((p) => p.rating >= 86).length, 11);
});

test('no player is used in two challenges at once', () => {
  const pool = annotate(trapClub(), settings);
  const solution = solveSbcSet(SET, pool, { settings });

  const seen = new Set<string>();
  for (const c of solution.challenges) {
    for (const p of c.squad?.players ?? []) {
      assert.ok(!seen.has(p.id), `player ${p.id} allocated twice`);
      seen.add(p.id);
    }
  }
});

test('harder challenges score higher and so go first', () => {
  const pool = annotate(trapClub(), settings);
  const easy = difficultyScore(SET.challenges[0]!, pool);
  const hard = difficultyScore(SET.challenges[1]!, pool);
  assert.ok(hard > easy, `86 squad (${hard}) should outrank 84 squad (${easy})`);
});

test('scarce side constraints raise difficulty', () => {
  const pool = annotate(trapClub(), settings);
  const plain = challenge('a', 'plain', 84);
  const constrained: Challenge = {
    ...challenge('b', 'constrained', 84),
    requirements: [
      ...challenge('b', 'constrained', 84).requirements,
      // Nothing in the club is TOTW, so this is maximally scarce.
      { kind: 'card-type-count', cardType: 'totw', comparator: 'min', value: 3 },
    ],
  };
  assert.ok(difficultyScore(constrained, pool) > difficultyScore(plain, pool));
});

test('a five-squad set allocates across all of them', () => {
  // The worked example from §5.
  const club = [
    ...make('a', 86, 13, { tradeability: 'untradeable', isDuplicate: true, duplicateCount: 2 }),
    ...make('b', 85, 16, { tradeability: 'untradeable' }),
    ...make('c', 84, 22, { tradeability: 'untradeable' }),
    ...make('d', 83, 30, { tradeability: 'untradeable' }),
    ...make('e', 82, 40, { tradeability: 'untradeable' }),
  ];
  const set: SbcSet = {
    id: 's', name: 'Player SBC',
    challenges: [
      challenge('c1', '83 Rated Squad', 83),
      challenge('c2', '84 Rated Squad', 84),
      challenge('c3', '84 Rated Squad +', 84),
      challenge('c4', '85 Rated Squad', 85),
      challenge('c5', '86 Rated Squad', 86),
    ],
    source: { kind: 'local', confidence: 1 },
  };

  const solution = solveSbcSet(set, annotate(club, settings), { settings, budgetMs: 6000 });
  assert.equal(solution.challenges.filter((c) => c.squad).length, 5);

  const seen = new Set<string>();
  for (const c of solution.challenges) {
    for (const p of c.squad?.players ?? []) {
      assert.ok(!seen.has(p.id), `double-allocated ${p.id}`);
      seen.add(p.id);
    }
  }
  assert.equal(seen.size, 55, 'five full squads');
});
