/**
 * Drizzle schema (CLAUDE.md §18 — Drizzle is the only ORM in this project).
 *
 * The shape here is driven by one requirement: never load the whole club into
 * a request. CLAUDE.md §17 forbids it and the 10ms CPU budget makes it
 * impossible anyway — parsing 1,800 players out of JSON would exhaust the
 * budget before the solver did any work.
 *
 * So protection state is *precomputed at import time* and stored as columns.
 * A solve then asks for the cheapest few players per rating band through an
 * index, reads a few hundred rows, and never sees the rest of the club.
 *
 * The cost of that choice: annotations go stale when protection settings
 * change, so changing settings triggers a re-annotate (see routes/settings.ts).
 */

import { sqliteTable, text, integer, real, index } from 'drizzle-orm/sqlite-core'

export const players = sqliteTable(
  'players',
  {
    /** EA item id — unique per physical card. */
    id: text('id').primaryKey(),
    /** EA asset id — shared by every card of the same footballer. */
    assetId: text('asset_id').notNull(),
    resourceId: text('resource_id'),

    name: text('name').notNull(),
    rating: integer('rating').notNull(),

    position: text('position').notNull(),
    positionGroup: text('position_group').notNull(),
    alternatePositions: text('alternate_positions').notNull().default('[]'),

    nationId: integer('nation_id').notNull().default(0),
    nationName: text('nation_name'),
    leagueId: integer('league_id').notNull().default(0),
    leagueName: text('league_name'),
    clubId: integer('club_id').notNull().default(0),
    clubName: text('club_name'),

    cardType: text('card_type').notNull(),
    rawRarityId: integer('raw_rarity_id'),

    tradeability: text('tradeability').notNull(),
    untradeableUntil: text('untradeable_until'),

    isDuplicate: integer('is_duplicate', { mode: 'boolean' }).notNull().default(false),
    duplicateCount: integer('duplicate_count').notNull().default(1),

    isEvolved: integer('is_evolved', { mode: 'boolean' }).notNull().default(false),
    evolutionPathId: text('evolution_path_id'),

    isFirstOwner: integer('is_first_owner', { mode: 'boolean' }).notNull().default(false),
    inActiveSquad: integer('in_active_squad', { mode: 'boolean' }).notNull().default(false),
    squadUsage: text('squad_usage').notNull().default('[]'),
    contracts: integer('contracts'),

    valueCoins: integer('value_coins').notNull().default(0),
    valueSource: text('value_source').notNull().default('heuristic'),
    valueConfidence: real('value_confidence').notNull().default(0.3),

    manuallyLocked: integer('manually_locked', { mode: 'boolean' }).notNull().default(false),
    isFavourite: integer('is_favourite', { mode: 'boolean' }).notNull().default(false),
    note: text('note'),

    // ─── Precomputed annotation ───────────────────────────────────────────
    // Written at import and whenever protection settings change. Reading these
    // instead of recomputing is what keeps a solve inside the CPU budget.
    isProtected: integer('is_protected', { mode: 'boolean' }).notNull().default(false),
    protectionReasons: text('protection_reasons').notNull().default('[]'),
    /**
     * REAL, not INTEGER: the solver's Infinity for a protected card cannot be
     * stored, so protected rows carry a large finite sentinel and are excluded
     * by the is_protected filter rather than by their cost.
     */
    sacrificeCost: real('sacrifice_cost').notNull().default(0),
    priorityTier: integer('priority_tier').notNull().default(6),

    importedAt: text('imported_at').notNull(),
  },
  (t) => ({
    /**
     * The candidate-pool index. A solve runs
     *   WHERE is_protected = 0 ORDER BY rating, sacrifice_cost
     * and takes the cheapest few per rating, so this exact composite is what
     * keeps that query off a full table scan.
     */
    poolIdx: index('players_pool_idx').on(t.isProtected, t.rating, t.sacrificeCost),
    assetIdx: index('players_asset_idx').on(t.assetId),
    ratingIdx: index('players_rating_idx').on(t.rating),
    nameIdx: index('players_name_idx').on(t.name),
  }),
)

export const squads = sqliteTable('squads', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  formation: text('formation'),
  playerIds: text('player_ids').notNull().default('[]'),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(false),
})

/** Single-row table holding the club-level metadata from the export. */
export const clubMeta = sqliteTable('club_meta', {
  id: integer('id').primaryKey(),
  exportedAt: text('exported_at').notNull(),
  gameVersion: text('game_version').notNull(),
  playerCount: integer('player_count').notNull().default(0),
  /** True while a chunked import is still in progress. */
  importInProgress: integer('import_in_progress', { mode: 'boolean' }).notNull().default(false),
  importToken: text('import_token'),
})

/** Settings stored as one JSON row — small, read whole, never queried into. */
export const settings = sqliteTable('settings', {
  id: integer('id').primaryKey(),
  json: text('json').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const sbcs = sqliteTable('sbcs', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  category: text('category'),
  /** Full SbcSet as JSON — challenges are read together or not at all. */
  json: text('json').notNull(),
  sourceKind: text('source_kind').notNull().default('manual'),
  confidence: real('confidence').notNull().default(1),
  updatedAt: text('updated_at').notNull(),
})

export const history = sqliteTable(
  'history',
  {
    id: text('id').primaryKey(),
    sbcName: text('sbc_name').notNull(),
    challengeName: text('challenge_name').notNull(),
    date: text('date').notNull(),
    playersSubmitted: integer('players_submitted').notNull().default(0),
    playerIds: text('player_ids').notNull().default('[]'),
    estimatedValue: integer('estimated_value').notNull().default(0),
    tradeableValue: integer('tradeable_value').notNull().default(0),
    untradeableValue: integer('untradeable_value').notNull().default(0),
    duplicatesUsed: integer('duplicates_used').notNull().default(0),
    notes: text('notes'),
  },
  (t) => ({ dateIdx: index('history_date_idx').on(t.date) }),
)

export type PlayerRow = typeof players.$inferSelect
export type NewPlayerRow = typeof players.$inferInsert
