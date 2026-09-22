import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SbcScraper } from '../src/sbc/sources/scraper.js';

const scraper = new SbcScraper({
  baseUrl: 'https://example.invalid/',
  selectors: {
    setList: '.sbc-set',
    setName: '.name',
    setLink: 'a',
    challengeList: '.challenge',
    challengeName: '.cname',
    requirementLine: 'li',
  },
});

const INDEX_HTML = `
<html><body>
  <div class="sbc-set"><span class="name">Player Upgrade</span><a href="/sbc/player-upgrade">go</a></div>
  <div class="sbc-set"><span class="name">Marquee Matchups</span><a href="/sbc/marquee">go</a></div>
  <div class="sbc-set"><span class="name">Broken</span></div>
</body></html>`;

const SET_HTML = `
<html><body>
  <div class="challenge">
    <h4 class="cname">84 Rated Squad</h4>
    <ul>
      <li>Squad Rating: Min 84</li>
      <li>Number of players in the Squad: 11</li>
      <li>Rare: Min 3</li>
    </ul>
  </div>
  <div class="challenge">
    <h4 class="cname">86 Rated Squad</h4>
    <ul>
      <li>Squad Rating: Min 86</li>
      <li>Number of players in the Squad: 11</li>
    </ul>
  </div>
</body></html>`;

test('parses an index page and resolves relative links', () => {
  const stubs = scraper.parseIndex(INDEX_HTML);
  assert.equal(stubs.length, 2, 'the entry with no link should be skipped');
  assert.equal(stubs[0]!.name, 'Player Upgrade');
  assert.equal(stubs[0]!.url, 'https://example.invalid/sbc/player-upgrade');
});

test('parses a set page into structured challenges', () => {
  const set = scraper.parseSet(SET_HTML, { name: 'Player Upgrade', url: 'https://example.invalid/x' });
  assert.equal(set.challenges.length, 2);
  assert.equal(set.source.kind, 'scraped');
  assert.equal(set.source.confidence, 1);

  assert.deepEqual(set.challenges[0]!.requirements[0],
    { kind: 'squad-rating', comparator: 'min', value: 84 });
});

test('confidence drops when requirement text is not understood', () => {
  const html = SET_HTML.replace('<li>Rare: Min 3</li>', '<li>Some Unknown Clause: 4</li>');
  const set = scraper.parseSet(html, { name: 'X', url: 'u' });
  assert.ok(set.source.confidence < 1, 'should not claim full confidence');
  assert.ok(
    set.challenges[0]!.requirements.some((r) => r.kind === 'unparsed'),
    'the unreadable line must be preserved, not dropped',
  );
});

test('an empty set page reports zero confidence, not perfect confidence', () => {
  const set = scraper.parseSet('<html><body></body></html>', { name: 'X', url: 'u' });
  assert.equal(set.challenges.length, 0);
  assert.equal(set.source.confidence, 0);
});

test('a failing set page degrades to an empty set rather than losing the run', async () => {
  let call = 0;
  const s = new SbcScraper({
    baseUrl: 'https://example.invalid/',
    minRequestGapMs: 0,
    selectors: { setList: '.sbc-set', setName: '.name', setLink: 'a', challengeList: '.challenge', challengeName: '.cname', requirementLine: 'li' },
    fetchImpl: (async (url: string) => {
      call++;
      if (call === 1) return new Response(INDEX_HTML, { status: 200 });
      // Second set page fails; the first should still come back intact.
      if (String(url).includes('marquee')) return new Response('nope', { status: 500 });
      return new Response(SET_HTML, { status: 200 });
    }) as unknown as typeof fetch,
  });

  const sets = await s.fetchSets('/', 5);
  assert.equal(sets.length, 2);
  assert.equal(sets[0]!.challenges.length, 2, 'the good set survives');
  assert.equal(sets[1]!.challenges.length, 0, 'the bad set is empty');
  assert.equal(sets[1]!.source.confidence, 0);
  assert.match(sets[1]!.description ?? '', /could not be read/i);
});
