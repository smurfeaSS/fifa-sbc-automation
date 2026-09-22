/**
 * Typed stores over the JSON files in ./data.
 *
 * Settings are merged over defaults on read, so adding a setting does not
 * invalidate an existing file.
 */

import { z } from 'zod';
import { readJson, writeJson, dataPath, listFiles } from './store.js';
import { clubSchema, sbcSetSchema } from '../shared/validation.js';
import { DEFAULT_SETTINGS } from '../solver/protection.js';
import type { Club, Settings } from '../shared/types/club.js';
import type { SbcSet } from '../shared/types/sbc.js';

const CLUB_FILE = () => dataPath('club.json');
const SETTINGS_FILE = () => dataPath('settings.json');
const HISTORY_FILE = () => dataPath('history.json');

export async function saveClub(club: Club): Promise<void> {
  await writeJson(CLUB_FILE(), club);
}

export async function loadClub(): Promise<Club | null> {
  return readJson(CLUB_FILE(), clubSchema as z.ZodType<Club>, 'club.json');
}

/** Loose schema: unknown keys are kept, known ones validated. */
const settingsSchema = z.record(z.unknown());

export async function loadSettings(): Promise<Settings> {
  const stored = await readJson(SETTINGS_FILE(), settingsSchema, 'settings.json');
  if (!stored) return structuredClone(DEFAULT_SETTINGS);
  // Deep-merge over defaults so a partial or older file still works.
  return {
    ...DEFAULT_SETTINGS,
    ...(stored as Partial<Settings>),
    protection: { ...DEFAULT_SETTINGS.protection, ...((stored as Partial<Settings>).protection ?? {}) },
    weights: { ...DEFAULT_SETTINGS.weights, ...((stored as Partial<Settings>).weights ?? {}) },
    sbcSources: { ...DEFAULT_SETTINGS.sbcSources, ...((stored as Partial<Settings>).sbcSources ?? {}) },
  };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await writeJson(SETTINGS_FILE(), settings);
}

/** One recorded SBC completion — automation.md §17. */
export interface HistoryEntry {
  id: string;
  sbcName: string;
  challengeName: string;
  date: string;
  playersSubmitted: number;
  /** Item ids, so a past decision can be reviewed against the current club. */
  playerIds: string[];
  estimatedValue: number;
  tradeableValue: number;
  untradeableValue: number;
  duplicatesUsed: number;
  notes?: string;
}

const historySchema = z.array(z.object({
  id: z.string(),
  sbcName: z.string(),
  challengeName: z.string(),
  date: z.string(),
  playersSubmitted: z.number(),
  playerIds: z.array(z.string()).default([]),
  estimatedValue: z.number(),
  tradeableValue: z.number(),
  untradeableValue: z.number(),
  duplicatesUsed: z.number(),
  notes: z.string().optional(),
}));

export async function loadHistory(): Promise<HistoryEntry[]> {
  return (await readJson(HISTORY_FILE(), historySchema as z.ZodType<HistoryEntry[]>, 'history.json')) ?? [];
}

export async function appendHistory(entry: HistoryEntry): Promise<void> {
  const history = await loadHistory();
  history.unshift(entry);
  await writeJson(HISTORY_FILE(), history);
}

/** User-authored and cached SBC definitions live under data/sbcs/. */
export async function loadLocalSbcs(): Promise<SbcSet[]> {
  const files = await listFiles(dataPath('sbcs'), '.json');
  const sets: SbcSet[] = [];
  for (const file of files) {
    const set = await readJson(file, sbcSetSchema as z.ZodType<SbcSet>, file);
    if (set) sets.push(set);
  }
  return sets;
}

export async function saveSbc(set: SbcSet): Promise<void> {
  const safeId = set.id.replace(/[^a-zA-Z0-9_-]/g, '_');
  await writeJson(dataPath('sbcs', `${safeId}.json`), set);
}
