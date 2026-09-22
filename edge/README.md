# FC 27 Smart SBC Assistant — Cloudflare edition

The SBC solver as a private web app on Cloudflare Workers, reachable only by a
single address you nominate, through Cloudflare Access.

That address is set as a Worker secret (`wrangler secret put ALLOWED_EMAIL`),
not committed — see [DEPLOY.md](DEPLOY.md).

Built to the conventions and constraints in the `cloudflare-edge` repo: Hono,
D1 via Drizzle, KV, Workers Assets.

## Setup

**[ACCESS-SETUP.md](ACCESS-SETUP.md) is the one to read.** It covers the D1 and
KV setup, the Access application and policy, and — importantly — how to verify
the thing is actually locked before you put your club in it.

**[DEPLOY.md](DEPLOY.md)** has every wrangler command, with the resource names
this app uses. GitHub holds the source; Cloudflare gets everything through
`wrangler` — `wrangler deploy` uploads the Worker and the whole of `public/` in
one call, so there is no separate front-end step.

```bash
cd edge
npm install
npm run db:create              # wrangler d1 create fc27-sbc-assistant-club
npm run kv:create              # wrangler kv namespace create ACCESS_KEYS
# paste the printed ids into wrangler.toml (both [vars] and [env.production])
npm run db:migrate:production
npm run deploy
```

## How it differs from the local build

The local version keeps everything on your machine and never talks to anything.
This one puts your club on Cloudflare so you can reach it from a phone. That is
a real trade, made deliberately — `automation.md` §22 asked for local-only, and
this is a considered departure from it, not an oversight.

The architecture also changed. The free plan gives a Worker **10ms of CPU per
request** (`CLAUDE.md` §17), which the local build exceeded for a single SBC
set. This runs on **Workers Paid**, where the allowance is 30s and declared
explicitly in `wrangler.toml` under `[limits]`, so most of that pressure is
gone — but the bounded-read design was kept, because reading a fixed number of
rows regardless of club size is simply better, not a workaround:

| | Local | Cloudflare |
|---|---|---|
| Club storage | one JSON file | D1 rows |
| Protection | recomputed per solve | precomputed into indexed columns |
| Solver input | all ~1,800 players | ~440-row candidate pool |
| Import | one pass | chunked, 1,000 players per request |
| SBC set | solved in one call | solved in one call |
| Scraper | cheerio | HTMLRewriter, streaming |

**The candidate pool** is the interesting one. A solve only ever needs the
cheapest few players at each rating: anything more expensive at the same rating
is dominated and cannot appear in an optimal squad. So the Worker asks for the
cheapest 12 per rating in a band around the target and never reads the rest of
the club. `tests/solver.test.ts` checks this produces the same squads as
solving against the whole club, across targets 83–87, rather than assuming it.

**Set solving** runs in one request on the paid plan, using the full global
allocator — hardest challenge first, several candidate orderings, and
refinement passes that release a challenge's players and re-solve against the
freed pool. The refinement is what undoes a bad early commitment, which is the
`automation.md` §5 failure mode.

Measured on a 1,561-player club: **5.3ms median for a whole five-squad set**
(3.8ms best, 17.5ms worst), producing 55 players, all duplicates, zero
tradeable value spent and zero purchases.

The per-challenge walk is kept as a fallback and still works, so the app
degrades rather than fails if a set is ever large enough to hit the ceiling.

### Why it is fast

Not because of the CPU allowance — it was already single-digit milliseconds on
the free plan. It is fast because of the search itself: branch-and-bound over
rating multisets returns the moment it has *proved* no better squad exists,
which is usually after exploring a tiny part of the tree. The paid allowance
only raises the ceiling, so the search now stops because it has finished rather
than because it ran out of budget.

The candidate pool matters too: a solve reads a bounded number of rows
(60 per rating in the band) regardless of club size, so a 3,000-player club
solves as fast as an 800-player one.

**Do not try to measure this from inside the Worker.** Workers coarsens
`Date.now()` and `performance.now()` as a Spectre mitigation — they advance only
on I/O, so any pure-CPU section reads 0ms however long it took. Real CPU time
comes from `wrangler tail`.

## Player cards

Squads render as FUT-style cards — rating and position top left, name across
the bottom, club / league / nation beneath, and a treatment per card type
(bronze, silver, gold, gold rare, TOTW, Icon, Hero, promo, Evolution). Corner
markers show what the solver cares about: a red LOCK on a protected card, a
blue count on a duplicate, UT on an untradeable, and a purple BUY on an
outlined card the club cannot supply.

The cards are **drawn in CSS, not copied**. EA's card artwork and player images
are theirs, so nothing here ships their assets. The table of reasoning sits
under a disclosure below each squad, since a card has no room for "why this
one".

## Market prices and buying

