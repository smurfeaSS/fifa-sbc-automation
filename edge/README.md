# FC 27 Smart SBC Assistant — Cloudflare edition

The SBC solver as a private web app on Cloudflare Workers, reachable only by
**mariosxen7@icloud.com** through Cloudflare Access.

Built to the conventions and constraints in the `cloudflare-edge` repo: Hono,
D1 via Drizzle, KV, Workers Assets.

## Setup

**[ACCESS-SETUP.md](ACCESS-SETUP.md) is the one to read.** It covers the D1 and
KV setup, the Access application and policy, and — importantly — how to verify
the thing is actually locked before you put your club in it.

```bash
cd edge
npm install
npm run db:create && npm run kv:create   # paste the ids into wrangler.toml
npm run db:migrate:production
npm run deploy
```

## How it differs from the local build

The local version keeps everything on your machine and never talks to anything.
This one puts your club on Cloudflare so you can reach it from a phone. That is
a real trade, made deliberately — `automation.md` §22 asked for local-only, and
this is a considered departure from it, not an oversight.

The architecture also had to change, because a Worker gets **10ms of CPU per
request** on the free plan (`CLAUDE.md` §17) and the local build used roughly
double that for a single SBC set:

| | Local | Cloudflare |
|---|---|---|
| Club storage | one JSON file | D1 rows |
| Protection | recomputed per solve | precomputed into indexed columns |
| Solver input | all ~1,800 players | ~400-row candidate pool |
| Import | one pass | chunked, 250 players per request |
| SBC set | solved in one call | one challenge per request |
| Scraper | cheerio | not ported — see below |

**The candidate pool** is the interesting one. A solve only ever needs the
cheapest few players at each rating: anything more expensive at the same rating
is dominated and cannot appear in an optimal squad. So the Worker asks for the
cheapest 12 per rating in a band around the target and never reads the rest of
the club. `tests/solver.test.ts` checks this produces the same squads as
solving against the whole club, across targets 83–87, rather than assuming it.

**Set solving** is split across requests. The Worker computes the order —
hardest challenge first, which is what stops cheap high-rated cards being spent
on the low squad — and the browser walks it, carrying committed player ids
forward. What is lost relative to the local build is the refinement pass that
could undo a bad early commitment; `src/solver/ordering.ts` says so plainly.

## Endpoints

Everything except `/health` requires a verified Access identity.

| Route | Purpose |
|---|---|
| `GET /health` | Liveness. Public, and deliberately says nothing else. |
| `GET /api/me` | The identity Access verified. |
| `POST /api/import/{begin,chunk,finish}` | Chunked club import. |
| `GET /api/solve/plan?sbcId=` | Challenge order, hardest first. |
| `POST /api/solve/challenge` | Solve one challenge. |
| `GET /api/club/{summary,players,fodder,duplicates,protected}` | Club views. |
| `GET/POST /api/settings`, `POST /api/reannotate` | Settings, and the paged re-annotation a settings change requires. |
| `POST /api/lock` | Lock or unlock a player. |
| `GET/POST /api/sbcs`, `POST /api/parse-sbc` | SBC definitions. |
| `GET/POST /api/history` | Submission history. |

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

## Not ported

- **The SBC scraper.** It used cheerio, which `CLAUDE.md` §17 rules out as a
  heavy import. Rebuilding it on `HTMLRewriter` is the right move and has not
  been done. `POST /api/parse-sbc` still turns pasted requirement text into
  structured constraints, which covers the same need with one paste.
- **The CLI.** Superseded by the web UI.
- **Chemistry-constrained solving.** Ported and available, but as in the local
  build it needs a formation assignment to evaluate, so chemistry requirements
  report as unverified rather than silently passing.

## Still to calibrate

Unchanged from the local build, and still important: the squad-rating formula
and the chemistry thresholds are reproduced from observed behaviour, not
published by EA. Check them against the game before trusting a submission. Both
are isolated to one file each.
