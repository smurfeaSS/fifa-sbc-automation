/**
 * Settings, cached per isolate.
 *
 * Read on nearly every request, so it is worth not paying a D1 round trip each
 * time. The cache is invalidated explicitly on write; a stale isolate is not a
 * correctness problem for reads, but it would be for protection, so writes bump
 * a version that annotation checks against.
 */

import { eq } from 'drizzle-orm'
import { getDb, schema } from './db'
import { DEFAULT_SETTINGS } from '../solver/protection'
import type { Settings } from '../shared/club'
import type { Bindings } from '../types'

let _cached: { settings: Settings; at: number } | null = null
const CACHE_MS = 5_000

function merge(stored: Partial<Settings>): Settings {
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    protection: { ...DEFAULT_SETTINGS.protection, ...(stored.protection ?? {}) },
    weights: { ...DEFAULT_SETTINGS.weights, ...(stored.weights ?? {}) },
    sbcSources: { ...DEFAULT_SETTINGS.sbcSources, ...(stored.sbcSources ?? {}) },
  }
}

export async function loadSettings(env: Bindings): Promise<Settings> {
  if (_cached && Date.now() - _cached.at < CACHE_MS) return _cached.settings

  const db = getDb(env)
  const row = await db.select().from(schema.settings).where(eq(schema.settings.id, 1)).get()

  let settings: Settings
  if (!row) {
    settings = structuredClone(DEFAULT_SETTINGS)
  } else {
    try {
      settings = merge(JSON.parse(row.json) as Partial<Settings>)
    } catch {
      // A corrupt settings row must not lock you out of your own club.
      console.error('[settings] stored JSON is unreadable, falling back to defaults')
      settings = structuredClone(DEFAULT_SETTINGS)
    }
  }

  _cached = { settings, at: Date.now() }
  return settings
}

export async function saveSettings(env: Bindings, settings: Settings): Promise<void> {
  const db = getDb(env)
  const json = JSON.stringify(settings)
  const updatedAt = new Date().toISOString()
  await db
    .insert(schema.settings)
    .values({ id: 1, json, updatedAt })
    .onConflictDoUpdate({ target: schema.settings.id, set: { json, updatedAt } })
  _cached = null
}

export function invalidateSettingsCache(): void {
  _cached = null
}
