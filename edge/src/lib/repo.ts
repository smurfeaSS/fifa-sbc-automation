/**
 * Data access. Everything that touches players goes through here, so the
 * bounded-read rule from CLAUDE.md §17 is enforced in one place.
 */

import { eq, and, gte, lte, like, asc, desc, sql, inArray, count } from 'drizzle-orm'
import { getDb, schema } from './db'
import type { Bindings } from '../types'
import type { AnnotatedPlayer, ValueSource } from '../shared/player'
import type { PlayerRow } from './schema'

/** Absolute cap on rows any single query may return (CLAUDE.md §17). */
export const MAX_ROWS = 100

/**
 * Cheapest candidates to fetch per rating band.
 *
 * The solver only ever uses the cheapest few players at any given rating —
 * everything beyond that is dominated and can never appear in an optimal
 * squad. Twelve covers a full squad from one band plus headroom for the
 * constraint-repair pass to find same-rating swaps.
 */
export const CANDIDATES_PER_RATING = 12

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** DB row -> the shape the solver expects. */
export function rowToAnnotated(row: PlayerRow): AnnotatedPlayer {
  return {
    id: row.id,
    assetId: row.assetId,
    resourceId: row.resourceId ?? undefined,
    name: row.name,
    rating: row.rating,
    position: {
      primary: row.position,
      alternates: parseJsonArray(row.alternatePositions),
      group: row.positionGroup as AnnotatedPlayer['position']['group'],
    },
    nationId: row.nationId,
    nationName: row.nationName ?? undefined,
    leagueId: row.leagueId,
    leagueName: row.leagueName ?? undefined,
    clubId: row.clubId,
    clubName: row.clubName ?? undefined,
    cardType: row.cardType as AnnotatedPlayer['cardType'],
    rawRarityId: row.rawRarityId ?? undefined,
    tradeability: row.tradeability as AnnotatedPlayer['tradeability'],
    untradeableUntil: row.untradeableUntil ?? undefined,
    isDuplicate: row.isDuplicate,
    duplicateCount: row.duplicateCount,
    evolution: {
      isEvolved: row.isEvolved,
      pathId: row.evolutionPathId ?? undefined,
    },
    isFirstOwner: row.isFirstOwner,
    squadUsage: parseJsonArray(row.squadUsage),
    inActiveSquad: row.inActiveSquad,
    contracts: row.contracts ?? undefined,
    value: {
      coins: row.valueCoins,
      source: row.valueSource as ValueSource,
      asOf: row.importedAt,
      confidence: row.valueConfidence,
    },
    manuallyLocked: row.manuallyLocked,
    isFavourite: row.isFavourite,
    note: row.note ?? undefined,
    isProtected: row.isProtected,
    protectionReasons: parseJsonArray(row.protectionReasons),
    sacrificeCost: row.sacrificeCost,
    priorityTier: row.priorityTier,
  }
}

/** Player + annotation -> DB row. */
export function annotatedToRow(p: AnnotatedPlayer, importedAt: string): PlayerRow {
  return {
    id: p.id,
    assetId: p.assetId,
    resourceId: p.resourceId ?? null,
    name: p.name,
    rating: p.rating,
    position: p.position.primary,
    positionGroup: p.position.group,
    alternatePositions: JSON.stringify(p.position.alternates),
    nationId: p.nationId,
    nationName: p.nationName ?? null,
    leagueId: p.leagueId,
    leagueName: p.leagueName ?? null,
    clubId: p.clubId,
    clubName: p.clubName ?? null,
    cardType: p.cardType,
    rawRarityId: p.rawRarityId ?? null,
    tradeability: p.tradeability,
    untradeableUntil: p.untradeableUntil ?? null,
    isDuplicate: p.isDuplicate,
    duplicateCount: p.duplicateCount,
    isEvolved: p.evolution.isEvolved,
    evolutionPathId: p.evolution.pathId ?? null,
    isFirstOwner: p.isFirstOwner,
    inActiveSquad: p.inActiveSquad,
    squadUsage: JSON.stringify(p.squadUsage),
    contracts: p.contracts ?? null,
    valueCoins: Math.round(p.value?.coins ?? 0),
    valueSource: p.value?.source ?? 'heuristic',
    valueConfidence: p.value?.confidence ?? 0.3,
    manuallyLocked: p.manuallyLocked,
    isFavourite: p.isFavourite,
    note: p.note ?? null,
    isProtected: p.isProtected,
    protectionReasons: JSON.stringify(p.protectionReasons),
    // Infinity cannot round-trip through SQLite. Protected rows are excluded
    // by the is_protected flag, never by comparing this number, so a sentinel
    // is safe — but it must not be Infinity or the row fails to insert.
    sacrificeCost: Number.isFinite(p.sacrificeCost) ? p.sacrificeCost : 1e15,
    priorityTier: p.priorityTier,
    importedAt,
  }
}

