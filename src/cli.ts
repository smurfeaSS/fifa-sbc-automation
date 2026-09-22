#!/usr/bin/env node
/**
 * Command line interface.
 *
 * The dashboard is the main surface, but every step is available here too —
 * useful for scripting, and for checking what the solver is doing without a
 * browser in the way.
 */

import { readFile } from 'node:fs/promises';
import { importClub } from './ingest/importClub.js';
import { annotate } from './solver/protection.js';
import { solveSquad } from './solver/squadSolver.js';
import { solveSbcSet } from './solver/globalAllocator.js';
import { buildPreview } from './solver/preview.js';
import { requiredRating } from './solver/requirements.js';
import { parseRequirements } from './sbc/parseRequirements.js';
import { listSbcs } from './sbc/registry.js';
import { clubSummary, fodderOverview, duplicateGroups } from './analytics.js';
import { loadClub, saveClub, loadSettings, saveSettings } from './storage/index.js';
import type { AnnotatedPlayer } from './shared/types/player.js';

const n = (x: number) => Math.round(x).toLocaleString();

function bail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

async function requireClub(): Promise<AnnotatedPlayer[]> {
  const club = await loadClub();
  if (!club) bail('no club imported yet. Run:  npm run cli -- import <file.json>');
  const settings = await loadSettings();
  return annotate(club.players, settings);
}

// ------------------------------------------------------------------ commands

async function cmdImport(file?: string): Promise<void> {
  if (!file) bail('usage: import <club-export.json>');
  const raw = JSON.parse(await readFile(file, 'utf8'));
  const report = importClub(raw);

  await saveClub(report.club);

  console.log(`Imported ${report.imported} players, ${report.club.squads.length} squads.`);
  for (const w of report.warnings) console.log(`  warning: ${w}`);
  if (report.skipped.length > 0) {
    console.log(`  ${report.skipped.length} item(s) skipped:`);
    for (const s of report.skipped.slice(0, 5)) console.log(`    - ${s.reason}`);
  }

  const settings = await loadSettings();
  const annotated = annotate(report.club.players, settings);
  const summary = clubSummary(annotated);
  console.log(
    `\n  ${summary.totalPlayers} players | ` +
    `${summary.protectedCount} protected | ` +
    `${summary.usableCount} usable | ` +
    `est. value ${n(summary.estimatedValue)}`,
  );
}

