/**
 * Turning "you need an 86" into something you can act on — automation.md §15.
 *
 * Two levels of answer, best first:
 *
 *  1. If the price table has rows at that rating, name the cheapest actual
 *     cards, with prices.
 *  2. Otherwise, emit the exact Web App transfer-search filters to type in.
 *     §15 is explicit that a generic requirement beats naming a specific
 *     footballer you then have to hunt for, and the filter list is what turns
 *     a generic requirement into a ten-second search.
 *
 * Note what this does NOT do: query the live transfer market. Searching
 * listings by criteria in a loop is the sniping pattern, it is the riskiest
 * possible interaction with EA, and automation.md §23 rules it out. Prices come
 * from a list you import, not from the market.
 */

import { sql } from 'drizzle-orm'
import { getDb } from './db'
import type { Bindings } from '../types'
import type { PriceRow } from './schema'
import type { MissingPlayer } from '../solver/squadSolver'
import type { Requirement } from '../shared/sbc'

/** Filters as the Web App's transfer search presents them. */
export interface SearchFilters {
  quality: 'Gold' | 'Silver' | 'Bronze'
  rarity: 'Rare' | 'Common' | 'Any'
  minRating: number
  maxRating: number
  position?: string
  nation?: string
  league?: string
  club?: string
  /** What to set "Max Buy Now" to, so you do not overpay. */
  maxBuyNow: number
}

export interface PurchaseSuggestion {
  rating: number
  estimatedCost: number
  /** Plain description, e.g. "86 rated, gold rare, under ~9,600 coins". */
  description: string
  /** Type these into the Web App transfer search. */
  filters: SearchFilters
  /** Real cards from the price list, cheapest first. Empty when none known. */
  options: Array<{
    name: string
    rating: number
    priceCoins: number
    clubName: string | null
    nationName: string | null
    leagueName: string | null
    position: string | null
    rarity: string
    updatedAt: string
  }>
  /** True when `options` is empty because no prices have been imported. */
  noPriceData: boolean
}

function qualityFor(rating: number): SearchFilters['quality'] {
  if (rating >= 75) return 'Gold'
  if (rating >= 65) return 'Silver'
  return 'Bronze'
}

/**
 * Constraints the SBC forces on a bought card.
 *
 * Only constraints a *purchase* could help satisfy are carried through. A
 * squad-rating requirement is already reflected in the rating being asked for,
 * so repeating it as a filter would just be noise.
 */
function constraintsFromRequirements(requirements: readonly Requirement[]): Partial<SearchFilters> {
  const out: Partial<SearchFilters> = {}
  for (const req of requirements) {
    switch (req.kind) {
      case 'rare-count':
        if (req.comparator !== 'max') out.rarity = 'Rare'
        break
      case 'nation-count':
        if (req.comparator !== 'max' && req.nationName) out.nation = req.nationName
        break
      case 'league-count':
        if (req.comparator !== 'max' && req.leagueName) out.league = req.leagueName
        break
      case 'club-count':
        if (req.comparator !== 'max' && req.clubName) out.club = req.clubName
        break
      default:
        break
    }
  }
  return out
}

/**
 * Build a suggestion for one missing card.
 *
 * The max-buy-now figure is set slightly above the estimate rather than at it:
 * search with a cap exactly on the estimate and a market that has moved even
 * slightly returns nothing at all, which reads as "unavailable" when it is not.
 */
export async function suggestPurchase(
  env: Bindings,
  missing: MissingPlayer,
  requirements: readonly Requirement[],
): Promise<PurchaseSuggestion> {
  const constraints = constraintsFromRequirements(requirements)
  const maxBuyNow = Math.max(250, Math.round(missing.estimatedCost * 1.2))

  const filters: SearchFilters = {
    quality: qualityFor(missing.rating),
    rarity: constraints.rarity ?? 'Any',
    // An exact-rating search is what you want: a lower card will not lift the
    // squad rating, and a higher one costs more than the SBC needs.
    minRating: missing.rating,
    maxRating: missing.rating,
    maxBuyNow,
    ...(constraints.nation ? { nation: constraints.nation } : {}),
    ...(constraints.league ? { league: constraints.league } : {}),
    ...(constraints.club ? { club: constraints.club } : {}),
  }

  const db = getDb(env)
  const rows = await db.all<PriceRow>(sql`
    SELECT * FROM prices
    WHERE rating = ${missing.rating}
      ${constraints.rarity === 'Rare' ? sql`AND rarity = 'rare'` : sql``}
      ${constraints.nation ? sql`AND nation_name = ${constraints.nation}` : sql``}
      ${constraints.league ? sql`AND league_name = ${constraints.league}` : sql``}
      ${constraints.club ? sql`AND club_name = ${constraints.club}` : sql``}
    ORDER BY price_coins ASC
    LIMIT 5
  `)

  const options = rows.map((r) => ({
    name: r.name ?? `${r.rating} rated`,
    rating: r.rating,
    priceCoins: r.priceCoins,
    clubName: r.clubName,
    nationName: r.nationName,
    leagueName: r.leagueName,
    position: r.position,
    rarity: r.rarity,
    updatedAt: r.updatedAt,
  }))

  const parts = [`${missing.rating} rated`]
  if (filters.rarity !== 'Any') parts.push(filters.rarity.toLowerCase())
  if (filters.nation) parts.push(`from ${filters.nation}`)
  if (filters.league) parts.push(`in the ${filters.league}`)
  if (filters.club) parts.push(`at ${filters.club}`)

  // Prefer a real observed price over the rating-curve estimate when we have one.
  const cheapest = options[0]?.priceCoins
  const headline = cheapest ?? missing.estimatedCost

  return {
    rating: missing.rating,
    estimatedCost: headline,
    description: `${parts.join(', ')} — ${cheapest ? '' : 'around '}${headline.toLocaleString()} coins`,
    filters,
    options,
    noPriceData: options.length === 0,
  }
}

export async function suggestPurchases(
  env: Bindings,
  missing: readonly MissingPlayer[],
  requirements: readonly Requirement[],
): Promise<PurchaseSuggestion[]> {
  // Group identical ratings so "3 x 84" is one suggestion, not three.
  const byRating = new Map<number, { rating: number; estimatedCost: number; count: number }>()
  for (const m of missing) {
    const existing = byRating.get(m.rating)
    if (existing) existing.count++
    else byRating.set(m.rating, { rating: m.rating, estimatedCost: m.estimatedCost, count: 1 })
  }

  const suggestions: PurchaseSuggestion[] = []
  for (const group of byRating.values()) {
    const suggestion = await suggestPurchase(
      env,
      { rating: group.rating, estimatedCost: group.estimatedCost, description: '' },
      requirements,
    )
    suggestions.push({
      ...suggestion,
      description: group.count > 1
        ? `${group.count} x ${suggestion.description}`
        : suggestion.description,
    })
  }

  return suggestions.sort((a, b) => b.rating - a.rating)
}
