#!/usr/bin/env node
/**
 * Create the Cloudflare Access application and its single-email policy.
 *
 * wrangler cannot do this — Access is Zero Trust, and wrangler covers only
 * Workers, D1, KV, R2 and Pages. This talks to the Cloudflare API directly.
 *
 * Doing it here rather than in the dashboard has one concrete advantage: the
 * create response carries the AUD tag, so it goes straight into wrangler.toml
 * instead of being copied by hand — and the AUD is the check that stops a token
 * minted for some other Access application on the account being accepted here.
 *
 * Needs an API token (the wrangler OAuth token has no Access scope):
 *   dash.cloudflare.com/profile/api-tokens -> Create Token -> Custom token
 *     Account | Cloudflare Zero Trust        | Edit
 *     Account | Access: Apps and Policies    | Edit
 *
 * Usage:
 *   export CF_API_TOKEN=...
 *   node scripts/setup-access.mjs --hostname sbc.mxenofontos.com --email you@example.com
 */

import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'

const CONFIG = 'wrangler.toml'
const API = 'https://api.cloudflare.com/client/v4'

const args = process.argv.slice(2)
const flag = (n) => {
  const i = args.indexOf(`--${n}`)
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null
}

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
}

const token = process.env.CF_API_TOKEN?.trim()
if (!token) {
  console.error(c.red('\n  CF_API_TOKEN is not set.\n'))
  console.error('  Create one at ' + c.bold('dash.cloudflare.com/profile/api-tokens'))
  console.error('  -> Create Token -> Custom token, with these permissions:\n')
  console.error('      Account | Cloudflare Zero Trust     | Edit')
  console.error('      Account | Access: Apps and Policies | Edit\n')
  console.error('  Then:  ' + c.bold('export CF_API_TOKEN=your_token_here') + '\n')
  process.exit(1)
}

/**
 * Verify the token before doing anything with it.
 *
 * Without this the first real call fails with Cloudflare's error 9106,
 * "Authentication failed", which reads like a permissions problem and is
 * usually an empty environment variable. Checking up front lets the message
 * say which of the two it actually is.
 */
{
  let res
  try {
    res = await fetch(`${API}/user/tokens/verify`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  } catch (e) {
    // Not the same thing as a rejected token, and must not be reported as one.
    console.error(c.red('\n  Could not reach the Cloudflare API.'))
    console.error(`  ${e.message}\n`)
    console.error(c.dim('  Check your connection, or a proxy/firewall between you and'))
    console.error(c.dim('  api.cloudflare.com. Nothing was changed.\n'))
    process.exit(1)
  }

  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    console.error(c.red(`\n  The Cloudflare API returned something that is not JSON (HTTP ${res.status}).`))
    console.error(c.dim(`  ${text.slice(0, 200).replace(/\s+/g, ' ').trim() || '(empty response)'}`))
    console.error(c.dim('\n  That usually means a proxy intercepted the request. Nothing was changed.\n'))
    process.exit(1)
  }

  if (!body.success) {
    const code = body.errors?.[0]?.code
    console.error(c.red('\n  That API token was rejected by Cloudflare.\n'))
    if (code === 9106 || code === 6003 || code === 1000) {
      console.error(`  The token looks malformed or empty (${token.length} characters read;`)
      console.error('  a Cloudflare API token is 40). Check it was exported in THIS shell:\n')
      console.error(`    ${c.bold('echo "${#CF_API_TOKEN}"')}   ${c.dim('# should print 40')}`)
      console.error(`    ${c.bold('export CF_API_TOKEN=your_actual_token')}\n`)
    } else {
      console.error('  ' + (body.errors ?? []).map((e) => `${e.code}: ${e.message}`).join('\n  ') + '\n')
    }
    process.exit(1)
  }

  if (body.result?.status !== 'active') {
    console.error(c.red(`\n  The token is valid but its status is "${body.result?.status}".`))
    console.error(c.dim('  An expired or disabled token needs replacing at'))
    console.error(c.dim('  dash.cloudflare.com/profile/api-tokens\n'))
    process.exit(1)
  }
}

let toml = readFileSync(CONFIG, 'utf8')

const accountId = flag('account') ?? toml.match(/^account_id\s*=\s*"([^"]+)"/m)?.[1]
if (!accountId) {
  console.error(c.red(`\n  No account_id in ${CONFIG}. Run \`npm run setup\` first, or pass --account.\n`))
  process.exit(1)
}

const hostname =
  flag('hostname') ?? toml.match(/pattern\s*=\s*"([^"]+)"/)?.[1] ?? null
if (!hostname || hostname.includes('REPLACE_WITH')) {
  console.error(c.red('\n  No hostname. Pass --hostname sbc.yourdomain.com, or set the route in wrangler.toml first.\n'))
  process.exit(1)
}

const email = flag('email')
if (!email || !email.includes('@')) {
  console.error(c.red('\n  Pass the address allowed in:  --email you@example.com\n'))
  process.exit(1)
}

/** Call the API and surface Cloudflare's own error text rather than a status code. */
async function cf(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  })
  const body = await res.json().catch(() => ({}))
  if (!body.success) {
    const problems = (body.errors ?? []).map((e) => `${e.code}: ${e.message}`).join('; ')
    throw new Error(problems || `HTTP ${res.status} from ${path}`)
  }
  return body.result
}

