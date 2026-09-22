/**
 * SBC scraper, rebuilt on HTMLRewriter.
 *
 * The local build used cheerio, which CLAUDE.md §17 rules out: it parses the
 * whole document into a tree in memory, and "importing large libraries" plus
 * "heavy synchronous computation in handlers" are both named forbidden
 * patterns. HTMLRewriter is Cloudflare's native streaming parser — it costs no
 * bundle size, never materialises a DOM, and processes the response as it
 * arrives.
 *
 * The trade-off is that it is *streaming and stateless*. There is no
 * `node.find(child)` — you cannot scope a query inside a parent element,
 * because by the time a handler runs the parser has no tree to look at. So the
 * parsers below are small state machines driven by document order: an element
 * handler opens a record, the handlers for its descendants fill it in, and
 * `onEndTag` closes it.
 *
 * SAFETY AND MANNERS
 *   - Off unless `sbcSources.scraperEnabled` is set, with an explicit base URL.
 *   - Scraping is against most community sites' terms of service. If the site
 *     offers an API, use that instead.
 *   - Hard caps on sets, challenges, requirement lines and response size, so a
 *     hostile or merely enormous page cannot exhaust the CPU budget.
 *   - Everything that comes back is untrusted input: it goes through the same
 *     requirement parser as anything else, and whatever cannot be read is kept
 *     as `unparsed` rather than guessed at.
 */

import { parseRequirements } from '../lib/parseRequirements'
import type { SbcSet, Challenge } from '../shared/sbc'

export interface ScraperSelectors {
  /** One element per SBC set on the index page. */
  setList: string
  setName: string
  setLink: string
  /** One element per challenge on a set page. */
  challengeList: string
  challengeName: string
  /** Requirement lines inside a challenge. */
  requirementLine: string
}

/**
 * Starting-point selectors, written against a conventional listing layout.
 *
 * These are NOT calibrated against any live site — no site was available to
 * check them against. Expect to adjust them once, in settings, by looking at
 * the page source. They are configuration rather than code precisely because
 * markup changes are routine and not a bug to be fixed in a release.
 */
export const DEFAULT_SELECTORS: ScraperSelectors = {
  setList: '.sbc-set',
  setName: '.sbc-set-name',
  setLink: 'a',
  challengeList: '.sbc-challenge',
  challengeName: '.challenge-name',
  requirementLine: '.requirement',
}

/** Caps. Every one of these exists to bound CPU on a page we do not control. */
export const LIMITS = {
  maxSets: 40,
  maxChallengesPerSet: 30,
  maxRequirementsPerChallenge: 25,
  maxTextLength: 400,
  /** Abort a response larger than this rather than stream it all. */
  maxResponseBytes: 2_000_000,
  requestTimeoutMs: 12_000,
} as const

export interface SetStub {
  name: string
  url: string
}

/** Collapse whitespace and clip, so one runaway node cannot dominate. */
function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, LIMITS.maxTextLength)
}

/**
 * Accumulates text across chunks.
 *
 * HTMLRewriter delivers a text node in pieces and marks the final one with
 * `lastInTextNode`. Reading only the first chunk silently truncates any
 * requirement long enough to be split, which is exactly the sort of quiet
 * corruption the parser must not produce.
 */
class TextCollector {
  private buffer = ''

  add(chunk: { text: string; lastInTextNode: boolean }): string | null {
    this.buffer += chunk.text
    if (!chunk.lastInTextNode) return null
    const value = clean(this.buffer)
    this.buffer = ''
    return value.length > 0 ? value : null
  }

  reset(): void {
    this.buffer = ''
  }
}

// ─── index page ───────────────────────────────────────────────────────────────

/**
 * Parse an index page into name + URL stubs.
 *
 * State machine: `setList` opening starts a stub, the name and link handlers
 * fill it, and `onEndTag` commits it only if both arrived. An entry missing
 * either is dropped rather than half-recorded.
 */
export async function parseIndexPage(
  response: Response,
  selectors: ScraperSelectors,
  baseUrl: string,
): Promise<SetStub[]> {
  const stubs: SetStub[] = []
  let current: { name: string; href: string } | null = null
  const nameText = new TextCollector()

  const rewriter = new HTMLRewriter()
    .on(selectors.setList, {
      element(el) {
        if (stubs.length >= LIMITS.maxSets) return
        current = { name: '', href: el.getAttribute('href') ?? '' }
        nameText.reset()

        el.onEndTag(() => {
          if (!current) return
          const { name, href } = current
          current = null
          if (!name || !href) return
          try {
            stubs.push({ name, url: new URL(href, baseUrl).toString() })
          } catch {
            // A link we cannot resolve is not a set we can fetch.
          }
        })
      },
    })
    .on(`${selectors.setList} ${selectors.setName}`, {
      text(chunk) {
        const value = nameText.add(chunk)
        if (value && current && !current.name) current.name = value
      },
    })
    .on(`${selectors.setList} ${selectors.setLink}`, {
      element(el) {
        if (current && !current.href) current.href = el.getAttribute('href') ?? ''
      },
    })

  // Handlers only run as the body is consumed, so the stream must be drained.
  await drain(rewriter.transform(response))
  return stubs
}

