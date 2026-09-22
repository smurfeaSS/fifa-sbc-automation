# Example SBC definitions

Copy any of these into `data/sbcs/` to make them available to the solver:

```
cp data/examples/player-upgrade.json data/sbcs/
```

`data/sbcs/` is gitignored — it holds your own SBC definitions, which are
personal to your game state.

## Writing your own

Each file is one SBC set containing one or more challenges. The
`requirements` array uses the structured constraint kinds defined in
`src/shared/types/sbc.ts`. The dashboard's SBC builder writes these files for
you, and `npm run cli -- parse-sbc` turns pasted requirement text into one.

Local definitions always take precedence over scraped ones — if you correct an
SBC by hand, a later scrape will not overwrite it.
