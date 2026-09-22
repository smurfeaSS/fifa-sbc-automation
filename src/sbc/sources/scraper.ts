/**
 * Community-site SBC scraper — automation.md §4.
 *
 * OFF BY DEFAULT. Enable with `sbcSources.scraperEnabled` and set a base URL.
 *
 * Read this before turning it on:
 *
 *  - Scraping is against most community sites' terms of service. They pay for
 *    the bandwidth and the people who maintain the data. If one offers an API,
 *    use that instead; if you rely on a site, consider supporting it.
 *  - It breaks. Sites change markup without notice, and this is structural: no
 *    amount of care makes a scraper durable. Selectors are configurable below
 *    so a break is a config change rather than a code change, and a failed
 *    scrape degrades to "no SBCs found" rather than to wrong requirements.
 *  - It is cached and rate-limited, so a session hits the site a handful of
 *    times, not once per query.
 *
 * Whatever comes back is untrusted input: requirement text goes through the
 * same parser as everything else, anything unrecognised is preserved as
 * `unparsed`, and a set's confidence reflects how much was actually understood.
 * The dashboard warns before solving against a low-confidence set.
 */

import * as cheerio from 'cheerio';
import { parseRequirements } from '../parseRequirements.js';
import type { SbcSet, Challenge } from '../../shared/types/sbc.js';

export interface ScraperSelectors {
  /** Elements on the index page, one per SBC set. */
  setList: string;
  setName: string;
  setLink: string;
  setCategory?: string;
  setExpiry?: string;
  /** Elements on a set page, one per challenge. */
  challengeList: string;
  challengeName: string;
  /** Requirement lines within a challenge. */
  requirementLine: string;
  rewardText?: string;
}

/**
 * Default selectors, written against a conventional SBC-listing layout.
 * Treat these as a starting point to adjust, not as known-good values — they
 * are not calibrated against any live site.
 */
export const DEFAULT_SELECTORS: ScraperSelectors = {
  setList: '.sbc-set, [class*="sbc-card"]',
  setName: '.sbc-set-name, h2, h3',
  setLink: 'a',
  setCategory: '.sbc-category',
  setExpiry: '.sbc-expiry, [class*="expire"]',
  challengeList: '.sbc-challenge, [class*="challenge"]',
  challengeName: '.challenge-name, h4',
  requirementLine: '.requirement, li',
  rewardText: '.reward, [class*="reward"]',
};

export interface ScraperConfig {
  baseUrl: string;
  selectors?: Partial<ScraperSelectors>;
  /** Minimum gap between requests. Be a considerate client. */
  minRequestGapMs?: number;
  /** Abort a single request after this long. */
  timeoutMs?: number;
  userAgent?: string;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Serialises requests and keeps a courteous gap between them. */
class Throttle {
  private last = 0;
  constructor(private readonly gapMs: number) {}
  async wait(): Promise<void> {
    const since = Date.now() - this.last;
    if (since < this.gapMs) await sleep(this.gapMs - since);
    this.last = Date.now();
  }
}

export class SbcScraper {
  private readonly selectors: ScraperSelectors;
  private readonly throttle: Throttle;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor(private readonly config: ScraperConfig) {
    this.selectors = { ...DEFAULT_SELECTORS, ...(config.selectors ?? {}) };
    this.throttle = new Throttle(config.minRequestGapMs ?? 2000);
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 15_000;
    this.userAgent = config.userAgent ?? 'fc-sbc-assistant/0.1 (personal use)';
  }

  private async get(url: string): Promise<string> {
    await this.throttle.wait();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        signal: controller.signal,
        headers: { 'User-Agent': this.userAgent, Accept: 'text/html' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  }

  /** Parse an index page into stub sets (name + link, no challenges yet). */
  parseIndex(html: string): Array<{ name: string; url: string; category?: string; expiresAt?: string }> {
    const $ = cheerio.load(html);
    const out: Array<{ name: string; url: string; category?: string; expiresAt?: string }> = [];

    $(this.selectors.setList).each((_, el) => {
      const node = $(el);
      const name = node.find(this.selectors.setName).first().text().trim()
        || node.attr('data-name')?.trim()
        || '';
      const href = node.find(this.selectors.setLink).first().attr('href')
        ?? node.attr('href');
      if (!name || !href) return;

      const url = href.startsWith('http') ? href : new URL(href, this.config.baseUrl).toString();
      const category = this.selectors.setCategory
        ? node.find(this.selectors.setCategory).first().text().trim() || undefined
        : undefined;
      const expiresAt = this.selectors.setExpiry
        ? node.find(this.selectors.setExpiry).first().text().trim() || undefined
        : undefined;

      out.push({ name, url, ...(category ? { category } : {}), ...(expiresAt ? { expiresAt } : {}) });
    });

    return out;
  }

  /** Parse a set page into a full SbcSet. */
  parseSet(
    html: string,
    stub: { name: string; url: string; category?: string; expiresAt?: string },
  ): SbcSet {
    const $ = cheerio.load(html);
    const challenges: Challenge[] = [];
    let totalConfidence = 0;

    $(this.selectors.challengeList).each((i, el) => {
      const node = $(el);
      const name = node.find(this.selectors.challengeName).first().text().trim() || `Challenge ${i + 1}`;

      const lines: string[] = [];
      node.find(this.selectors.requirementLine).each((_, li) => {
        const text = $(li).text().replace(/\s+/g, ' ').trim();
        if (text) lines.push(text);
      });

      const parsed = parseRequirements(lines);
      totalConfidence += parsed.confidence;

      const rewardText = this.selectors.rewardText
        ? node.find(this.selectors.rewardText).first().text().trim()
        : '';

      challenges.push({
        id: `${slug(stub.name)}-${i}`,
        name,
        requirements: parsed.requirements,
        ...(rewardText ? { reward: { description: rewardText } } : {}),
      });
    });

    // A set we read no challenges from is zero confidence, not perfect
    // confidence over an empty list.
    const confidence = challenges.length === 0 ? 0 : totalConfidence / challenges.length;

    return {
      id: slug(stub.name),
      name: stub.name,
      ...(stub.category ? { category: stub.category } : {}),
      ...(stub.expiresAt ? { expiresAt: stub.expiresAt } : {}),
      challenges,
      source: {
        kind: 'scraped',
        origin: stub.url,
        fetchedAt: new Date().toISOString(),
        confidence,
      },
    };
  }

  /**
   * Fetch the index and then each set.
   *
   * `limit` caps how many set pages are fetched, so enabling the scraper never
   * turns into a crawl of the whole site.
   */
  async fetchSets(indexPath = '/', limit = 20): Promise<SbcSet[]> {
    const indexUrl = new URL(indexPath, this.config.baseUrl).toString();
    const indexHtml = await this.get(indexUrl);
    const stubs = this.parseIndex(indexHtml).slice(0, limit);

    const sets: SbcSet[] = [];
    for (const stub of stubs) {
      try {
        const html = await this.get(stub.url);
        sets.push(this.parseSet(html, stub));
      } catch (e) {
        // One bad page must not lose the rest. A missing set is visible in the
        // UI; a silently wrong set is not.
        sets.push({
          id: slug(stub.name),
          name: stub.name,
          challenges: [],
          source: {
            kind: 'scraped',
            origin: stub.url,
            fetchedAt: new Date().toISOString(),
            confidence: 0,
          },
          description: `Could not be read: ${(e as Error).message}`,
        });
      }
    }
    return sets;
  }
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'sbc';
}
