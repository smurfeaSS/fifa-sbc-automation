/**
 * Squad preview and risk warnings — automation.md §7, §8, §26.
 *
 * Turns a solved squad into the thing the user actually reads before deciding.
 * Two design rules:
 *
 *  1. Every warning names the player, the reason it was included, and what to
 *    do about it. "Valuable player detected" alone is not actionable (§8).
 *  2. The status is the *worst* thing in the squad, never an average. A squad
 *    containing one Icon is not "mostly safe".
 */

import { protectionValue } from './value';
import type { SolvedSquad } from './squadSolver';
import type { AnnotatedPlayer } from '../shared/player';
import type { Settings } from '../shared/club';

export type SquadStatus =
  | 'SAFE'
  | 'READY'
  | 'CAUTION'
  | 'EXPENSIVE'
  | 'PROTECTED PLAYER DETECTED'
  | 'MISSING PLAYERS'
  | 'NEEDS MANUAL CHECK';

export type WarningSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface Warning {
  severity: WarningSeverity;
  /** Short kind, for grouping and icons. */
  kind: string;
  /** What is wrong, naming the player. */
  message: string;
  /** Why the solver included it anyway. */
  reason: string;
  /** What the user can do. */
  recommendation: string;
  playerId?: string;
}

export interface SquadPreview {
  status: SquadStatus;
  warnings: Warning[];
  /** Cards the club cannot supply, rendered as outlined "buy this" cards. */
  missing: SolvedSquad['missing'];
  /** Ordered worst-first, for the player list in the UI. */
  players: Array<{
    player: AnnotatedPlayer;
    value: number;
    /** Why this card was chosen, in plain words. */
    rationale: string;
  }>;
  summary: {
    requiredRating: number | null;
    calculatedRating: number;
    exactRating: number;
    ratingWaste: number;
    totalValueSacrificed: number;
    tradeableValue: number;
    untradeableValue: number;
    duplicatesUsed: number;
    protectedUsed: number;
    mostExpensivePlayer: { name: string; value: number } | null;
    purchasesNeeded: number;
    purchaseCost: number;
  };
}

function rationaleFor(p: AnnotatedPlayer): string {
  const bits: string[] = [];
  if (p.isDuplicate) bits.push(`duplicate (${p.duplicateCount} owned)`);
  if (p.tradeability === 'untradeable') bits.push('untradeable');
  else bits.push('tradeable');
  if (p.cardType !== 'common' && p.cardType !== 'rare') bits.push(p.cardType);
  if (p.isFirstOwner) bits.push('first owner');
  return `${p.rating} rated, ${bits.join(', ')}`;
}

/**
 * Build the warning list.
 *
 * Thresholds come from the user's own protection settings, so a warning always
 * reflects the line *they* drew rather than one baked into the tool.
 */
