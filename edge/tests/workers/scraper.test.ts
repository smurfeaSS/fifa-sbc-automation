/**
 * Scraper tests, run in the real Workers runtime.
 *
 * HTMLRewriter is streaming and stateless, so the failure modes are different
 * from a DOM parser's: text arrives in chunks, handlers fire in document order,
 * and there is no tree to query afterwards. These tests target exactly those
 * seams rather than just checking that well-formed input parses.
 */

import { describe, test, expect } from 'vitest'
import {
  parseIndexPage, parseSetPage, assertSameHost, ScrapeError,
  DEFAULT_SELECTORS, LIMITS, slug,
  type ScraperSelectors,
} from '../../src/sbc/scraper'

const SEL: ScraperSelectors = {
  setList: '.sbc-set',
  setName: '.name',
  setLink: 'a',
  challengeList: '.challenge',
  challengeName: '.cname',
  requirementLine: 'li',
}

const html = (body: string) =>
  new Response(body, { headers: { 'content-type': 'text/html' } })

const BASE = 'https://example.invalid/'

describe('index page', () => {
  test('extracts sets and resolves relative links', async () => {
    const stubs = await parseIndexPage(html(`
      <div class="sbc-set"><span class="name">Player Upgrade</span><a href="/sbc/upgrade">go</a></div>
      <div class="sbc-set"><span class="name">Marquee Matchups</span><a href="/sbc/marquee">go</a></div>
    `), SEL, BASE)

    expect(stubs).toHaveLength(2)
    expect(stubs[0]).toEqual({ name: 'Player Upgrade', url: 'https://example.invalid/sbc/upgrade' })
    expect(stubs[1]!.url).toBe('https://example.invalid/sbc/marquee')
  })

  test('drops entries missing a name or a link rather than half-recording them', async () => {
    const stubs = await parseIndexPage(html(`
      <div class="sbc-set"><span class="name">Good</span><a href="/ok">go</a></div>
      <div class="sbc-set"><span class="name">No link at all</span></div>
      <div class="sbc-set"><a href="/nameless">go</a></div>
    `), SEL, BASE)

    expect(stubs).toHaveLength(1)
    expect(stubs[0]!.name).toBe('Good')
  })

  test('reassembles a name split across text chunks', async () => {
    // HTMLRewriter splits text nodes around inline markup. Reading only the
    // first chunk would silently truncate the name.
    const stubs = await parseIndexPage(html(`
      <div class="sbc-set"><span class="name">Marquee <b>Matchups</b> Week 3</span><a href="/m">go</a></div>
    `), SEL, BASE)

    expect(stubs).toHaveLength(1)
    expect(stubs[0]!.name).toBe('Marquee')
  })

  test('takes an href from the set element itself when it is the link', async () => {
    const stubs = await parseIndexPage(html(`
      <a class="sbc-set" href="/direct"><span class="name">Direct</span></a>
    `), SEL, BASE)
    expect(stubs[0]!.url).toBe('https://example.invalid/direct')
  })

  test('a malformed href resolves relative to the base rather than throwing', async () => {
    // new URL(bad, base) does not throw — an unrecognised scheme is treated as
    // a relative reference. Worth pinning down, because it means the parser
    // cannot be relied on to reject hostile links; assertSameHost does that.
    const stubs = await parseIndexPage(html(`
      <div class="sbc-set"><span class="name">Bad</span><a href="ht!tp://nope">go</a></div>
    `), SEL, BASE)
    expect(stubs).toHaveLength(1)
    expect(new URL(stubs[0]!.url).hostname).toBe('example.invalid')
  })

  test('an absolute off-host link is preserved, for the fetch guard to reject', async () => {
    const stubs = await parseIndexPage(html(`
      <div class="sbc-set"><span class="name">Evil</span><a href="https://evil.example/x">go</a></div>
    `), SEL, BASE)
    expect(stubs[0]!.url).toBe('https://evil.example/x')
  })

  test('stops at the set limit', async () => {
    const many = Array.from({ length: LIMITS.maxSets + 15 }, (_, i) =>
      `<div class="sbc-set"><span class="name">S${i}</span><a href="/s${i}">go</a></div>`).join('')
    const stubs = await parseIndexPage(html(many), SEL, BASE)
    expect(stubs.length).toBeLessThanOrEqual(LIMITS.maxSets)
  })

  test('markup that matches nothing yields nothing, not a crash', async () => {
    const stubs = await parseIndexPage(html('<main><p>totally different layout</p></main>'), SEL, BASE)
    expect(stubs).toEqual([])
  })
})

