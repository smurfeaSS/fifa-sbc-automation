/**
 * SBC source registry.
 *
 * Merges hand-written local definitions with scraped ones, caches scrapes, and
 * keeps local definitions authoritative — if you have corrected an SBC by hand,
 * a scrape must not silently overwrite your correction.
 */

import { existsSync } from 'node:fs';
import { statSync } from 'node:fs';
import { z } from 'zod';
import { SbcScraper } from './sources/scraper.js';
import { loadLocalSbcs, saveSbc } from '../storage/index.js';
import { readJson, writeJson, dataPath } from '../storage/store.js';
import { sbcSetSchema } from '../shared/validation.js';
import type { SbcSet } from '../shared/types/sbc.js';
import type { Settings } from '../shared/types/club.js';

const CACHE_FILE = () => dataPath('cache', 'scraped-sbcs.json');

const cacheSchema = z.object({
  fetchedAt: z.string(),
  sets: z.array(sbcSetSchema),
});

type Cache = { fetchedAt: string; sets: SbcSet[] };

function cacheIsFresh(ttlMinutes: number): boolean {
  const file = CACHE_FILE();
  if (!existsSync(file)) return false;
  const ageMs = Date.now() - statSync(file).mtimeMs;
  return ageMs < ttlMinutes * 60_000;
}

export interface SbcListing {
  sets: SbcSet[];
  /** Notes worth showing the user, e.g. that the scrape failed. */
  notices: string[];
}

/**
 * All SBCs available to the solver.
 *
 * Local definitions always win on id collision: a scrape is a convenience, a
 * hand-written file is a deliberate statement about what the SBC requires.
 */
export async function listSbcs(settings: Settings, opts: { refresh?: boolean } = {}): Promise<SbcListing> {
  const notices: string[] = [];
  const local = await loadLocalSbcs();

  let scraped: SbcSet[] = [];
  if (settings.sbcSources.scraperEnabled) {
    if (!settings.sbcSources.scraperBaseUrl) {
      notices.push('Scraper is enabled but no base URL is set — using local SBCs only.');
    } else {
      try {
        scraped = await getScraped(settings, opts.refresh ?? false);
      } catch (e) {
        notices.push(
          `Could not fetch SBCs from ${settings.sbcSources.scraperBaseUrl}: ${(e as Error).message}. ` +
          `Showing local SBCs only.`,
        );
      }
    }
  }

  const byId = new Map<string, SbcSet>();
  for (const set of scraped) byId.set(set.id, set);
  for (const set of local) byId.set(set.id, set); // local wins

  const sets = [...byId.values()];

  const lowConfidence = sets.filter((s) => s.source.kind === 'scraped' && s.source.confidence < 0.8);
  if (lowConfidence.length > 0) {
    notices.push(
      `${lowConfidence.length} scraped SBC(s) have requirements that could not be fully read. ` +
      `Check them against the game before building.`,
    );
  }

  return { sets, notices };
}

async function getScraped(settings: Settings, refresh: boolean): Promise<SbcSet[]> {
  const ttl = settings.sbcSources.cacheTtlMinutes;
  if (!refresh && cacheIsFresh(ttl)) {
    const cached = await readJson(CACHE_FILE(), cacheSchema as z.ZodType<Cache>, 'SBC cache');
    if (cached) return cached.sets;
  }

  const scraper = new SbcScraper({ baseUrl: settings.sbcSources.scraperBaseUrl });
  const sets = await scraper.fetchSets();
  await writeJson(CACHE_FILE(), { fetchedAt: new Date().toISOString(), sets } satisfies Cache);
  return sets;
}

/** Persist a hand-written or hand-corrected SBC so it takes precedence. */
export async function saveManualSbc(set: SbcSet): Promise<void> {
  await saveSbc({ ...set, source: { ...set.source, kind: 'manual' } });
}
