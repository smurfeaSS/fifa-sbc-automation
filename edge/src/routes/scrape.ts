/**
 * Scraping endpoints.
 *
 * Split the same way solving is, and for the same reason: fetching is I/O and
 * costs no CPU, but HTMLRewriter parsing does, and parsing a dozen set pages in
 * one request would blow the 10ms budget. So the client drives it:
 *
 *   POST /api/scrape/index   — fetch the index, return the set stubs
 *   POST /api/scrape/page    — fetch and store ONE set
 *
 * This also keeps the subrequest count per request at one, well inside the
 * free-plan limit of 50, and gives the UI honest per-set progress.
 */

import { Hono } from 'hono'
import { getDb, schema } from '../lib/db'
import { loadSettings } from '../lib/settings'
import {
  parseIndexPage, parseSetPage, fetchPage, ScrapeError, assertSameHost,
  DEFAULT_SELECTORS, LIMITS, slug, type ScraperSelectors, type SetStub,
} from '../sbc/scraper'
import type { AppEnv } from '../types'

const app = new Hono<AppEnv>()

const USER_AGENT = 'fc27-sbc-assistant/1.0 (personal use; one user)'

function selectorsFrom(env: AppEnv['Bindings'], stored: unknown): ScraperSelectors {
  const overrides = (stored ?? {}) as Partial<ScraperSelectors>
  return { ...DEFAULT_SELECTORS, ...overrides }
}

app.post('/index', async (c) => {
  const settings = await loadSettings(c.env)
  const { scraperEnabled, scraperBaseUrl } = settings.sbcSources

  if (!scraperEnabled) {
    return c.json({ success: false, error: 'The SBC scraper is turned off. Enable it in Settings.', code: 'SCRAPER_DISABLED', requestId: c.get('requestId') }, 400)
  }
  if (!scraperBaseUrl) {
    return c.json({ success: false, error: 'No base URL is configured for the scraper.', code: 'NO_BASE_URL', requestId: c.get('requestId') }, 400)
  }

  const body = await c.req.json<{ path?: string }>().catch(() => ({ path: '/' }))
  const selectors = selectorsFrom(c.env, (settings.sbcSources as Record<string, unknown>)['selectors'])

  try {
    const indexUrl = new URL(body.path ?? '/', scraperBaseUrl).toString()
    assertSameHost(indexUrl, scraperBaseUrl)

    const res = await fetchPage(indexUrl, USER_AGENT)
    const stubs = await parseIndexPage(res, selectors, scraperBaseUrl)

    return c.json({
      success: true,
      data: {
        stubs,
        // Told plainly, because the usual cause of an empty result is that the
        // site's markup does not match the configured selectors.
        note: stubs.length === 0
          ? 'No SBC sets matched the configured selectors. Check them against the page source in Settings.'
          : null,
        limit: LIMITS.maxSets,
      },
      requestId: c.get('requestId'),
    })
  } catch (e) {
    const message = e instanceof ScrapeError ? e.message : `could not read the index page: ${String(e)}`
    return c.json({ success: false, error: message, code: 'SCRAPE_FAILED', requestId: c.get('requestId') }, 502)
  }
})

app.post('/page', async (c) => {
  const settings = await loadSettings(c.env)
  const { scraperEnabled, scraperBaseUrl } = settings.sbcSources

  if (!scraperEnabled) {
    return c.json({ success: false, error: 'The SBC scraper is turned off.', code: 'SCRAPER_DISABLED', requestId: c.get('requestId') }, 400)
  }

  const body = await c.req.json<{ stub?: SetStub }>().catch(() => null)
  if (!body?.stub?.url || !body.stub.name) {
    return c.json({ success: false, error: 'stub with name and url is required', code: 'BAD_REQUEST', requestId: c.get('requestId') }, 400)
  }

  const selectors = selectorsFrom(c.env, (settings.sbcSources as Record<string, unknown>)['selectors'])

  try {
    assertSameHost(body.stub.url, scraperBaseUrl)

    const res = await fetchPage(body.stub.url, USER_AGENT)
    const set = await parseSetPage(res, selectors, body.stub)

    const db = getDb(c.env)

    // A hand-corrected definition outranks a scrape. If you have fixed an SBC
    // yourself, a later scrape must not quietly overwrite the correction.
    const existing = await db.query.sbcs.findFirst({
      where: (t, { eq }) => eq(t.id, set.id),
    })
    if (existing && existing.sourceKind === 'manual') {
      return c.json({
        success: true,
        data: { id: set.id, name: set.name, skipped: true, reason: 'a manual definition for this SBC already exists' },
        requestId: c.get('requestId'),
      })
    }

    const json = JSON.stringify(set)
    const updatedAt = new Date().toISOString()
    await db
      .insert(schema.sbcs)
      .values({
        id: set.id, name: set.name, category: set.category ?? null, json,
        sourceKind: 'scraped', confidence: set.source.confidence, updatedAt,
      })
      .onConflictDoUpdate({
        target: schema.sbcs.id,
        set: { name: set.name, json, sourceKind: 'scraped', confidence: set.source.confidence, updatedAt },
      })

    return c.json({
      success: true,
      data: {
        id: set.id,
        name: set.name,
        challenges: set.challenges.length,
        confidence: set.source.confidence,
        skipped: false,
        // Surfaced per set so a partial parse is visible where it happened,
        // not averaged away across the whole scrape.
        warning: set.source.confidence < 1
          ? `Some requirement text could not be read. Check "${set.name}" against the game before building.`
          : null,
      },
      requestId: c.get('requestId'),
    })
  } catch (e) {
    const message = e instanceof ScrapeError ? e.message : `could not read that set: ${String(e)}`
    // One bad page must not abort the run — the client records it and moves on.
    return c.json({
      success: true,
      data: { id: slug(body.stub.name), name: body.stub.name, failed: true, message },
      requestId: c.get('requestId'),
    })
  }
})

export default app