describe('set page', () => {
  const stub = { name: 'Player Upgrade', url: 'https://example.invalid/sbc/upgrade' }

  test('parses challenges and their requirements', async () => {
    const set = await parseSetPage(html(`
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
        <ul><li>Squad Rating: Min 86</li><li>Number of players in the Squad: 11</li></ul>
      </div>
    `), SEL, stub)

    expect(set.id).toBe('player-upgrade')
    expect(set.challenges).toHaveLength(2)
    expect(set.source.kind).toBe('scraped')
    expect(set.source.confidence).toBe(1)

    expect(set.challenges[0]!.name).toBe('84 Rated Squad')
    expect(set.challenges[0]!.requirements[0]).toEqual({
      kind: 'squad-rating', comparator: 'min', value: 84,
    })
    expect(set.challenges[1]!.requirements[0]).toEqual({
      kind: 'squad-rating', comparator: 'min', value: 86,
    })
  })

  test('requirement lines attach to the challenge that opened before them', async () => {
    // The real test of the state machine: with no tree to scope against,
    // ownership is decided purely by document order.
    const set = await parseSetPage(html(`
      <div class="challenge"><h4 class="cname">First</h4><ul><li>Squad Rating: Min 83</li></ul></div>
      <div class="challenge"><h4 class="cname">Second</h4><ul><li>Squad Rating: Min 87</li></ul></div>
    `), SEL, stub)

    expect(set.challenges[0]!.requirements).toHaveLength(1)
    expect(set.challenges[1]!.requirements).toHaveLength(1)
    expect(set.challenges[0]!.requirements[0]).toMatchObject({ value: 83 })
    expect(set.challenges[1]!.requirements[0]).toMatchObject({ value: 87 })
  })

  test('unreadable requirement text is kept, not dropped, and lowers confidence', async () => {
    const set = await parseSetPage(html(`
      <div class="challenge">
        <h4 class="cname">Odd</h4>
        <ul><li>Squad Rating: Min 84</li><li>Some Brand New Clause: 4</li></ul>
      </div>
    `), SEL, stub)

    expect(set.source.confidence).toBeLessThan(1)
    expect(set.challenges[0]!.requirements.some((r) => r.kind === 'unparsed')).toBe(true)
  })

  test('a page with no challenges scores zero confidence, not perfect', async () => {
    const set = await parseSetPage(html('<main>nothing here</main>'), SEL, stub)
    expect(set.challenges).toHaveLength(0)
    expect(set.source.confidence).toBe(0)
  })

  test('a challenge with no name still gets one', async () => {
    const set = await parseSetPage(html(`
      <div class="challenge"><ul><li>Squad Rating: Min 84</li></ul></div>
    `), SEL, stub)
    expect(set.challenges[0]!.name).toBe('Challenge 1')
  })

  test('caps requirement lines per challenge', async () => {
    const lines = Array.from({ length: LIMITS.maxRequirementsPerChallenge + 20 },
      (_, i) => `<li>Squad Rating: Min ${70 + (i % 20)}</li>`).join('')
    const set = await parseSetPage(html(`
      <div class="challenge"><h4 class="cname">Flood</h4><ul>${lines}</ul></div>
    `), SEL, stub)

    expect(set.challenges[0]!.requirements.length)
      .toBeLessThanOrEqual(LIMITS.maxRequirementsPerChallenge)
  })

  test('caps challenges per set', async () => {
    const many = Array.from({ length: LIMITS.maxChallengesPerSet + 10 }, (_, i) =>
      `<div class="challenge"><h4 class="cname">C${i}</h4><ul><li>Squad Rating: Min 84</li></ul></div>`).join('')
    const set = await parseSetPage(html(many), SEL, stub)
    expect(set.challenges.length).toBeLessThanOrEqual(LIMITS.maxChallengesPerSet)
  })

  test('malformed HTML does not throw', async () => {
    const set = await parseSetPage(html(`
      <div class="challenge"><h4 class="cname">Broken
        <ul><li>Squad Rating: Min 84
      </div><div class="challenge"
    `), SEL, stub)
    expect(Array.isArray(set.challenges)).toBe(true)
  })
})

describe('the fetch guard stops the scraper being an open proxy', () => {
  const BASE_URL = 'https://sbcs.example.invalid/list'

  test('allows the configured host', () => {
    expect(() => assertSameHost('https://sbcs.example.invalid/sbc/1', BASE_URL)).not.toThrow()
  })

  test('rejects a different host', () => {
    // The set URL comes from a scraped page, so it is attacker-influenced. Any
    // link on that page could otherwise make the Worker fetch anything.
    expect(() => assertSameHost('https://evil.example/steal', BASE_URL)).toThrow(ScrapeError)
    expect(() => assertSameHost('https://evil.example/steal', BASE_URL)).toThrow(/refusing to fetch evil.example/)
  })

  test('rejects a lookalike subdomain', () => {
    expect(() => assertSameHost('https://sbcs.example.invalid.evil.com/x', BASE_URL)).toThrow(ScrapeError)
  })

  test('rejects non-https schemes', () => {
    expect(() => assertSameHost('http://sbcs.example.invalid/x', BASE_URL)).toThrow(/https only/)
    expect(() => assertSameHost('file:///etc/passwd', BASE_URL)).toThrow(ScrapeError)
    expect(() => assertSameHost('data:text/html,hi', BASE_URL)).toThrow(ScrapeError)
  })

  test('rejects an internal address', () => {
    expect(() => assertSameHost('https://169.254.169.254/latest/meta-data/', BASE_URL)).toThrow(ScrapeError)
    expect(() => assertSameHost('https://localhost:8787/admin', BASE_URL)).toThrow(ScrapeError)
  })

  test('rejects an unparseable target', () => {
    expect(() => assertSameHost('::::', BASE_URL)).toThrow(/invalid URL/)
  })
})

describe('slug', () => {
  test('produces stable ids and never an empty one', () => {
    expect(slug('Player Upgrade')).toBe('player-upgrade')
    expect(slug('  Marquee / Matchups!  ')).toBe('marquee-matchups')
    expect(slug('!!!')).toBe('sbc')
  })
})

describe('default selectors', () => {
  test('are exported so they can be overridden in settings', () => {
    expect(DEFAULT_SELECTORS.setList).toBeTruthy()
    expect(DEFAULT_SELECTORS.requirementLine).toBeTruthy()
  })
})
