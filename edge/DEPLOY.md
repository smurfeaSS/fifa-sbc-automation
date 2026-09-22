# Deploy runbook

Every Cloudflare resource is named for this app, so nothing collides with
anything else on your account and every line in the dashboard is
self-explanatory:

| Resource | Name | Binding |
|---|---|---|
| Worker (production) | `fc27-sbc-assistant-prod` | — |
| Worker (dev) | `fc27-sbc-assistant` | — |
| D1 database | `fc27-sbc-assistant-club` | `DB` |
| KV namespace | `fc27-sbc-assistant-ACCESS_KEYS` | `ACCESS_KEYS` |
| Access application | `FC 27 SBC Assistant` | — |
| Hostname | `sbc.yourdomain.com` | — |

The KV namespace title is derived by wrangler from the Worker name plus the
binding, which is why it reads `fc27-sbc-assistant-ACCESS_KEYS`. It holds the
Cloudflare Access signing keys and nothing else — named for the job so what is
in it is obvious without opening it.

**GitHub holds the source; Cloudflare gets everything through `wrangler`.**
Nothing in this repo is deployed by pushing to GitHub. `wrangler deploy`
uploads the bundled Worker *and* everything under `edge/public/` in one call
(via the `[assets]` binding) — there is no separate step for the front end.

---

## 0. Log in, once

```bash
cd edge
npm install
npx wrangler login
```

Confirm you are on the right account before creating anything:

```bash
npx wrangler whoami
```

## 1. Create everything in one command

```bash
npm run setup
```

**If your login has access to more than one Cloudflare account**, wrangler will
not guess between them — and it is right not to, since creating a database on
the wrong account is tedious to undo. The script lists them and stops:

```bash
npm run setup -- --account <account-id>
```

The chosen account is pinned as `account_id` in `wrangler.toml`, so later
commands — deploy, migrations, tail — work without repeating the flag.

This creates the D1 database and both KV namespaces, then writes all five ids
into `wrangler.toml` — including the second copy of each under
`[env.production]`, which env blocks do not inherit and which is the usual
reason a first deploy comes up with no database. It backs the file up first and
is safe to re-run; existing resources are reused rather than duplicated.

You can pass what you already know:

```bash
npm run setup -- --domain sbc.yourdomain.com --team yourteam
```

It prints anything still left to fill in. The Access AUD tag is deliberately
last — you only get it after creating the Access application in step 6.

The manual equivalent is below, if you would rather do it by hand.

## 1a. Create the D1 database (manual)

```bash
npm run db:create
```

Runs `wrangler d1 create fc27-sbc-assistant-club`. It prints a block like:

```
[[d1_databases]]
binding = "DB"
database_name = "fc27-sbc-assistant-club"
database_id = "a1b2c3d4-...."
```

Copy that `database_id` into `wrangler.toml`, replacing **both** occurrences of
`REPLACE_WITH_CLUB_DB_ID` — one in the top-level `[[d1_databases]]` block and
one under `[[env.production.d1_databases]]`. Environment blocks do not inherit
bindings, so missing the second one means production deploys with no database.

## 2. Create the KV namespace

```bash
npm run kv:create            # production namespace
npm run kv:create:preview    # preview namespace, used by `wrangler dev`
```

These run `wrangler kv namespace create ACCESS_KEYS` (and `--preview`). Each
prints an id:

```
[[kv_namespaces]]
binding = "ACCESS_KEYS"
id = "9f8e7d...."
```

Put the production id into both `REPLACE_WITH_ACCESS_KEYS_ID` slots, and the
preview id into `REPLACE_WITH_ACCESS_KEYS_PREVIEW_ID`.

## 3. Create the tables

```bash
npm run db:migrate:production
```

Runs `wrangler d1 migrations apply fc27-sbc-assistant-club --env production
--remote`. The `--remote` flag is what makes this touch the real database —
without it wrangler writes to the local SQLite file under `.wrangler/` and the
deployed Worker still has no tables.

