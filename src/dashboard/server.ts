/**
 * Local dashboard server — automation.md §16.
 *
 * Binds to loopback only. There is no authentication because there is no
 * network surface to authenticate: this serves your club data to your own
 * browser and nothing else. If you change the host, add auth first.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import { importClub } from '../ingest/importClub.js';
import { annotate } from '../solver/protection.js';
import { solveSbcSet } from '../solver/globalAllocator.js';
import { buildPreview } from '../solver/preview.js';
import { requiredRating } from '../solver/requirements.js';
import { parseRequirements } from '../sbc/parseRequirements.js';
import { listSbcs, saveManualSbc } from '../sbc/registry.js';
import { clubSummary, fodderOverview, duplicateGroups, searchPlayers } from '../analytics.js';
import {
  loadClub, saveClub, loadSettings, saveSettings, loadHistory, appendHistory,
} from '../storage/index.js';
import type { AnnotatedPlayer } from '../shared/types/player.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, 'public');

const PORT = Number(process.env['PORT'] ?? 7788);
const HOST = '127.0.0.1';

/** Annotated club, rebuilt whenever the club or settings change. */
let cache: { players: AnnotatedPlayer[]; stamp: number } | null = null;

async function annotatedClub(): Promise<AnnotatedPlayer[]> {
  if (cache) return cache.players;
  const club = await loadClub();
  if (!club) return [];
  const settings = await loadSettings();
  const players = annotate(club.players, settings);
  cache = { players, stamp: Date.now() };
  return players;
}

function invalidate(): void {
  cache = null;
}

function json(res: ServerResponse, body: unknown, status = 200): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    // Club data must never be cached by anything but this process.
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // A club export is the largest thing posted here; cap well above it.
    if (size > 64 * 1024 * 1024) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

async function serveStatic(res: ServerResponse, urlPath: string): Promise<void> {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  // Contain path traversal even though this is loopback-only.
  const full = normalize(join(PUBLIC_DIR, rel));
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const body = await readFile(full);
    const ext = full.slice(full.lastIndexOf('.'));
    res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}

// ----------------------------------------------------------------- endpoints

