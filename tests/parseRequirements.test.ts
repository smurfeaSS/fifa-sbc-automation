import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRequirementLine, parseRequirements } from '../src/sbc/parseRequirements.js';

test('parses squad rating with each comparator', () => {
  assert.deepEqual(parseRequirementLine('Squad Rating: Min 84'),
    { kind: 'squad-rating', comparator: 'min', value: 84 });
  assert.deepEqual(parseRequirementLine('Team Rating: Exactly 85'),
    { kind: 'squad-rating', comparator: 'exact', value: 85 });
  assert.deepEqual(parseRequirementLine('Squad Rating: Max 82'),
    { kind: 'squad-rating', comparator: 'max', value: 82 });
});

test('parses chemistry and squad size', () => {
  assert.deepEqual(parseRequirementLine('Team Chemistry: Min 30'),
    { kind: 'team-chemistry', comparator: 'min', value: 30 });
  assert.deepEqual(parseRequirementLine('Number of players in the Squad: 11'),
    { kind: 'player-count', value: 11 });
});

test('distinguishes "same league" from a distinct league count', () => {
  assert.deepEqual(parseRequirementLine('Same League Count: Min 5'),
    { kind: 'same-league', value: 5 });
  assert.deepEqual(parseRequirementLine('Leagues: Max 3'),
    { kind: 'distinct-leagues', comparator: 'max', value: 3 });
});

test('parses rare, TOTW, icon and hero counts', () => {
  assert.deepEqual(parseRequirementLine('Rare: Min 3'),
    { kind: 'rare-count', comparator: 'min', value: 3 });
  assert.deepEqual(parseRequirementLine('Team of the Week Players: Min 1'),
    { kind: 'card-type-count', cardType: 'totw', comparator: 'min', value: 1 });
  assert.deepEqual(parseRequirementLine('Icons: Min 1'),
    { kind: 'card-type-count', cardType: 'icon', comparator: 'min', value: 1 });
});

test('maps player quality to a minimum rating for the whole squad', () => {
  assert.deepEqual(parseRequirementLine('Player Quality: Gold'),
    { kind: 'min-rating', comparator: 'min', value: 75, count: 11 });
});

test('parses "Minimum OVR of X" with its own count', () => {
  assert.deepEqual(parseRequirementLine('Minimum OVR of 86: 2'),
    { kind: 'min-rating', comparator: 'min', value: 86, count: 2 });
});

test('keeps the text of anything it does not understand', () => {
  const r = parseRequirementLine('Some Brand New Requirement: Min 4');
  assert.equal(r.kind, 'unparsed');
  if (r.kind === 'unparsed') assert.match(r.text, /Brand New/);
});

test('never throws on junk input', () => {
  for (const junk of ['', '   ', ':::', 'Min', '42', '\u0000', 'a'.repeat(5000)]) {
    assert.doesNotThrow(() => parseRequirementLine(junk));
  }
});

test('confidence reflects the share of lines understood', () => {
  const good = parseRequirements(['Squad Rating: Min 84', 'Team Chemistry: Min 30']);
  assert.equal(good.confidence, 1);
  assert.equal(good.unparsed.length, 0);

  const mixed = parseRequirements(['Squad Rating: Min 84', 'Mystery Clause: 7']);
  assert.equal(mixed.confidence, 0.5);
  assert.equal(mixed.unparsed.length, 1);

  // Nothing parsed is zero confidence, not vacuous certainty.
  assert.equal(parseRequirements([]).confidence, 0);
});

test('a full realistic SBC parses cleanly', () => {
  const parsed = parseRequirements([
    'Squad Rating: Min 84',
    'Team Chemistry: Min 25',
    'Number of players in the Squad: 11',
    'Rare: Min 4',
    'Team of the Week Players: Min 1',
    'Same League Count: Min 4',
  ]);
  assert.equal(parsed.confidence, 1);
  assert.equal(parsed.requirements.length, 6);
});
