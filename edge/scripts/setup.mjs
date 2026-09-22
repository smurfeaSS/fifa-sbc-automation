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

/**
 * Run wrangler and return everything it said.
 *
 * Both streams, always. execFileSync returns stdout only, so on a successful
 * run anything wrangler wrote to stderr was being thrown away — which is how
 * the first version of this script missed the ids it was looking for.
 */
/**
 * The account to act on.
 *
 * wrangler refuses to guess when a login has access to more than one account,
 * and it is right to: creating a database on the wrong account is tedious to
 * undo. Passed with --account, or via CLOUDFLARE_ACCOUNT_ID.
 */
const accountId = flag('account') ?? process.env.CLOUDFLARE_ACCOUNT_ID ?? null

function wrangler(argv) {
  const env = { ...process.env }
  if (accountId) env.CLOUDFLARE_ACCOUNT_ID = accountId
  try {
    const stdout = execFileSync('npx', ['wrangler', ...argv], {
      encoding: 'utf8',
      stdio: ['inherit', 'pipe', 'pipe'],
      env,
    })
    return stdout ?? ''
  } catch (e) {
    return `${e.stdout ?? ''}\n${e.stderr ?? ''}`
  }
}

/**
 * Detect the multiple-accounts error and list the choices.
 *
 * Worth handling explicitly: the raw wrangler message buries the account ids
 * in prose, and the first run of this script scraped one of them as a resource
 * id. Naming the situation beats leaving it to be parsed out of an error.
 */