The tool does **not** query the live transfer market, and this is deliberate
rather than unfinished. Searching listings by criteria in a loop is the sniping
pattern, it is the riskiest possible interaction with EA's servers, and
`automation.md` §23 rules it out explicitly. FUTBIN has no public API and sits
behind bot protection, so scraping prices from it is not reliable either.

Instead, the **Market Prices** page takes a pasted or uploaded price list —
rows copied off a price site, or a spreadsheet export. The parser is forgiving
about shape (commas, tabs, aligned columns, `1,250,000`, `1.4m`, `12k`, with or
without a name) and reports any line it cannot read **with its line number**,
because a price list that quietly lost half its rows would make the solver
confidently wrong about what things cost.

When an SBC needs a card you do not own, the suggestion gives:

- the **cheapest real cards** at that rating, if a price list has been imported
- the **exact transfer-search filters** either way — quality, rarity, rating,
  any nation or league the SBC forces, and a Max Buy Now figure

§15 is explicit that a generic requirement beats naming a specific footballer
you then have to hunt for. The filter list is what turns "you need an 86" into
a ten-second search.

## Endpoints

Everything except `/health` requires a verified Access identity.

| Route | Purpose |
|---|---|
| `GET /health` | Liveness. Public, and deliberately says nothing else. |
| `GET /api/me` | The identity Access verified. |
| `POST /api/import/{begin,chunk,finish}` | Chunked club import. |
| `GET /api/solve/plan?sbcId=` | Challenge order, hardest first. |
| `POST /api/solve/set` | Solve a whole SBC set with global allocation. |
| `POST /api/solve/challenge` | Solve one challenge (fallback path). |
| `GET /api/club/{summary,players,fodder,duplicates,protected}` | Club views. |
| `GET/POST /api/settings`, `POST /api/reannotate` | Settings, and the paged re-annotation a settings change requires. |
| `POST /api/lock` | Lock or unlock a player. |
| `GET/POST /api/sbcs`, `POST /api/parse-sbc` | SBC definitions. |
| `POST /api/scrape/{index,page}` | Refresh SBCs from the configured site. |
| `GET/POST /api/history` | Submission history. |
| `GET/POST/DELETE /api/prices` | Market price list. |

Every response is bounded to 100 rows, per `CLAUDE.md` §17.

## Tests

```bash
npm test
```

24 tests. Twelve cover Access verification, written as attacks rather than happy
paths: `alg: none`, HS256 key confusion, tampered payload, unknown signing key,
wrong issuer, wrong audience, expired, not-yet-valid, and
unconfigured-fails-closed. Twelve cover the solver, including the candidate-pool
equivalence claim and the CPU budget.

## The scraper

Rebuilt on `HTMLRewriter`, Cloudflare's native streaming parser. cheerio is out:
`CLAUDE.md` §17 forbids heavy library imports, and building a DOM for a page
you only need six values from is exactly the "heavy synchronous computation"
it warns against. HTMLRewriter adds nothing to the bundle and never
materialises a tree.

The cost is that it is streaming and stateless — there is no
`node.find(child)`, because by the time a handler runs there is no tree to
query. So the parsers are small state machines driven by document order: an
element handler opens a record, its descendants' handlers fill it in, and
`onEndTag` closes it. Text arrives in chunks and is accumulated until
`lastInTextNode`; reading only the first chunk would silently truncate any
requirement long enough to be split.

It is off by default and needs an explicit base URL. When on, the UI shows a
**Refresh from source** button that fetches the index, then each set as its own
request — parsing costs CPU, so a dozen pages in one request would exceed the
budget.

Guards, all of which exist because the input is not yours:

- `assertSameHost` refuses any URL off the configured host or not over HTTPS.
  Set URLs come from a scraped page, so without it the endpoint would be an
  open proxy — any link on that page could make the Worker fetch anything.
- Hard caps on sets, challenges, requirement lines, text length and response
  size, so a hostile or merely enormous page cannot exhaust the CPU budget.
- A hand-corrected SBC is never overwritten by a scrape.
- Requirement text that cannot be read is kept as `unparsed` and lowers the
  set's confidence, rather than being guessed at or dropped.

**The default selectors are not calibrated against any live site** — no site was
available to check them against. Expect to adjust them once by looking at the
page source. They are settings rather than code because markup changes are
routine, not a bug to be fixed in a release.

Scraping is against most community sites' terms of service. If the site offers
an API, use that instead.

## Not ported

- **The CLI.** Superseded by the web UI.
- **Chemistry-constrained solving.** Ported and available, but as in the local
  build it needs a formation assignment to evaluate, so chemistry requirements
  report as unverified rather than silently passing.

## Still to calibrate

Unchanged from the local build, and still important: the squad-rating formula
and the chemistry thresholds are reproduced from observed behaviour, not
published by EA. Check them against the game before trusting a submission. Both
are isolated to one file each.