// ─── set page ─────────────────────────────────────────────────────────────────

/**
 * Parse a set page into challenges with structured requirements.
 *
 * Requirement lines are collected per challenge in document order: whichever
 * challenge is currently open owns the lines that follow it.
 */
export async function parseSetPage(
  response: Response,
  selectors: ScraperSelectors,
  stub: SetStub,
): Promise<SbcSet> {
  interface Draft { name: string; lines: string[] }

  const drafts: Draft[] = []
  let current: Draft | null = null
  const nameText = new TextCollector()
  const lineText = new TextCollector()

  const rewriter = new HTMLRewriter()
    .on(selectors.challengeList, {
      element(el) {
        if (drafts.length >= LIMITS.maxChallengesPerSet) {
          current = null
          return
        }
        current = { name: '', lines: [] }
        drafts.push(current)
        nameText.reset()
        lineText.reset()
        el.onEndTag(() => {
          current = null
        })
      },
    })
    .on(`${selectors.challengeList} ${selectors.challengeName}`, {
      text(chunk) {
        const value = nameText.add(chunk)
        if (value && current && !current.name) current.name = value
      },
    })
    .on(`${selectors.challengeList} ${selectors.requirementLine}`, {
      text(chunk) {
        const value = lineText.add(chunk)
        if (!value || !current) return
        if (current.lines.length >= LIMITS.maxRequirementsPerChallenge) return
        current.lines.push(value)
      },
    })

  await drain(rewriter.transform(response))

  const challenges: Challenge[] = []
  let confidenceSum = 0

  drafts.forEach((draft, i) => {
    const parsed = parseRequirements(draft.lines)
    confidenceSum += parsed.confidence
    challenges.push({
      id: `${slug(stub.name)}-${i}`,
      name: draft.name || `Challenge ${i + 1}`,
      requirements: parsed.requirements,
    })
  })

  // A page we read no challenges from scores zero, not perfect confidence over
  // an empty list — "nothing to get wrong" is not the same as "understood".
  const confidence = challenges.length === 0 ? 0 : confidenceSum / challenges.length

  return {
    id: slug(stub.name),
    name: stub.name,
    challenges,
    source: {
      kind: 'scraped',
      origin: stub.url,
      fetchedAt: new Date().toISOString(),
      confidence,
    },
  }
}

// ─── fetching ─────────────────────────────────────────────────────────────────

export class ScrapeError extends Error {}

/**
 * Refuse to fetch anything that is not the configured site, over HTTPS.
 *
 * This is the guard that stops the scrape endpoints being an open proxy. A set
 * URL comes from a scraped page, so it is attacker-influenced input: without
 * this, a link on that page could make the Worker fetch any host — including
 * internal addresses — and return the result to whoever asked.
 *
 * Note that a malformed href does NOT throw during resolution: `new URL()` with
 * a base treats an unrecognised scheme as a relative path, so junk resolves to
 * a harmless same-host path. The real work here is rejecting a *valid* URL that
 * points somewhere else.
 */
export function assertSameHost(target: string, baseUrl: string): void {
  let url: URL
  let base: URL
  try {
    url = new URL(target)
    base = new URL(baseUrl)
  } catch {
    throw new ScrapeError('invalid URL')
  }

  if (url.protocol !== 'https:') {
    throw new ScrapeError(`refusing to fetch over ${url.protocol || 'an unknown protocol'}; https only`)
  }
  if (url.hostname !== base.hostname) {
    throw new ScrapeError(`refusing to fetch ${url.hostname}; the configured host is ${base.hostname}`)
  }
}

/**
 * Fetch a page, refusing anything that is not HTML or is implausibly large.
 *
 * The size check matters: HTMLRewriter streams, so a huge document will not
 * exhaust memory, but it will happily spend the entire CPU budget parsing.
 */
export async function fetchPage(url: string, userAgent: string): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), LIMITS.requestTimeoutMs)

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': userAgent, Accept: 'text/html' },
      redirect: 'follow',
    })

    if (!res.ok) throw new ScrapeError(`HTTP ${res.status} from ${url}`)

    const contentType = res.headers.get('content-type') ?? ''
    if (!contentType.includes('html')) {
      throw new ScrapeError(`expected HTML from ${url}, got ${contentType || 'no content-type'}`)
    }

    const declaredLength = Number(res.headers.get('content-length') ?? 0)
    if (declaredLength > LIMITS.maxResponseBytes) {
      throw new ScrapeError(`response from ${url} is ${declaredLength} bytes, over the limit`)
    }

    return res
  } finally {
    clearTimeout(timer)
  }
}

/** Consume a transformed stream so HTMLRewriter's handlers actually run. */
async function drain(response: Response): Promise<void> {
  const body = response.body
  if (!body) return

  const reader = body.getReader()
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value?.byteLength ?? 0
      if (total > LIMITS.maxResponseBytes) {
        // Stop reading rather than parse an unbounded document.
        await reader.cancel()
        throw new ScrapeError('response exceeded the size limit while streaming')
      }
    }
  } finally {
    reader.releaseLock()
  }
}

export function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'sbc'
}
