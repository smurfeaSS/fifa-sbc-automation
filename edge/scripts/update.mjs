#!/usr/bin/env node
/**
 * Pull the latest code and redeploy, without losing your local config.
 *
 * The committed wrangler.toml holds placeholders while yours holds real ids,
 * so a plain `git pull` that touches that file refuses to run. Rather than
 * merge by hand every time, this takes the incoming version and refills it from
 * the values `npm run setup` remembered.
 *
 * Secrets are untouched — they live on Cloudflare, not in the repo.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
}

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: 'inherit', ...opts })

if (!existsSync('.setup-args.json')) {
  console.error(c.red('\n  No .setup-args.json — run `npm run setup` once first.\n'))
  console.error(c.dim('  It records the account, domain, team and AUD so this can replay them.\n'))
  process.exit(1)
}

let saved
try {
  saved = JSON.parse(readFileSync('.setup-args.json', 'utf8'))
} catch (e) {
  console.error(c.red(`\n  .setup-args.json is unreadable: ${e.message}\n`))
  process.exit(1)
}

console.log(c.bold('\nUpdating\n'))

// Discard the local config so the pull can fast-forward. Safe: every value in
// it is either in .setup-args.json or is a placeholder.
console.log(c.dim('  taking the incoming wrangler.toml...'))
try {
  run('git', ['checkout', '--', 'wrangler.toml'])
} catch {
  /* Unmodified already. */
}

console.log(c.dim('  pulling...'))
run('git', ['pull'], { cwd: '..' })

console.log(c.dim('  refilling your values...'))
const args = ['scripts/setup.mjs']
for (const [k, v] of Object.entries(saved)) {
  if (v) args.push(`--${k}`, v)
}
run('node', args)

console.log(c.dim('\n  deploying...'))
run('npx', ['wrangler', 'deploy', '--env', 'production'])

console.log(c.green('\n  Done. Hard-refresh the page (Ctrl+Shift+R) — the old assets are cached.\n'))