function reportAccountAmbiguity(output) {
  if (!/more than one account/i.test(output)) return false

  const accounts = [...output.matchAll(/`([^`]+)`\s*:\s*`([0-9a-f]{32})`/gi)]
    .map((m) => ({ name: m[1], id: m[2] }))

  console.error(c.red('\n  This login has access to more than one Cloudflare account,'))
  console.error(c.red('  so wrangler will not guess which one to use.\n'))

  if (accounts.length > 0) {
    console.error('  Available accounts:\n')
    for (const a of accounts) console.error(`    ${c.bold(a.id)}  ${c.dim(a.name)}`)
  } else {
    console.error(c.dim('  Run `npx wrangler whoami` to list them.'))
  }

  console.error(`\n  Re-run with the one holding your Workers Paid plan:\n`)
  console.error(`    ${c.bold('npm run setup -- --account <id>')}\n`)
  return true
}

/** Pull the first JSON array out of wrangler's output, ignoring any preamble. */
function parseJsonArray(output) {
  const start = output.indexOf('[')
  if (start === -1) return null
  try {
    const parsed = JSON.parse(output.slice(start, output.lastIndexOf(']') + 1))
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Pull an id out of wrangler's output for a named key.
 *
 * Deliberately has NO "any id-shaped string in the output" fallback. An earlier
 * version did, and it matched the account id that wrangler prints in its
 * banner — so all three resources were written with the same wrong value and
 * the config looked plausible while being entirely wrong. A fallback that can
 * silently return the wrong answer is worse than no fallback: ids are resolved
 * by listing the resources instead, which is authoritative.
 */
function extractId(output, key) {
  const toml = output.match(new RegExp(`\\b${key}\\s*=\\s*"([0-9a-fA-F-]{16,})"`))
  if (toml) return toml[1]
  const json = output.match(new RegExp(`"${key}"\\s*:\\s*"([0-9a-fA-F-]{16,})"`))
  if (json) return json[1]
  return null
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
console.log(`  login:   ${c.green(email)}`)

const listed = [...who.matchAll(/│\s*([^│]+?)\s*│\s*([0-9a-f]{32})\s*│/gi)]
  .map((m) => ({ name: m[1].trim(), id: m[2] }))
if (!accountId && listed.length > 1) {
  console.error(c.red(`\n  ${listed.length} accounts on this login. Pick one:\n`))
  for (const a of listed) console.error(`    ${c.bold(a.id)}  ${c.dim(a.name)}`)
  console.error(`\n    ${c.bold('npm run setup -- --account <id>')}\n`)
  process.exit(1)
}
if (accountId) console.log(`  account: ${c.green(accountId)}`)

// ─── D1 ──────────────────────────────────────────────────────────────────────
console.log(c.dim(`\n  creating D1 database "${DB_NAME}"...`))
const dbOut = wrangler(['d1', 'create', DB_NAME])

// Whether it was just created or already existed, the list is the source of
// truth. Parsing the create output alone is how the wrong id got written.
const dbList = parseJsonArray(wrangler(['d1', 'list', '--json']))
const dbId =
  dbList?.find((d) => d.name === DB_NAME)?.uuid ??
  dbList?.find((d) => d.name === DB_NAME)?.database_id ??
  extractId(dbOut, 'database_id')

if (!dbId) {
  if (reportAccountAmbiguity(dbOut)) process.exit(1)
  console.error(c.red('\n  Could not create or find the D1 database.'))
  console.error(c.dim(dbOut.trim().slice(0, 800)))
  process.exit(1)
}
console.log(`  D1  ${DB_NAME} → ${c.green(dbId)}`)

// ─── KV ──────────────────────────────────────────────────────────────────────
function createKv(preview) {
  const label = preview ? 'preview' : 'production'
  console.log(c.dim(`  creating KV namespace (${label})...`))
  const out = wrangler(['kv', 'namespace', 'create', KV_BINDING, ...(preview ? ['--preview'] : [])])

  // Resolved by listing, for the same reason as D1 above. wrangler titles the
  // namespace "<worker-name>-<binding>", with "_preview" appended for previews.
  const namespaces = parseJsonArray(wrangler(['kv', 'namespace', 'list'])) ?? []
  const wanted = preview
    ? new RegExp(`${KV_BINDING}_preview$`, 'i')
    : new RegExp(`${KV_BINDING}$`, 'i')

  const id =
    namespaces.find((x) => typeof x?.title === 'string' && wanted.test(x.title))?.id ??
    extractId(out, preview ? 'preview_id' : 'id')

  if (!id) {
    if (reportAccountAmbiguity(out)) process.exit(1)
    console.error(c.red(`\n  Could not create or find the ${label} KV namespace.`))
    console.error(c.dim(out.trim().slice(0, 800)))
    console.error(c.dim(`  namespaces seen: ${namespaces.map((x) => x?.title).join(', ') || '(none)'}`))
    process.exit(1)
  }
  console.log(`  KV  ${KV_BINDING} (${label}) → ${c.green(id)}`)
  return id
}

const kvId = createKv(false)
const kvPreviewId = createKv(true)

// ─── sanity-check before writing anything ────────────────────────────────────
/**
 * Three separate resources must have three separate ids.
 *
 * This check exists because an earlier version of this script wrote the same
 * value into all three slots — it had scraped the account id out of wrangler's
 * banner — and the resulting config looked entirely plausible. Nothing caught
 * it until a deploy behaved strangely. Verifying before writing is cheap; a
 * config that is confidently wrong is not.
 */
const resolved = { 'D1 database': dbId, 'KV production': kvId, 'KV preview': kvPreviewId }
const seen = new Map()
for (const [label, id] of Object.entries(resolved)) {
  if (seen.has(id)) {
    console.error(c.red('\n  Refusing to write: two resources resolved to the same id.'))
    console.error(`    ${seen.get(id)} and ${label} are both ${id}`)
    console.error(c.dim('\n  That means an id was misread, not that the resources are wrong.'))
    console.error(c.dim('  Read the real ids with:'))
    console.error(c.dim('    npx wrangler d1 list'))
    console.error(c.dim('    npx wrangler kv namespace list'))
    console.error(c.dim(`  then fill them into ${CONFIG} by hand.\n`))
    process.exit(1)
  }
  seen.set(id, label)
}

// A Cloudflare account id is 32 hex characters with no dashes. A D1 database id
// is a dashed uuid. Seeing the former where the latter belongs is the exact
// failure above, so it is named rather than left to look like a typo.
if (/^[0-9a-f]{32}$/i.test(dbId)) {
  console.error(c.red('\n  The D1 id looks like an account id, not a database id.'))
  console.error(c.dim(`    got: ${dbId}`))
  console.error(c.dim('    a D1 id is a dashed uuid, e.g. 1a2b3c4d-5e6f-...'))
  console.error(c.dim('\n  Check with:  npx wrangler d1 list\n'))
  process.exit(1)
}

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

// Written into the config so `wrangler deploy`, `d1 migrations apply` and
// `wrangler tail` all work later without repeating --account.
if (accountId && !/^account_id\s*=/m.test(toml)) {
  toml = toml.replace(
    /^(name = ".*"\n)/m,
    `$1account_id = "${accountId}"\n`,
  )
  console.log(c.dim(`  pinned account_id = ${accountId}`))
}

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
