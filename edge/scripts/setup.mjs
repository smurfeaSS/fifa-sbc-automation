#!/usr/bin/env node
/**
 * One-shot Cloudflare resource setup.
 *
 * Creates the D1 database and the two KV namespaces this app needs, then writes
 * their ids into wrangler.toml — including the second copy under
 * [env.production], which env blocks do not inherit and which is the single
 * most common reason a first deploy comes up with no database.
 *
 * Safe to re-run. Resources that already exist are detected and reused rather
 * than duplicated, and nothing is written unless every id was resolved.
 *
 * Usage:
 *   node scripts/setup.mjs --domain sbc.yourdomain.com --team yourteam
 *
 * Both flags are optional; anything omitted is left as a placeholder and
 * reported at the end.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'

const CONFIG = 'wrangler.toml'
const DB_NAME = 'fc27-sbc-assistant-club'
const KV_BINDING = 'ACCESS_KEYS'

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(`--${name}`)
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null
}

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
}

function wrangler(argv) {
  try {
    return execFileSync('npx', ['wrangler', ...argv], {
      encoding: 'utf8',
      stdio: ['inherit', 'pipe', 'pipe'],
    })
  } catch (e) {
    // wrangler writes the useful part to stdout even when it exits non-zero.
    return `${e.stdout ?? ''}\n${e.stderr ?? ''}`
  }
}

/** Pull an id out of wrangler's output, whichever shape it used. */
function extractId(output, key) {
  const toml = output.match(new RegExp(`${key}\\s*=\\s*"([0-9a-fA-F-]{16,})"`))
  if (toml) return toml[1]
  const json = output.match(new RegExp(`"${key}"\\s*:\\s*"([0-9a-fA-F-]{16,})"`))
  if (json) return json[1]
  // Last resort: a bare uuid or 32-hex id anywhere in the output.
  const bare = output.match(/\b([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i)
  return bare ? bare[1] : null
}

function alreadyExists(output) {
  return /already exists|duplicate|there is already/i.test(output)
}

console.log(c.bold('\nFC 27 SBC Assistant — Cloudflare setup\n'))

// ─── who ─────────────────────────────────────────────────────────────────────
const who = wrangler(['whoami'])
const email = who.match(/([\w.+-]+@[\w.-]+\.\w+)/)?.[1]
if (!email) {
  console.error(c.red('Not logged in. Run:  npx wrangler login\n'))
  console.error(c.dim(who.trim().split('\n').slice(0, 6).join('\n')))
  process.exit(1)
}
console.log(`  account: ${c.green(email)}`)

// ─── D1 ──────────────────────────────────────────────────────────────────────
console.log(c.dim(`\n  creating D1 database "${DB_NAME}"...`))
let dbOut = wrangler(['d1', 'create', DB_NAME])
let dbId = extractId(dbOut, 'database_id') ?? extractId(dbOut, 'uuid')

if (!dbId && alreadyExists(dbOut)) {
  console.log(c.dim('  already exists — looking it up'))
  const list = wrangler(['d1', 'list', '--json'])
  try {
    const found = JSON.parse(list).find((d) => d.name === DB_NAME)
    dbId = found?.uuid ?? found?.database_id ?? null
  } catch { /* fall through to the error below */ }
}

if (!dbId) {
  console.error(c.red('\n  Could not create or find the D1 database.'))
  console.error(c.dim(dbOut.trim()))
  process.exit(1)
}
console.log(`  D1  ${DB_NAME} → ${c.green(dbId)}`)

// ─── KV ──────────────────────────────────────────────────────────────────────
function createKv(preview) {
  const label = preview ? 'preview' : 'production'
  console.log(c.dim(`  creating KV namespace (${label})...`))
  const out = wrangler(['kv', 'namespace', 'create', KV_BINDING, ...(preview ? ['--preview'] : [])])
  let id = extractId(out, preview ? 'preview_id' : 'id')

  if (!id && alreadyExists(out)) {
    const list = wrangler(['kv', 'namespace', 'list'])
    try {
      const ns = JSON.parse(list.slice(list.indexOf('[')))
      const wanted = preview
        ? new RegExp(`${KV_BINDING}_preview$`, 'i')
        : new RegExp(`${KV_BINDING}$`, 'i')
      id = ns.find((x) => wanted.test(x.title))?.id ?? null
    } catch { /* reported below */ }
  }
  if (!id) {
    console.error(c.red(`\n  Could not create or find the ${label} KV namespace.`))
    console.error(c.dim(out.trim()))
    process.exit(1)
  }
  console.log(`  KV  ${KV_BINDING} (${label}) → ${c.green(id)}`)
  return id
}

const kvId = createKv(false)
const kvPreviewId = createKv(true)

// ─── write the config ────────────────────────────────────────────────────────
if (!existsSync(CONFIG)) {
  console.error(c.red(`\n  ${CONFIG} not found — run this from the edge/ directory.\n`))
  process.exit(1)
}

copyFileSync(CONFIG, `${CONFIG}.backup`)
let toml = readFileSync(CONFIG, 'utf8')

/**
 * Each id goes into every slot that names it — the D1 id and the production KV
 * id each appear twice, once at the top level and once under [env.production],
 * because env blocks do not inherit bindings. Missing that second copy is the
 * usual reason a first deploy comes up with no database.
 */
const substitutions = [
  ['REPLACE_WITH_CLUB_DB_ID', dbId],
  ['REPLACE_WITH_ACCESS_KEYS_PREVIEW_ID', kvPreviewId],
  ['REPLACE_WITH_ACCESS_KEYS_ID', kvId],
]

const domain = flag('domain')
const team = flag('team')
const aud = flag('aud')
if (domain) substitutions.push(['sbc.REPLACE_WITH_YOUR_DOMAIN', domain])
if (team) substitutions.push(['REPLACE_WITH_YOUR_TEAM_NAME', team])
if (aud) substitutions.push(['REPLACE_WITH_YOUR_ACCESS_AUD_TAG', aud])

let replaced = 0
for (const [placeholder, value] of substitutions) {
  const before = toml
  toml = toml.split(placeholder).join(value)
  if (toml !== before) replaced++
}

writeFileSync(CONFIG, toml)
console.log(c.dim(`\n  wrote ${CONFIG} (backup at ${CONFIG}.backup)`))

// ─── what is left ────────────────────────────────────────────────────────────
const remaining = [...toml.matchAll(/REPLACE_WITH_[A-Z_]+/g)].map((m) => m[0])
const unique = [...new Set(remaining)]

console.log(c.bold('\n  Next\n'))
if (unique.length === 0) {
  console.log(`  ${c.green('✓')} Every placeholder is filled in.`)
  console.log(`    ${c.bold('npm run db:migrate:production')}`)
  console.log(`    ${c.bold('npm run deploy')}`)
} else {
  console.log(`  ${c.yellow('!')} Still to fill in, in ${CONFIG}:\n`)
  for (const key of unique) {
    const hint = {
      REPLACE_WITH_YOUR_DOMAIN: 'your hostname, e.g. sbc.yourdomain.com — must be a domain on this Cloudflare account',
      REPLACE_WITH_YOUR_TEAM_NAME: 'Zero Trust team name, from yourteam.cloudflareaccess.com',
      REPLACE_WITH_YOUR_ACCESS_AUD_TAG: 'the Access application AUD tag — you get this AFTER creating the Access app',
    }[key] ?? ''
    console.log(`      ${key}${hint ? `\n        ${c.dim(hint)}` : ''}`)
  }
  console.log(`\n  The AUD tag comes last by design: create the Access application`)
  console.log(`  first (see ACCESS-SETUP.md), then fill it in and deploy again.`)
}
console.log('')