function buildWarnings(squad: SolvedSquad, settings: Settings): Warning[] {
  const warnings: Warning[] = [];
  const { valueThreshold } = settings.protection;

  for (const p of squad.players) {
    const value = protectionValue(p);

    if (p.isProtected) {
      warnings.push({
        severity: 'critical',
        kind: 'protected',
        message: `${p.name} (${p.rating}) is a protected player`,
        reason: p.protectionReasons.join('; ') || 'matched a protection rule',
        recommendation:
          'Do not build this squad. Turn on Strict Protection, or unlock this ' +
          'player deliberately if you really mean to use it.',
        playerId: p.id,
      });
      continue;
    }

    if (p.cardType === 'icon' || p.cardType === 'hero') {
      warnings.push({
        severity: 'critical',
        kind: p.cardType,
        message: `${p.name} (${p.rating}) is ${p.cardType === 'icon' ? 'an Icon' : 'a Hero'}`,
        reason: 'Included because no alternative met the requirements.',
        recommendation: 'Find an alternative before building. These are rarely worth spending.',
        playerId: p.id,
      });
      continue;
    }

    if (p.evolution.isEvolved) {
      warnings.push({
        severity: 'critical',
        kind: 'evolution',
        message: `${p.name} (${p.rating}) is an Evolution card`,
        reason: 'Included because no alternative met the requirements.',
        recommendation: 'Evolutions cannot be replaced once spent. Find an alternative.',
        playerId: p.id,
      });
      continue;
    }

    if (p.inActiveSquad) {
      warnings.push({
        severity: 'high',
        kind: 'active-squad',
        message: `${p.name} (${p.rating}) is in your active squad`,
        reason: 'Included because no alternative met the requirements.',
        recommendation: 'You would be breaking up your starting XI. Check this is intended.',
        playerId: p.id,
      });
      continue;
    }

    if (p.tradeability === 'tradeable' && value >= valueThreshold) {
      warnings.push({
        severity: 'high',
        kind: 'valuable-tradeable',
        message: `${p.name} (${p.rating}) is worth approximately ${value.toLocaleString()} coins`,
        reason: 'Included because the squad could not reach the requirement without it.',
        recommendation: `Above your ${valueThreshold.toLocaleString()} coin threshold. Consider selling it and buying cheaper fodder instead.`,
        playerId: p.id,
      });
      continue;
    }

    if (p.cardType === 'promo') {
      warnings.push({
        severity: 'medium',
        kind: 'promo',
        message: `${p.name} (${p.rating}) is a promo card`,
        reason: 'Included as fodder.',
        recommendation: 'Promo prices move sharply. Check its current price before spending it.',
        playerId: p.id,
      });
      continue;
    }

    // Low-confidence values are their own risk: the card may be worth far more
    // than the estimate the solver acted on.
    if (p.value && p.value.confidence < 0.2 && p.value.coins > valueThreshold / 2) {
      warnings.push({
        severity: 'low',
        kind: 'uncertain-value',
        message: `${p.name} (${p.rating}) has an uncertain value estimate`,
        reason: `Estimated at ${p.value.coins.toLocaleString()} coins with low confidence.`,
        recommendation: 'Check its real price before building if that matters to you.',
        playerId: p.id,
      });
    }
  }

  if (squad.missing.length > 0) {
    warnings.push({
      severity: 'high',
      kind: 'missing-players',
      message: `${squad.missing.length} player(s) must be bought to complete this squad`,
      reason: 'Your club does not contain enough cards that meet the requirements.',
      recommendation:
        `Estimated cost ${squad.purchaseCost.toLocaleString()} coins: ` +
        squad.missing.map((m) => m.description).join(', '),
    });
  }

  if (squad.needsManualCheck) {
    const unverifiable = squad.checks.filter((c) => !c.satisfied);
    warnings.push({
      severity: 'medium',
      kind: 'unverifiable',
      message: 'Some requirements could not be checked locally',
      reason: unverifiable.map((c) => c.detail).join('; '),
      recommendation: 'Verify these in the game before submitting.',
    });
  }

  const order: Record<WarningSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  return warnings.sort((a, b) => order[a.severity] - order[b.severity]);
}

function statusFor(squad: SolvedSquad, warnings: readonly Warning[], settings: Settings): SquadStatus {
  if (squad.protectedUsed > 0) return 'PROTECTED PLAYER DETECTED';
  if (warnings.some((w) => w.severity === 'critical')) return 'PROTECTED PLAYER DETECTED';
  if (squad.missing.length > 0) return 'MISSING PLAYERS';
  if (!squad.satisfied) {
    return squad.needsManualCheck ? 'NEEDS MANUAL CHECK' : 'CAUTION';
  }
  if (warnings.some((w) => w.severity === 'high')) return 'EXPENSIVE';
  if (squad.tradeableValue > settings.protection.valueThreshold) return 'EXPENSIVE';
  if (warnings.length > 0) return 'CAUTION';
  return 'SAFE';
}

export function buildPreview(
  squad: SolvedSquad,
  settings: Settings,
  requiredRating: number | null,
): SquadPreview {
  const warnings = buildWarnings(squad, settings);

  const players = squad.players
    .map((player) => ({
      player,
      value: protectionValue(player),
      rationale: rationaleFor(player),
    }))
    // Most expensive first: the things worth a second look are at the top.
    .sort((a, b) => b.value - a.value);

  const mostExpensive = players[0];

  return {
    status: statusFor(squad, warnings, settings),
    warnings,
    missing: squad.missing,
    players,
    summary: {
      requiredRating,
      calculatedRating: squad.rating,
      exactRating: squad.exactRating,
      ratingWaste: squad.ratingWaste,
      totalValueSacrificed: squad.tradeableValue + squad.untradeableValue,
      tradeableValue: squad.tradeableValue,
      untradeableValue: squad.untradeableValue,
      duplicatesUsed: squad.duplicatesUsed,
      protectedUsed: squad.protectedUsed,
      mostExpensivePlayer: mostExpensive
        ? { name: mostExpensive.player.name, value: mostExpensive.value }
        : null,
      purchasesNeeded: squad.missing.length,
      purchaseCost: squad.purchaseCost,
    },
  };
}