async function handleApi(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const method = req.method ?? 'GET';

  if (path === '/api/summary' && method === 'GET') {
    const players = await annotatedClub();
    const club = await loadClub();
    return json(res, {
      imported: club !== null,
      exportedAt: club?.exportedAt ?? null,
      gameVersion: club?.gameVersion ?? null,
      summary: players.length > 0 ? clubSummary(players) : null,
    });
  }

  if (path === '/api/import' && method === 'POST') {
    const body = await readBody(req);
    const report = importClub(body as never);
    await saveClub(report.club);
    invalidate();
    return json(res, {
      imported: report.imported,
      squads: report.club.squads.length,
      warnings: report.warnings,
      skipped: report.skipped.length,
    });
  }

  if (path === '/api/players' && method === 'GET') {
    const url = new URL(req.url ?? '/', `http://${HOST}`);
    const players = await annotatedClub();
    const q = url.searchParams;
    const filters = {
      ...(q.get('name') ? { name: q.get('name')! } : {}),
      ...(q.get('minRating') ? { minRating: Number(q.get('minRating')) } : {}),
      ...(q.get('maxRating') ? { maxRating: Number(q.get('maxRating')) } : {}),
      ...(q.get('cardType') ? { cardType: q.get('cardType')! } : {}),
      ...(q.get('tradeability') ? { tradeability: q.get('tradeability') as 'tradeable' | 'untradeable' } : {}),
      ...(q.get('duplicatesOnly') === 'true' ? { duplicatesOnly: true } : {}),
      ...(q.get('protectedOnly') === 'true' ? { protectedOnly: true } : {}),
      ...(q.get('unprotectedOnly') === 'true' ? { unprotectedOnly: true } : {}),
    };
    const matched = searchPlayers(players, filters);
    return json(res, {
      total: matched.length,
      players: matched
        .sort((a, b) => b.rating - a.rating)
        .slice(0, Number(q.get('limit') ?? 200)),
    });
  }

  if (path === '/api/fodder' && method === 'GET') {
    return json(res, { bands: fodderOverview(await annotatedClub()) });
  }

  if (path === '/api/duplicates' && method === 'GET') {
    const groups = duplicateGroups(await annotatedClub()).filter((g) => g.spare.length > 0);
    return json(res, { groups: groups.slice(0, 300) });
  }

  if (path === '/api/protected' && method === 'GET') {
    const players = (await annotatedClub()).filter((p) => p.isProtected);
    return json(res, { total: players.length, players: players.sort((a, b) => b.rating - a.rating) });
  }

  if (path === '/api/sbcs' && method === 'GET') {
    const settings = await loadSettings();
    const listing = await listSbcs(settings);
    return json(res, listing);
  }

  if (path === '/api/solve' && method === 'POST') {
    const body = (await readBody(req)) as { sbcId?: string };
    if (!body.sbcId) return json(res, { error: 'sbcId is required' }, 400);

    const players = await annotatedClub();
    if (players.length === 0) return json(res, { error: 'no club imported' }, 400);

    const settings = await loadSettings();
    const { sets } = await listSbcs(settings);
    const set = sets.find((s) => s.id === body.sbcId);
    if (!set) return json(res, { error: `no SBC with id ${body.sbcId}` }, 404);

    const solution = solveSbcSet(set, players, { settings });
    return json(res, {
      set: { id: set.id, name: set.name, source: set.source },
      totals: solution.totals,
      completable: solution.completable,
      unsolved: solution.unsolved,
      challenges: solution.challenges.map((c) => ({
        name: c.challenge.name,
        failure: c.failure ?? null,
        preview: c.squad
          ? buildPreview(c.squad, settings, requiredRating(c.challenge.requirements))
          : null,
      })),
    });
  }

  if (path === '/api/parse-sbc' && method === 'POST') {
    const body = (await readBody(req)) as { text?: string; name?: string };
    const lines = (body.text ?? '').split('\n');
    const parsed = parseRequirements(lines);
    return json(res, parsed);
  }

  if (path === '/api/sbc' && method === 'POST') {
    const body = (await readBody(req)) as { set?: unknown };
    if (!body.set) return json(res, { error: 'set is required' }, 400);
    await saveManualSbc(body.set as never);
    return json(res, { saved: true });
  }

  if (path === '/api/settings') {
    if (method === 'GET') return json(res, await loadSettings());
    if (method === 'POST') {
      const body = (await readBody(req)) as Record<string, unknown>;
      const current = await loadSettings();
      const next = {
        ...current,
        ...body,
        protection: { ...current.protection, ...((body['protection'] as object) ?? {}) },
        weights: { ...current.weights, ...((body['weights'] as object) ?? {}) },
        sbcSources: { ...current.sbcSources, ...((body['sbcSources'] as object) ?? {}) },
      };
      await saveSettings(next);
      invalidate(); // protection rules changed, so annotations are stale
      return json(res, next);
    }
  }

  if (path === '/api/lock' && method === 'POST') {
    const body = (await readBody(req)) as { itemId?: string; locked?: boolean };
    if (!body.itemId) return json(res, { error: 'itemId is required' }, 400);
    const settings = await loadSettings();
    const { manualLocks, manualOverrides } = settings.protection;

    if (body.locked === false) {
      settings.protection.manualLocks = manualLocks.filter((i) => i !== body.itemId);
    } else {
      if (!manualLocks.includes(body.itemId)) manualLocks.push(body.itemId);
      settings.protection.manualOverrides = manualOverrides.filter((i) => i !== body.itemId);
    }
    await saveSettings(settings);
    invalidate();
    return json(res, { locked: body.locked !== false });
  }

  if (path === '/api/history') {
    if (method === 'GET') return json(res, { entries: await loadHistory() });
    if (method === 'POST') {
      const body = (await readBody(req)) as Record<string, unknown>;
      await appendHistory({
        id: String(body['id'] ?? Date.now()),
        sbcName: String(body['sbcName'] ?? 'Unknown'),
        challengeName: String(body['challengeName'] ?? ''),
        date: new Date().toISOString(),
        playersSubmitted: Number(body['playersSubmitted'] ?? 0),
        playerIds: (body['playerIds'] as string[]) ?? [],
        estimatedValue: Number(body['estimatedValue'] ?? 0),
        tradeableValue: Number(body['tradeableValue'] ?? 0),
        untradeableValue: Number(body['untradeableValue'] ?? 0),
        duplicatesUsed: Number(body['duplicatesUsed'] ?? 0),
        ...(body['notes'] ? { notes: String(body['notes']) } : {}),
      });
      return json(res, { recorded: true });
    }
  }

  json(res, { error: 'not found' }, 404);
}

const server = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0]!;

  const run = path.startsWith('/api/')
    ? handleApi(req, res, path)
    : serveStatic(res, path);

  run.catch((e: unknown) => {
    const message = e instanceof Error ? e.message : String(e);
    if (!res.headersSent) json(res, { error: message }, 500);
    else res.end();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`FC 27 Smart SBC Assistant`);
  console.log(`  http://${HOST}:${PORT}`);
  console.log(`  All data stays on this machine. Nothing is submitted automatically.`);
});