/**
 * The candidate pool for a solve.
 *
 * Returns only the cheapest CANDIDATES_PER_RATING unprotected players at each
 * rating within the requested band. For a typical 84-rated SBC that is a few
 * hundred rows rather than the whole club, which is the difference between
 * fitting the CPU budget and an Error 1102.
 *
 * Uses a window function — D1 is SQLite 3.4x and supports ROW_NUMBER(), so the
 * per-rating limit happens in the database rather than by over-fetching.
 */
export async function candidatePool(
  env: Bindings,
  opts: { minRating: number; maxRating: number; excludeIds?: readonly string[] },
): Promise<AnnotatedPlayer[]> {
  const db = getDb(env)
  const exclude = opts.excludeIds ?? []

  // Drizzle has no first-class window-function builder, so this one query is
  // written with sql`` — still fully parameterised, never interpolated.
  const rows = await db.all<PlayerRow>(sql`
    SELECT * FROM (
      SELECT *, ROW_NUMBER() OVER (
        PARTITION BY rating ORDER BY sacrifice_cost ASC
      ) AS rn
      FROM players
      WHERE is_protected = 0
        AND rating >= ${opts.minRating}
        AND rating <= ${opts.maxRating}
        ${exclude.length > 0
          ? sql`AND id NOT IN (${sql.join(exclude.map((id) => sql`${id}`), sql`, `)})`
          : sql``}
    )
    WHERE rn <= ${CANDIDATES_PER_RATING}
    ORDER BY rating DESC, sacrifice_cost ASC
  `)

  return rows.map(rowToAnnotated)
}

/** Ratings present in the unprotected pool, with counts. Cheap, indexed. */
export async function ratingHistogram(
  env: Bindings,
): Promise<Array<{ rating: number; n: number }>> {
  const db = getDb(env)
  const rows = await db.all<{ rating: number; n: number }>(sql`
    SELECT rating, COUNT(*) AS n
    FROM players
    WHERE is_protected = 0
    GROUP BY rating
    ORDER BY rating DESC
  `)
  return rows
}

export interface SearchFilters {
  name?: string
  minRating?: number
  maxRating?: number
  cardType?: string
  tradeability?: 'tradeable' | 'untradeable'
  duplicatesOnly?: boolean
  protectedOnly?: boolean
  unprotectedOnly?: boolean
  limit?: number
  offset?: number
}

export async function searchPlayers(
  env: Bindings,
  f: SearchFilters,
): Promise<{ total: number; rows: PlayerRow[] }> {
  const db = getDb(env)
  const conditions = []

  if (f.name) conditions.push(like(schema.players.name, `%${f.name}%`))
  if (f.minRating !== undefined) conditions.push(gte(schema.players.rating, f.minRating))
  if (f.maxRating !== undefined) conditions.push(lte(schema.players.rating, f.maxRating))
  if (f.cardType) conditions.push(eq(schema.players.cardType, f.cardType))
  if (f.tradeability) conditions.push(eq(schema.players.tradeability, f.tradeability))
  if (f.duplicatesOnly) conditions.push(eq(schema.players.isDuplicate, true))
  if (f.protectedOnly) conditions.push(eq(schema.players.isProtected, true))
  if (f.unprotectedOnly) conditions.push(eq(schema.players.isProtected, false))

  const where = conditions.length > 0 ? and(...conditions) : undefined

  const countRows = await db
    .select({ total: count() })
    .from(schema.players)
    .where(where)
  const total = countRows[0]?.total ?? 0

  const rows = await db
    .select()
    .from(schema.players)
    .where(where)
    .orderBy(desc(schema.players.rating), asc(schema.players.sacrificeCost))
    .limit(Math.min(f.limit ?? 50, MAX_ROWS))
    .offset(f.offset ?? 0)

  return { total, rows }
}

export async function playersByIds(env: Bindings, ids: readonly string[]): Promise<PlayerRow[]> {
  if (ids.length === 0) return []
  const db = getDb(env)
  return db
    .select()
    .from(schema.players)
    .where(inArray(schema.players.id, ids.slice(0, MAX_ROWS) as string[]))
}
