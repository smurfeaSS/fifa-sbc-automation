import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkPlayer } from './helpers.js';
import { annotate, DEFAULT_SETTINGS } from '../src/solver/protection.js';
import { solveSquad } from '../src/solver/squadSolver.js';
import { estimateValue } from '../src/solver/value.js';
import type { Player } from '../src/shared/types/player.js';
import type { Settings } from '../src/shared/types/club.js';

function club(spec: Array<[rating: number, count: number]>, over: Partial<Player> = {}): Player[] {
  const out: Player[] = [];
  let n = 0;
  for (const [rating, count] of spec) {
    for (let i = 0; i < count; i++) {
      const p = mkPlayer({ id: `p${n++}`, rating, ...over });
      p.value = estimateValue(p);
      out.push(p);
    }
  }
  return out;
}

const settings: Settings = { ...DEFAULT_SETTINGS, searchBudgetMs: 3000 };

test('solves an 84 squad and does not overshoot', () => {
  const players = club([[86, 6], [84, 20], [83, 20], [82, 20]]);
  const res = solveSquad(annotate(players, settings), [
    { kind: 'squad-rating', comparator: 'min', value: 84 },
    { kind: 'player-count', value: 11 },
  ], { settings });

  assert.ok(res.ok, res.ok ? '' : res.message);
  assert.equal(res.squad.players.length, 11);
  assert.ok(res.squad.rating >= 84, `rating ${res.squad.rating} below target`);
  // The whole point of §6: near-zero waste, not a comfortable overshoot.
  assert.ok(res.squad.ratingWaste < 1, `wasted ${res.squad.ratingWaste} rating`);
});

test('never uses a protected player under strict protection', () => {
  const players = club([[84, 11]]);
  // Make the only 84s icons, so every one of them is protected.
  for (const p of players) p.cardType = 'icon';
  const cheap = club([[84, 11]]).map((p, i) => ({ ...p, id: `c${i}` }));
  const all = annotate([...players, ...cheap], settings);

  const res = solveSquad(all, [
    { kind: 'squad-rating', comparator: 'min', value: 84 },
    { kind: 'player-count', value: 11 },
  ], { settings });

  assert.ok(res.ok, res.ok ? '' : res.message);
  assert.equal(res.squad.protectedUsed, 0);
  assert.ok(res.squad.players.every((p) => p.cardType !== 'icon'));
});

test('prefers duplicates and untradeables over tradeable value', () => {
  const dupes = club([[84, 11]], { isDuplicate: true, duplicateCount: 2, tradeability: 'untradeable' })
    .map((p, i) => ({ ...p, id: `d${i}`, assetId: `dupe${i}` }));
  const valuable = club([[84, 11]], { tradeability: 'tradeable' })
    .map((p, i) => ({ ...p, id: `v${i}` }));

  const res = solveSquad(annotate([...valuable, ...dupes], settings), [
    { kind: 'squad-rating', comparator: 'min', value: 84 },
    { kind: 'player-count', value: 11 },
  ], { settings });

  assert.ok(res.ok, res.ok ? '' : res.message);
  assert.equal(res.squad.duplicatesUsed, 11, 'should have used every duplicate');
  assert.equal(res.squad.tradeableValue, 0, 'should not have spent tradeable value');
});

test('reports what to buy rather than just failing (§14)', () => {
  // Nowhere near enough for an 86 squad.
  const players = club([[82, 11]]);
  const res = solveSquad(annotate(players, settings), [
    { kind: 'squad-rating', comparator: 'min', value: 86 },
    { kind: 'player-count', value: 11 },
  ], { settings });

  assert.ok(res.ok, res.ok ? '' : res.message);
  assert.ok(res.squad.missing.length > 0, 'should name the cards needed');
  assert.ok(res.squad.purchaseCost > 0);
  assert.match(res.squad.missing[0]!.description, /rated card under/);
});

test('satisfies a side constraint by swapping within the same rating', () => {
  // Plenty of 84s, but only a few are TOTW.
  const common = club([[84, 20]], { cardType: 'common' }).map((p, i) => ({ ...p, id: `n${i}` }));
  const totw = club([[84, 3]], { cardType: 'totw' }).map((p, i) => ({ ...p, id: `t${i}` }));

  const res = solveSquad(annotate([...common, ...totw], settings), [
    { kind: 'squad-rating', comparator: 'min', value: 84 },
    { kind: 'player-count', value: 11 },
    { kind: 'card-type-count', cardType: 'totw', comparator: 'min', value: 2 },
  ], { settings });

  assert.ok(res.ok, res.ok ? '' : res.message);
  assert.ok(res.squad.players.filter((p) => p.cardType === 'totw').length >= 2);
  assert.equal(res.squad.rating, 84, 'repair must not disturb the squad rating');
});

test('untradeables-only mode refuses to spend tradeable cards', () => {
  const tradeable = club([[86, 11]], { tradeability: 'tradeable' }).map((p, i) => ({ ...p, id: `t${i}` }));
  const untradeable = club([[84, 15]], { tradeability: 'untradeable' }).map((p, i) => ({ ...p, id: `u${i}` }));

  const s: Settings = { ...settings, solverMode: 'untradeables-only' };
  const res = solveSquad(annotate([...tradeable, ...untradeable], s), [
    { kind: 'squad-rating', comparator: 'min', value: 84 },
    { kind: 'player-count', value: 11 },
  ], { settings: s });

  assert.ok(res.ok, res.ok ? '' : res.message);
  assert.ok(res.squad.players.every((p) => p.tradeability === 'untradeable'));
});

test('an all-protected club fails with an explanation, not a bad squad', () => {
  const players = club([[84, 20]], { cardType: 'icon' });
  const res = solveSquad(annotate(players, settings), [
    { kind: 'squad-rating', comparator: 'min', value: 84 },
    { kind: 'player-count', value: 11 },
  ], { settings, allowPurchases: false });

  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.message, /protected/i);
});
