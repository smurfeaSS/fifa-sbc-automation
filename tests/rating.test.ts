import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exactSquadRating, squadRating, ratingWaste } from '../src/solver/rating.js';

test('a uniform squad rates at its own rating', () => {
  assert.equal(squadRating(Array(11).fill(84)), 84);
  assert.equal(exactSquadRating(Array(11).fill(84)), 84);
});

test('one high card lifts the squad above the plain average', () => {
  // Plain average would be 84.6 -> 84. The excess term pushes it to 85.
  const ratings = [...Array(10).fill(84), 91];
  const mean = ratings.reduce((a, b) => a + b, 0) / 11;
  assert.ok(exactSquadRating(ratings) > mean, 'excess term must raise the rating');
  assert.equal(squadRating(ratings), 85);
});

test('a squad below target does not round up into it', () => {
  assert.equal(squadRating([...Array(10).fill(83), 84]), 83);
});

test('rating waste measures overshoot, not undershoot', () => {
  assert.equal(ratingWaste(Array(11).fill(84), 84), 0);
  assert.equal(ratingWaste(Array(11).fill(83), 84), 0, 'undershoot is not waste');
  assert.ok(ratingWaste(Array(11).fill(86), 84) > 1.9);
});

test('excess is measured against the mean, so one card cannot dominate', () => {
  // A single 99 among ten 70s should not produce anything near 99.
  const r = squadRating([...Array(10).fill(70), 99]);
  assert.ok(r < 80, `expected a modest lift, got ${r}`);
});
