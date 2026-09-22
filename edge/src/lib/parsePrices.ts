/**
 * Parse a pasted or uploaded price list.
 *
 * Built to be forgiving, because the realistic way you will produce one of
 * these is copying rows off a price site or a spreadsheet, and that arrives in
 * whatever shape the source happened to use. Anything unreadable is reported
 * with its line number rather than silently skipped — a price list that
 * quietly lost half its rows would make the solver confidently wrong about
 * what things cost.
 *
 * Accepted shapes, detected per line:
 *   Mbappé,91,1200000              name, rating, price
 *   91,1200000                     rating, price          (a band, not a card)
 *   Mbappé  91  1,200,000          whitespace or tab separated
 *   Mbappé,91,1200000,PSG,France,Ligue 1
 *
 * Headers are detected and skipped. Commas inside numbers are handled.
 */

export interface ParsedPrice {
  name?: string
  rating: number
  priceCoins: number
  clubName?: string
  nationName?: string
  leagueName?: string
  position?: string
  rarity: string
}

export interface PriceParseResult {
  prices: ParsedPrice[]
  errors: Array<{ line: number; text: string; reason: string }>
  /** Lines skipped as headers or blanks — not errors. */
  skipped: number
}

/** "1,200,000" / "1.2M" / "850k" all mean coins. */
function parseCoins(raw: string): number | null {
  const text = raw.trim().toLowerCase().replace(/,/g, '').replace(/\s/g, '')
  if (!text) return null

  const suffixed = text.match(/^([\d.]+)\s*([km])$/)
  if (suffixed) {
    const value = Number(suffixed[1])
    if (!Number.isFinite(value)) return null
    return Math.round(value * (suffixed[2] === 'm' ? 1_000_000 : 1_000))
  }

  const plain = Number(text)
  return Number.isFinite(plain) && plain >= 0 ? Math.round(plain) : null
}

function parseRating(raw: string): number | null {
  const value = Number(raw.trim())
  if (!Number.isInteger(value) || value < 1 || value > 99) return null
  return value
}

/**
 * Remove thousands separators before the line is split.
 *
 * Without this, splitting "Bellingham,88,1,250,000" on commas yields
 * 1 / 250 / 000 and the price silently becomes 250. Only a comma sitting
 * between a digit and exactly three digits is a separator inside a number;
 * a comma before four or more digits, or before text, is a column break.
 */
function joinGroupedNumbers(line: string): string {
  return line.replace(/(?<=\d),(?=\d{3}(?!\d))/g, '')
}

function splitLine(line: string): string[] {
  const normalised = joinGroupedNumbers(line)
  // Tabs and commas are unambiguous separators; two-or-more spaces are how a
  // copied table usually arrives.
  if (normalised.includes('\t')) return normalised.split('\t').map((c) => c.trim())
  if (normalised.includes(',')) return normalised.split(',').map((c) => c.trim())
  return normalised.split(/\s{2,}/).map((c) => c.trim())
}

const HEADER_WORDS = /^(name|player|rating|ovr|overall|price|prices|coins|cost|club|team|nation|country|league|position|pos|rarity)$/i

/**
 * Is this a header row rather than data?
 *
 * Deliberately strict. Matching on "contains a header word anywhere" wrongly
 * swallows ordinary lines — "this is not a price row" contains "price" — and a
 * silently swallowed line is exactly the failure this parser must not have. A
 * header has no digits and is mostly header words.
 */
function looksLikeHeader(line: string): boolean {
  if (/\d/.test(line)) return false
  const tokens = line.split(/[\s,\t]+/).filter((t) => t.length > 0)
  if (tokens.length < 2) return false
  const matches = tokens.filter((t) => HEADER_WORDS.test(t)).length
  return matches >= 2 && matches >= tokens.length / 2
}

export function parsePriceList(text: string): PriceParseResult {
  const prices: ParsedPrice[] = []
  const errors: PriceParseResult['errors'] = []
  let skipped = 0

  const lines = text.split('\n')
  lines.forEach((raw, index) => {
    const line = raw.trim()
    if (!line) { skipped++; return }

    // A header row is a skip, not an error.
    if (looksLikeHeader(line)) { skipped++; return }

    const cells = splitLine(line).filter((c) => c.length > 0)
    if (cells.length < 2) {
      errors.push({ line: index + 1, text: line, reason: 'expected at least a rating and a price' })
      return
    }

    // Find the rating and price. The rating is a 1-99 integer; the price is the
    // largest remaining number, since prices dwarf every other numeric field.
    let ratingIdx = -1
    for (let i = 0; i < cells.length; i++) {
      if (parseRating(cells[i]!) !== null) { ratingIdx = i; break }
    }
    if (ratingIdx === -1) {
      errors.push({ line: index + 1, text: line, reason: 'no rating between 1 and 99 found' })
      return
    }

    let priceIdx = -1
    let priceValue = -1
    for (let i = 0; i < cells.length; i++) {
      if (i === ratingIdx) continue
      const coins = parseCoins(cells[i]!)
      if (coins !== null && coins > priceValue) { priceValue = coins; priceIdx = i }
    }
    if (priceIdx === -1) {
      errors.push({ line: index + 1, text: line, reason: 'no price found' })
      return
    }

    const rating = parseRating(cells[ratingIdx]!)!
    const textCells = cells.filter((_, i) => i !== ratingIdx && i !== priceIdx)

    const entry: ParsedPrice = { rating, priceCoins: priceValue, rarity: 'rare' }
    if (textCells[0]) entry.name = textCells[0]
    if (textCells[1]) entry.clubName = textCells[1]
    if (textCells[2]) entry.nationName = textCells[2]
    if (textCells[3]) entry.leagueName = textCells[3]

    prices.push(entry)
  })

  return { prices, errors, skipped }
}
