/**
 * Turns a raw club export into a validated Club, and reports what it could not
 * make sense of rather than silently dropping it.
 */

import { normalizeItem, type RawItem } from './normalizers.js';
import { estimateValue } from '../solver/value.js';
import type { Club, Squad } from '../shared/types/club.js';
import type { Player } from '../shared/types/player.js';

export interface ClubExport {
  meta?: {
    schema?: string;
    exportedAt?: string;
    gameVersion?: string;
  };
  rawItems?: RawItem[];
  rawSquads?: unknown[];
  /** Tolerated shorthand: a bare array of items. */
  [k: string]: unknown;
}

export interface ImportReport {
  club: Club;
  imported: number;
  skipped: { reason: string; sample: RawItem }[];
  warnings: string[];
}

function extractItems(data: ClubExport | RawItem[]): RawItem[] {
  if (Array.isArray(data)) return data as RawItem[];
  if (Array.isArray(data.rawItems)) return data.rawItems;
  // Be forgiving about hand-assembled files.
  for (const key of ['items', 'itemData', 'players', 'club']) {
    const v = (data as Record<string, unknown>)[key];
    if (Array.isArray(v)) return v as RawItem[];
  }
  return [];
}

function normalizeSquads(rawSquads: unknown[]): Squad[] {
  const squads: Squad[] = [];
  for (const rs of rawSquads) {
    if (!rs || typeof rs !== 'object') continue;
    const r = rs as Record<string, unknown>;
    const id = String(r['id'] ?? r['squadId'] ?? squads.length);

    // Squad payloads nest player ids under `players[].itemData.id` in some
    // versions and expose a flat id array in others.
    let playerIds: string[] = [];
    const players = r['players'];
    if (Array.isArray(players)) {
      playerIds = players
        .map((p) => {
          if (!p || typeof p !== 'object') return undefined;
          const pr = p as Record<string, unknown>;
          const nested = pr['itemData'] as Record<string, unknown> | undefined;
          const raw = nested?.['id'] ?? pr['id'] ?? pr['itemId'];
          return raw === undefined || raw === null ? undefined : String(raw);
        })
        .filter((x): x is string => !!x && x !== '0');
    }

    squads.push({
      id,
      name: String(r['squadName'] ?? r['name'] ?? `Squad ${id}`),
      formation: typeof r['formation'] === 'string' ? r['formation'] : undefined,
      playerIds,
      // EA marks the active squad with id 0 in most versions; treat the first
      // squad as active if nothing says otherwise, since active-squad
      // protection failing open would be the dangerous direction.
      isActive: r['isActive'] === true || id === '0',
    });
  }
  if (squads.length > 0 && !squads.some((s) => s.isActive)) {
    squads[0]!.isActive = true;
  }
  return squads;
}

/**
 * Annotate duplicate state.
 *
 * Duplicates are defined by shared assetId — the same footballer, regardless of
 * card version. Two different special versions of one player are still
 * duplicates for SBC purposes, which is what §11 and §3 care about.
 */
function markDuplicates(players: Player[]): void {
  const byAsset = new Map<string, Player[]>();
  for (const p of players) {
    const list = byAsset.get(p.assetId);
    if (list) list.push(p);
    else byAsset.set(p.assetId, [p]);
  }
  for (const group of byAsset.values()) {
    for (const p of group) {
      p.duplicateCount = group.length;
      p.isDuplicate = group.length > 1;
    }
  }
}

function markSquadUsage(players: Player[], squads: Squad[]): void {
  const byId = new Map(players.map((p) => [p.id, p]));
  for (const squad of squads) {
    for (const pid of squad.playerIds) {
      const p = byId.get(pid);
      if (!p) continue;
      p.squadUsage.push(squad.id);
      if (squad.isActive) p.inActiveSquad = true;
    }
  }
}

export function importClub(data: ClubExport | RawItem[]): ImportReport {
  const meta = Array.isArray(data) ? {} : (data.meta ?? {});
  const rawItems = extractItems(data);
  const warnings: string[] = [];

  if (rawItems.length === 0) {
    throw new Error(
      'No club items found in this file. Expected a `rawItems` array produced ' +
      'by tools/club-export/export-club.js.'
    );
  }

  const players: Player[] = [];
  const skipped: { reason: string; sample: RawItem }[] = [];
  for (const raw of rawItems) {
    const result = normalizeItem(raw);
    if (result.ok) players.push(result.player);
    else skipped.push({ reason: result.reason, sample: raw });
  }

  const rawSquads = Array.isArray(data) ? [] : ((data.rawSquads as unknown[]) ?? []);
  const squads = normalizeSquads(rawSquads);
  if (squads.length === 0) {
    warnings.push(
      'No squads in this export. Active-squad protection cannot apply — ' +
      'lock those players by hand, or re-export with squads included.'
    );
  }

  markDuplicates(players);
  markSquadUsage(players, squads);

  for (const p of players) p.value = estimateValue(p);

  const unknownCards = players.filter((p) => p.cardType === 'unknown').length;
  if (unknownCards > 0) {
    warnings.push(
      `${unknownCards} card(s) have an unrecognised rarity id and were left as ` +
      `'unknown'. They are usable but not auto-protected — check them in the ` +
      `Club view before solving.`
    );
  }
  if (skipped.length > 0) {
    warnings.push(`${skipped.length} raw item(s) could not be read and were skipped.`);
  }

  const club: Club = {
    exportedAt: meta.exportedAt ?? new Date().toISOString(),
    gameVersion: meta.gameVersion ?? 'unknown',
    players,
    squads,
  };

  return { club, imported: players.length, skipped, warnings };
}