console.log(c.bold('\nCloudflare Access setup\n'))
console.log(`  account:  ${accountId}`)
console.log(`  hostname: ${hostname}`)
console.log(`  allowing: ${email}\n`)

// ─── Zero Trust organisation, which carries the team domain ──────────────────
let org
try {
  org = await cf(`/accounts/${accountId}/access/organizations`)
} catch (e) {
  console.error(c.red(`\n  Could not read the Zero Trust organisation.`))
  console.error(`  ${e.message}\n`)
  // The token verified moments ago, so this is a scope problem, not auth.
  console.error(c.dim('  The token is valid, so it is missing a permission. It needs BOTH:\n'))
  console.error(c.dim('      Account | Cloudflare Zero Trust     | Edit'))
  console.error(c.dim('      Account | Access: Apps and Policies | Edit\n'))
  console.error(c.dim('  Add them at dash.cloudflare.com/profile/api-tokens and re-run.\n'))
  process.exit(1)
}

if (!org?.auth_domain) {
  console.error(c.red('  No Zero Trust organisation on this account yet.'))
  console.error(c.dim('  Visit dash.cloudflare.com -> Zero Trust once to create one'))
  console.error(c.dim('  (it asks you to choose a team name), then re-run this.\n'))
  process.exit(1)
}

const teamDomain = org.auth_domain                       // myteam.cloudflareaccess.com
const teamName = teamDomain.replace(/\.cloudflareaccess\.com$/, '')
console.log(`  team:     ${c.green(teamName)}  ${c.dim(`(${teamDomain})`)}`)

// ─── The application ─────────────────────────────────────────────────────────
const existing = (await cf(`/accounts/${accountId}/access/apps`).catch(() => []))
  .find((a) => a.domain === hostname)

let app
if (existing) {
  console.log(c.dim(`\n  an application already covers ${hostname} — reusing it`))
  app = existing
} else {
  console.log(c.dim('\n  creating the Access application...'))
  app = await cf(`/accounts/${accountId}/access/apps`, {
    method: 'POST',
    body: JSON.stringify({
      name: 'FC 27 SBC Assistant',
      domain: hostname,
      type: 'self_hosted',
      session_duration: '24h',
      app_launcher_visible: true,
      auto_redirect_to_identity: false,
      // Empty means every enabled login method, which includes the built-in
      // One-time PIN — the one that works with any address and needs no setup.
      allowed_idps: [],
    }),
  })
}

console.log(`  app id:   ${app.id}`)
console.log(`  AUD:      ${c.green(app.aud)}`)

// ─── The policy ──────────────────────────────────────────────────────────────
const policies = await cf(`/accounts/${accountId}/access/apps/${app.id}/policies`).catch(() => [])

// A Bypass policy would switch authentication off for this hostname entirely,
// so it is worth naming loudly rather than leaving to be noticed later.
const bypass = policies.filter((p) => p.decision === 'bypass')
if (bypass.length > 0) {
  console.error(c.red(`\n  WARNING: ${bypass.length} Bypass policy/policies on this application.`))
  console.error(c.red('  Bypass disables authentication. Remove them in the dashboard.\n'))
}

const already = policies.find(
  (p) => p.decision === 'allow' &&
    JSON.stringify(p.include ?? []).toLowerCase().includes(email.toLowerCase()),
)

if (already) {
  console.log(c.dim(`  a policy already allows ${email} — leaving it alone`))
} else {
  console.log(c.dim('  creating the allow policy...'))
  await cf(`/accounts/${accountId}/access/apps/${app.id}/policies`, {
    method: 'POST',
    body: JSON.stringify({
      name: 'Only me',
      decision: 'allow',
      // Exact address. Not a domain suffix — one person, named.
      include: [{ email: { email } }],
      precedence: 1,
    }),
  })
  console.log(`  policy:   ${c.green('allow')} ${email}`)
}

const otherAllows = policies.filter(
  (p) => p.decision === 'allow' &&
    !JSON.stringify(p.include ?? []).toLowerCase().includes(email.toLowerCase()),
)
if (otherAllows.length > 0) {
  console.error(c.yellow(`\n  NOTE: ${otherAllows.length} other Allow policy/policies exist on this app:`))
  for (const p of otherAllows) console.error(c.yellow(`    - ${p.name}`))
  console.error(c.yellow('  Anyone they match can reach the app. Review them in the dashboard.'))
}

// ─── Write the config ────────────────────────────────────────────────────────
copyFileSync(CONFIG, `${CONFIG}.backup`)
toml = toml
  .split('REPLACE_WITH_YOUR_ACCESS_AUD_TAG').join(app.aud)
  .split('REPLACE_WITH_YOUR_TEAM_NAME').join(teamName)
writeFileSync(CONFIG, toml)

console.log(c.dim(`\n  wrote ${CONFIG}`))

const left = [...new Set([...toml.matchAll(/REPLACE_WITH_[A-Z_]+/g)].map((m) => m[0]))]
console.log(c.bold('\n  Next\n'))
if (left.includes('REPLACE_WITH_YOUR_EMAIL')) {
  console.log(`    ${c.bold('npx wrangler secret put ALLOWED_EMAIL --env production')}`)
  console.log(c.dim(`      paste: ${email}`))
}
console.log(`    ${c.bold('npm run deploy')}`)
console.log(c.dim(`\n  Then open https://${hostname} — you should get a login, not the app.\n`))
