#!/usr/bin/env node
/**
 * Turn export-club.js into a bookmarklet.
 *
 * Why a bookmarklet at all: the FC Web App's bundle contains anti-debugging
 * traps — recursive `debugger` statements and a `while(!![]){}` freeze loop —
 * which fire whenever DevTools is open and make the Snippets route impractical.
 * A bookmarklet runs from the bookmarks bar without DevTools, so nothing
 * triggers. The script's on-page panel replaces the console you would otherwise
 * be watching.
 *
 *   node tools/club-export/make-bookmarklet.mjs
 *
 * Writes bookmarklet.txt. Copy its whole contents into a bookmark's URL field.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, 'export-club.js'), 'utf8')

/**
 * Strip comments before encoding.
 *
 * Comments triple the length of an already long URL, and some bookmark
 * managers truncate. The readable source stays the thing you review; this is
 * the compiled artefact.
 */
const stripped = source
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean)
  .join('\n')

// encodeURIComponent, not raw: a bookmark URL must survive %, #, and quotes.
const bookmarklet = `javascript:${encodeURIComponent(stripped)}`

writeFileSync(join(here, 'bookmarklet.txt'), bookmarklet)

console.log(`\n  Wrote bookmarklet.txt  (${bookmarklet.length.toLocaleString()} characters)\n`)
if (bookmarklet.length > 60000) {
  console.log('  That is long enough that some browsers may refuse it.')
  console.log('  Chrome handles this size; Safari is stricter.\n')
}
console.log('  To install:')
console.log('    1. Show the bookmarks bar        Ctrl+Shift+B')
console.log('    2. Right-click it -> Add page')
console.log('    3. Name:  Export FUT Club')
console.log('    4. URL:   paste the whole of bookmarklet.txt')
console.log('\n  Then open the FC Web App, wait for it to load, and click the bookmark.')
console.log('  A panel appears top-right with progress. No DevTools needed.\n')
