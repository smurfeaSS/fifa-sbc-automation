/**
 * Price-list parsing.
 *
 * The realistic way one of these gets produced is copy-paste out of a price
 * site or a spreadsheet, so the input is whatever shape the source used. These
 * tests are mostly about tolerating that without ever silently losing a row —
 * a price list that quietly dropped half its entries would make the solver
 * confidently wrong about what things cost.
 */

import { describe, test, expect } from 'vitest'
import { parsePriceList } from '../src/lib/parsePrices'

describe('separators', () => {
  test('comma separated', () => {
    const r = parsePriceList('Mbappe,91,1200000')
    expect(r.errors).toHaveLength(0)
    expect(r.prices[0]).toMatchObject({ name: 'Mbappe', rating: 91, priceCoins: 1200000 })
  })

  test('tab separated', () => {
    const r = parsePriceList('Haaland\t91\t950000')
    expect(r.prices[0]).toMatchObject({ name: 'Haaland', rating: 91, priceCoins: 950000 })
  })

  test('multi-space separated, as a copied table arrives', () => {
    const r = parsePriceList('Rodri   89   420000')
    expect(r.prices[0]).toMatchObject({ name: 'Rodri', rating: 89, priceCoins: 420000 })
  })
})

describe('number formats', () => {
  test('commas inside the price', () => {
    expect(parsePriceList('Bellingham,88,1,250,000').prices[0]?.priceCoins).toBe(1250000)
  })
  test('k and m suffixes', () => {
    expect(parsePriceList('A,84,12k').prices[0]?.priceCoins).toBe(12000)
    expect(parsePriceList('B,90,1.4m').prices[0]?.priceCoins).toBe(1400000)
  })
})

describe('shapes', () => {
  test('a bare rating and price is a band, with no name', () => {
    const r = parsePriceList('86,9200')
    expect(r.prices[0]).toMatchObject({ rating: 86, priceCoins: 9200 })
    expect(r.prices[0]?.name).toBeUndefined()
  })

  test('extra columns become club, nation and league', () => {
    const r = parsePriceList('Vinicius,90,780000,Real Madrid,Brazil,LaLiga')
    expect(r.prices[0]).toMatchObject({
      name: 'Vinicius', rating: 90, priceCoins: 780000,
      clubName: 'Real Madrid', nationName: 'Brazil', leagueName: 'LaLiga',
    })
  })

  test('the price is the larger number, whichever column it is in', () => {
    // Rating and price can arrive either way round; only one can be 1-99.
    const r = parsePriceList('Player,45000,87')
    expect(r.prices[0]).toMatchObject({ rating: 87, priceCoins: 45000 })
  })
})

describe('does not silently lose rows', () => {
  test('a header row is skipped, not counted as an error', () => {
    const r = parsePriceList('Name,Rating,Price\nMbappe,91,1200000')
    expect(r.prices).toHaveLength(1)
    expect(r.errors).toHaveLength(0)
    expect(r.skipped).toBe(1)
  })

  test('an unreadable row is reported with its line number', () => {
    const r = parsePriceList('Mbappe,91,1200000\nthis is not a price row\nHaaland,91,950000')
    expect(r.prices).toHaveLength(2)
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]?.line).toBe(2)
    expect(r.errors[0]?.reason).toMatch(/rating|price/)
  })

  test('a row with no valid rating is an error, not a guess', () => {
    const r = parsePriceList('Someone,120,5000')
    expect(r.prices).toHaveLength(0)
    expect(r.errors[0]?.reason).toMatch(/rating/)
  })

  test('blank lines are skipped', () => {
    const r = parsePriceList('\n\nMbappe,91,1200000\n\n')
    expect(r.prices).toHaveLength(1)
    expect(r.errors).toHaveLength(0)
  })

  test('every row is either parsed or reported', () => {
    const text = ['Name,Rating,Price', 'A,84,2000', 'garbage', 'B,85,4000', '', 'C,999,1'].join('\n')
    const r = parsePriceList(text)
    const accounted = r.prices.length + r.errors.length + r.skipped
    expect(accounted).toBe(text.split('\n').length)
  })
})

describe('junk input', () => {
  test('never throws', () => {
    for (const junk of ['', '   ', ',,,,', '\t\t', '\u0000', 'x'.repeat(10000)]) {
      expect(() => parsePriceList(junk)).not.toThrow()
    }
  })
})
