# FC 27 Smart SBC Assistant

A local tool that works out how to complete Squad Building Challenges from
players you already own, without burning anything valuable.

It analyses your club, reads SBC requirements, solves every challenge in a set
together, and shows you the proposed squad with what it costs you. **It never
submits anything.** You build and submit the squad yourself.

## What it actually does

- **Protects what matters.** Icons, Heroes, Evolutions, squad players,
  favourites and anything above your coin threshold are off limits. Under
  strict mode the solver will report that an SBC cannot be completed rather
  than spend one.
- **Optimises across the whole SBC set, not one squad at a time.** Given
  `83 / 84 / 84+TOTW / 85 / 86`, it works out the allocation across all five,
  so your cheap 86s are not spent inside the 84 squad leaving you to buy 86s
  later.
- **Minimises rating waste.** An 84 SBC gets an 84.02 squad, not an 86.2 one.
- **Prefers duplicates and untradeables** over tradeable cards you could sell.
- **Tells you what is missing.** "1 × 86 rated card under ~9,000 coins" rather
  than "cannot complete".

On a 1,850-player club it solves a five-squad set in about 20ms.

## Getting started

```bash
pnpm install
npm run build
```

### 1. Export your club

Open the FC Web App, log in, open devtools (F12) → Console, and paste
[`tools/club-export/export-club.js`](tools/club-export/export-club.js). It
reads your club and downloads a JSON file.

Read [the export README](tools/club-export/README.md) first — it explains what
the snippet does, why it paces itself, and the terms-of-service position.

### 2. Import it

```bash
npm run cli -- import ~/Downloads/club-export-2026-09-22.json
```

### 3. Add an SBC

```bash
cp data/examples/player-upgrade.json data/sbcs/
```

Or paste requirement text straight from the game:

```bash
npm run cli -- parse-sbc <<'EOF'
Squad Rating: Min 84
Number of players in the Squad: 11
Rare: Min 4
EOF
```

### 4. Solve it

```bash
npm run cli -- solve player-upgrade
```

Or use the dashboard:

```bash
npm start          # http://127.0.0.1:7788
```

## Dashboard

Dashboard · Club · SBC Solver · Duplicates · Fodder · Protected Players ·
SBC History · Settings.

Binds to loopback only, with no authentication because there is no network
surface to authenticate. If you change the host, add auth first.

## CLI

| Command | What it does |
|---|---|
| `import <file>` | Import a club export |
| `summary` | Club overview |
| `fodder` | Fodder by rating band |
| `duplicates` | Spare duplicates (one of each is always held back) |
| `sbcs` | List available SBCs |
| `solve <sbc-id>` | Solve an SBC across all its challenges |
| `parse-sbc` | Parse requirement text from stdin |
| `lock <item-id>` | Permanently lock a player |
| `verify-rating <ratings...>` | Check the rating formula against the game |

## Architecture

```
tools/club-export/   one-shot devtools snippet, read-only
src/shared/          player, SBC and settings models + validation
src/ingest/          raw export -> domain model
src/solver/          rating, chemistry, value, protection, squad solver,
                     global allocator, preview and warnings
src/sbc/             requirement parser, local definitions, scraper
src/storage/         club, settings and history on disk
src/dashboard/       loopback web UI
```

### How the solver works

Searching player combinations is hopeless — an 1,800-player club has
astronomically many 11-card squads. Instead it searches **rating multisets**
("two 86s, four 84s, five 83s"), because for any fixed multiset the cheapest
squad is simply the cheapest players at each rating. That is a small space, and
branch-and-bound prunes most of it.

Constraints unrelated to rating (nations, leagues, rare counts) are then
satisfied by a repair pass that only swaps players **within the same rating**,
so it cannot disturb the rating the search just optimised.

The objective is the cost function from `automation.md` §25:

```
tradeable_value_loss + rating_waste + protected_penalty
  + rare_card_penalty + purchase_cost
```

Protected players cost `Infinity` under strict mode, so protection is
structural rather than a matter of the weights being large enough.

## Calibration

Two formulas are not published by EA and are reproduced from observed
behaviour:

- **Squad rating** (`src/solver/rating.ts`) — the mean plus the summed excess of
  above-average players. Check it against the game with
  `npm run cli -- verify-rating 84 84 85 ...` before trusting a submission.
- **Chemistry** (`src/solver/chemistry.ts`) — the FC24/FC25 threshold model.

Both are isolated in a single file each so recalibrating is a one-file change.

Requirements the parser cannot read are preserved as `unparsed` and always
report as unsatisfied, so a squad containing one is never shown as SAFE.

## Privacy

Club data stays in `./data`, which is gitignored. Nothing is uploaded. The tool
never asks for your EA password, never stores credentials, and never transmits
your session token.

## About EA's terms

Using any third-party tool with the Web App is against EA's terms, regardless
of how careful the tool is. Everything from the data models through the solver
touches EA not at all — only the export snippet does, and it is read-only,
throttled, one-shot, and makes no transfer-market requests.

That is the mildest end of the category, not an exemption. Decide with that in
mind.

## Not a bot

No buying, no selling, no sniping, no automated submission, no background
process. The final action is always yours.