Check it landed:

```bash
npx wrangler d1 execute fc27-sbc-assistant-club --env production --remote \
  --command="SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
```

Expect: `club_meta`, `history`, `players`, `sbcs`, `settings`, `squads`,
plus `d1_migrations`.

## 4. Set your hostname

In `wrangler.toml`, under `[env.production]`:

```toml
routes = [
  { pattern = "sbc.yourdomain.com", custom_domain = true }
]
```

The domain must already be on your Cloudflare account — Access can only protect
hostnames Cloudflare has DNS for. `custom_domain = true` makes wrangler create
the DNS record for you on deploy.

## 4b. Set the allowed email as a secret

```bash
npx wrangler secret put ALLOWED_EMAIL --env production
```

It prompts; paste your address and press Enter. It is not echoed and never
touches the repo.

This is a secret rather than a var in `wrangler.toml` because the repo is in
version control — a personal address does not belong in a committed file.
Workers resolve secrets and vars through the same `env` binding and a secret of
the same name wins, so nothing in the code changes.

Until it is set, the Worker refuses every request and says so in
`wrangler tail`. That is deliberate: an unset allowlist must fail closed, never
open.

## 5. First deploy

```bash
npm run deploy
```

Runs `wrangler deploy --env production`, which uploads in one call:

- the bundled Worker (`src/**`, esbuild-bundled by wrangler)
- every file under `edge/public/` as static assets
- the binding configuration from `wrangler.toml`

It does **not** apply migrations — that is step 3, and it is a separate command
on purpose so a code deploy can never silently alter your schema.

The app is not usefully reachable yet: `ACCESS_AUD` is still a placeholder, and
`verifyAccessJwt` refuses every request while that is true. That is the intended
fail-closed behaviour, and it is why deploying before configuring Access is safe.

## 6. Configure Cloudflare Access

Follow **[ACCESS-SETUP.md](ACCESS-SETUP.md)** from step 4 onward. In short:
create a self-hosted Access application on `sbc.yourdomain.com`, add one Allow
policy with the **Emails** selector set to `your@email.com`, enable
One-time PIN as the login method, then copy the AUD tag.

Put the AUD tag and your team name into **both** `[vars]` blocks in
`wrangler.toml`:

```toml
ACCESS_TEAM_DOMAIN = "yourteam"
ACCESS_AUD = "the-64-character-aud-tag"
ALLOWED_EMAIL = "your@email.com"
```

## 7. Deploy again, then verify it is actually locked

```bash
npm run deploy
```

Run these before putting any club data in:

```bash
# Public by design, and says nothing else.
curl -s https://sbc.yourdomain.com/health

# Must be 403.
curl -so /dev/null -w '%{http_code}\n' https://sbc.yourdomain.com/api/club/summary

# Must ALSO be 403. A 200 here means run_worker_first is not applying and the
# dashboard is being served straight off the asset server, skipping Access.
curl -so /dev/null -w '%{http_code}\n' https://sbc.yourdomain.com/

# A forged token with the right email must still be 403.
curl -so /dev/null -w '%{http_code}\n' \
  -H 'Cf-Access-Jwt-Assertion: eyJhbGciOiJub25lIn0.eyJlbWFpbCI6Im1hcmlvc3hlbjdAaWNsb3VkLmNvbSJ9.' \
  https://sbc.yourdomain.com/api/club/summary
```

Expected: `{"ok":true}`, then `403`, `403`, `403`.

Confirm there is no `workers.dev` route:

```bash
npx wrangler deployments list --env production
```

`workers_dev = false` handles this, but that hostname bypasses Access entirely,
so it is worth confirming rather than assuming.

---

## Pulling updates after you have filled in the config

```bash
cd edge && npm run update
```