async function cmdSummary(): Promise<void> {
  const players = await requireClub();
  const s = clubSummary(players);
  console.log('Club');
  console.log(`  Players              ${n(s.totalPlayers)}`);
  console.log(`  Estimated value      ${n(s.estimatedValue)}`);
  console.log(`  Tradeable value      ${n(s.tradeableValue)}`);
  console.log(`  Untradeable value    ${n(s.untradeableValue)}`);
  console.log(`  Protected            ${n(s.protectedCount)}`);
  console.log(`  Usable               ${n(s.usableCount)}`);
  console.log(`  Duplicate fodder     ${n(s.duplicateFodderCount)}`);
  console.log(`  High-rated fodder    ${n(s.highRatedFodderCount)}`);
  console.log('\n  By card type');
  for (const [type, count] of Object.entries(s.byCardType).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${type.padEnd(18)} ${n(count)}`);
  }
}

async function cmdFodder(): Promise<void> {
  const players = await requireClub();
  const bands = fodderOverview(players);
  console.log('Rating   Total  Tradeable  Untradeable  Duplicate  Protected      Est. value');
  let total = 0;
  for (const b of bands) {
    total += b.estimatedValue;
    console.log(
      `${String(b.rating).padStart(5)}   ${String(b.total).padStart(5)}  ` +
      `${String(b.tradeable).padStart(9)}  ${String(b.untradeable).padStart(11)}  ` +
      `${String(b.duplicate).padStart(9)}  ${String(b.protected).padStart(9)}  ` +
      `${n(b.estimatedValue).padStart(14)}`,
    );
  }
  console.log(`\nEstimated fodder value: ${n(total)} coins`);
}

async function cmdDuplicates(): Promise<void> {
  const players = await requireClub();
  const groups = duplicateGroups(players).filter((g) => g.spare.length > 0);
  if (groups.length === 0) {
    console.log('No spare duplicates. (One copy of each card is always held back.)');
    return;
  }
  console.log('Duplicate storage — spare copies only, one of each is always kept\n');
  for (const g of groups.slice(0, 50)) {
    console.log(
      `  ${String(g.rating).padStart(3)} — ${g.name.padEnd(28)} ` +
      `${g.spare.length} spare of ${g.copies.length}   ~${n(g.estimatedSpareValue)} coins`,
    );
  }
  const totalSpare = groups.reduce((a, g) => a + g.spare.length, 0);
  console.log(`\n${totalSpare} spare duplicates across ${groups.length} players.`);
}

async function cmdSbcs(): Promise<void> {
  const settings = await loadSettings();
  const { sets, notices } = await listSbcs(settings);
  for (const notice of notices) console.log(`note: ${notice}`);
  if (sets.length === 0) {
    console.log('\nNo SBCs defined. Copy an example:');
    console.log('  cp data/examples/player-upgrade.json data/sbcs/');
    return;
  }
  console.log('');
  for (const set of sets) {
    const conf = set.source.kind === 'scraped' ? ` [confidence ${(set.source.confidence * 100).toFixed(0)}%]` : '';
    console.log(`  ${set.id.padEnd(26)} ${set.name} — ${set.challenges.length} challenge(s)${conf}`);
  }
}

async function cmdSolve(sbcId?: string): Promise<void> {
  if (!sbcId) bail('usage: solve <sbc-id>   (list them with: sbcs)');
  const players = await requireClub();
  const settings = await loadSettings();
  const { sets } = await listSbcs(settings);
  const set = sets.find((s) => s.id === sbcId);
  if (!set) bail(`no SBC with id "${sbcId}". List them with:  npm run cli -- sbcs`);

  console.log(`Solving "${set.name}" across all ${set.challenges.length} challenge(s)...\n`);
  const solution = solveSbcSet(set, players, { settings });

  for (const allocated of solution.challenges) {
    const { challenge, squad, failure } = allocated;
    console.log(`${'─'.repeat(64)}`);
    console.log(`${challenge.name}`);
    if (!squad) {
      console.log(`  UNSOLVED — ${failure?.message ?? 'no solution'}\n`);
      continue;
    }

    const preview = buildPreview(squad, settings, requiredRating(challenge.requirements));
    const s = preview.summary;

    console.log(`  Required rating     ${s.requiredRating ?? '—'}`);
    console.log(`  Calculated rating   ${s.calculatedRating} (${s.exactRating.toFixed(2)})`);
    console.log(`  Rating waste        ${s.ratingWaste.toFixed(2)}`);
    console.log('');
    for (const { player, value, rationale } of preview.players) {
      const flag = player.isProtected ? ' <-- PROTECTED' : '';
      console.log(`    ${String(player.rating).padStart(3)}  ${player.name.padEnd(24)} ${n(value).padStart(9)}  ${rationale}${flag}`);
    }
    console.log('');
    console.log(`  Value sacrificed    ${n(s.totalValueSacrificed)}`);
    console.log(`    tradeable         ${n(s.tradeableValue)}`);
    console.log(`    untradeable       ${n(s.untradeableValue)}`);
    console.log(`  Duplicates used     ${s.duplicatesUsed}`);
    console.log(`  Protected used      ${s.protectedUsed}`);
    if (s.mostExpensivePlayer) {
      console.log(`  Most expensive      ${s.mostExpensivePlayer.name} (${n(s.mostExpensivePlayer.value)})`);
    }
    if (s.purchasesNeeded > 0) {
      console.log(`  Must buy            ${s.purchasesNeeded} card(s), ~${n(s.purchaseCost)} coins`);
      for (const m of squad.missing) console.log(`                      - ${m.description}`);
    }

    console.log(`\n  STATUS: ${preview.status}`);
    for (const w of preview.warnings) {
      console.log(`\n  [${w.severity.toUpperCase()}] ${w.message}`);
      console.log(`     reason: ${w.reason}`);
      console.log(`     action: ${w.recommendation}`);
    }
    console.log('');
  }

  console.log('═'.repeat(64));
  console.log('Set totals');
  console.log(`  Players used        ${solution.totals.playersUsed}`);
  console.log(`  Tradeable value     ${n(solution.totals.tradeableValue)}`);
  console.log(`  Untradeable value   ${n(solution.totals.untradeableValue)}`);
  console.log(`  Duplicates used     ${solution.totals.duplicatesUsed}`);
  console.log(`  Protected used      ${solution.totals.protectedUsed}`);
  console.log(`  Coins to buy        ${n(solution.totals.purchaseCost)}`);
  console.log(`  Completable now     ${solution.completable ? 'yes' : 'no'}`);
  console.log('\nNothing has been submitted. Build the squad in the Web App yourself.');
}

async function cmdParseSbc(): Promise<void> {
  // Reads requirement lines from stdin so text can be pasted straight in.
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const lines = Buffer.concat(chunks).toString('utf8').split('\n');
  const parsed = parseRequirements(lines);

  console.log(JSON.stringify(parsed.requirements, null, 2));
  console.log(`\n// confidence ${(parsed.confidence * 100).toFixed(0)}%`);
  for (const u of parsed.unparsed) console.log(`// could not parse: ${u}`);
}

async function cmdLock(itemId?: string): Promise<void> {
  if (!itemId) bail('usage: lock <item-id>');
  const settings = await loadSettings();
  if (!settings.protection.manualLocks.includes(itemId)) {
    settings.protection.manualLocks.push(itemId);
  }
  settings.protection.manualOverrides = settings.protection.manualOverrides.filter((i) => i !== itemId);
  await saveSettings(settings);
  console.log(`Locked ${itemId}. It will never be selected.`);
}

async function cmdVerifyRating(): Promise<void> {
  const { exactSquadRating, squadRating } = await import('./solver/rating.js');
  const args = process.argv.slice(3).map(Number).filter((x) => Number.isFinite(x));
  if (args.length === 0) {
    console.log('usage: verify-rating 84 84 84 85 85 83 83 86 84 84 84');
    console.log('\nPrints what this tool calculates. Compare against the Web App —');
    console.log('if they disagree, the formula in src/solver/rating.ts needs recalibrating.');
    return;
  }
  console.log(`players:    ${args.length}`);
  console.log(`exact:      ${exactSquadRating(args).toFixed(4)}`);
  console.log(`displayed:  ${squadRating(args)}`);
}

function usage(): void {
  console.log(`FC 27 Smart SBC Assistant

  import <file>        Import a club export from tools/club-export/
  summary              Club overview
  fodder               Fodder by rating band
  duplicates           Spare duplicate storage
  sbcs                 List available SBCs
  solve <sbc-id>       Solve an SBC across all its challenges
  parse-sbc            Parse requirement text from stdin into JSON
  lock <item-id>       Permanently lock a player
  verify-rating <...>  Check the rating formula against the game

The tool never submits anything. You build and submit the squad yourself.`);
}

async function main(): Promise<void> {
  const [, , cmd, arg] = process.argv;
  switch (cmd) {
    case 'import': return cmdImport(arg);
    case 'summary': return cmdSummary();
    case 'fodder': return cmdFodder();
    case 'duplicates': return cmdDuplicates();
    case 'sbcs': return cmdSbcs();
    case 'solve': return cmdSolve(arg);
    case 'parse-sbc': return cmdParseSbc();
    case 'lock': return cmdLock(arg);
    case 'verify-rating': return cmdVerifyRating();
    default: return usage();
  }
}

main().catch((e) => bail(e instanceof Error ? e.message : String(e)));