Takes the incoming `wrangler.toml`, pulls, refills your ids from the values
`npm run setup` recorded, and deploys. Secrets are untouched — they live on
Cloudflare, not in the repo.

Hard-refresh afterwards (**Ctrl+Shift+R**); the old CSS and JS are cached.

The manual equivalent, and why it is needed at all:

The committed `wrangler.toml` holds placeholders, and yours holds real ids, so
a `git pull` that touches it will stop rather than overwrite your values:

```
error: Your local changes to the following files would be overwritten by merge
```

Take the incoming version and refill it — faster and less error-prone than
merging by hand, and `npm run setup` is idempotent, so it finds the existing
resources rather than creating new ones:

```bash
cd edge && git checkout wrangler.toml
cd .. && git pull
cd edge && npm run setup -- --account <your-account-id>
```

Anything you set by hand — the domain, team name, AUD tag — needs putting back
after, or pass them as flags:

```bash
npm run setup -- --account <id> --domain sbc.yourdomain.com --team yourteam --aud <aud-tag>
```

## Everyday commands

```bash
npm run deploy                  # push code + UI to Cloudflare
npm run tail                    # live logs: wrangler tail --env production
npm test                        # 48 tests, node + workers runtimes
npm run dev                     # local, at http://127.0.0.1:8787
```

### Local development

```bash
npm run db:migrate:local        # local SQLite under .wrangler/
npm run dev
```

`wrangler dev` runs the real Worker code, so Access still rejects everything —
that is correct, not a bug. To exercise the UI locally, run it against the
deployed app instead, or temporarily point `ACCESS_TEAM_DOMAIN` at your real
team so the login flow works.

### Changing who can get in

Two places, and both must agree:

```bash
# 1. Edit the Access policy in the Cloudflare dashboard.
# 2. Edit ALLOWED_EMAIL in wrangler.toml (both [vars] blocks), then:
npm run deploy
```

The duplication is deliberate. Widening the Access policy alone grants nothing,
because the Worker checks the address itself — so a fat-fingered policy edit
fails closed.

### Inspecting the database

```bash
npx wrangler d1 execute fc27-sbc-assistant-club --env production --remote \
  --command="SELECT COUNT(*) AS players, SUM(is_protected) AS protected FROM players"
```

### Starting over

```bash
npx wrangler d1 execute fc27-sbc-assistant-club --env production --remote \
  --command="DELETE FROM players; DELETE FROM squads; DELETE FROM club_meta"
```

Re-importing does this for you — `POST /api/import/begin` clears the club first,
because merging would leave cards you have since spent still in the database.

### Deleting everything

```bash
npx wrangler delete --env production
npx wrangler d1 delete fc27-sbc-assistant-club
npx wrangler kv namespace delete --binding ACCESS_KEYS
```

Then remove the Access application in the Zero Trust dashboard.

---

## What costs what

Configured for **Workers Paid**, which you have. Usage for one person sits far
inside what the $5/month plan includes, so there should be no usage billing on
top of the subscription:

| | Paid allowance | This app |
|---|---|---|
| Worker requests | 10,000,000/month included | a few hundred |
| Worker CPU | 30s/request (set in `[limits]`) | ~5ms for a whole SBC set |
| D1 rows read | 25,000,000,000/month | ~440 per solve |
| D1 storage | 5GB | a few MB |
| KV reads | 10,000,000/month | one per cold isolate |
| Access seats | 50 free | 1 |

The paid plan is what allows a whole SBC set to be solved in one request with
the full global allocator. It is not what makes it fast — see the README.

### Checking real CPU use

```bash
npm run tail
```

Then use the app. Each request logs its CPU time. Anything consistently over
~50ms for a solve would be worth looking at; the measured figure is ~5ms.

Do not try to measure this from inside the Worker: Workers coarsens
`Date.now()` and `performance.now()` as a Spectre mitigation, so timing a
pure-CPU section in code reports 0 regardless of what it cost.
