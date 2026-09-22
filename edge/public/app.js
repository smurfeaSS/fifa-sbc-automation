/* Dashboard front end. Plain JS on purpose — no build step, no dependencies. */
'use strict';

const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) node.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(kid instanceof Node ? kid : String(kid));
  }
  return node;
};
const n = (x) => Math.round(Number(x) || 0).toLocaleString();

/**
 * The Worker wraps every response as { success, data | error, requestId }.
 * A 403 means Cloudflare Access did not recognise you — almost always an
 * expired session, which a reload fixes by sending you back through the login.
 */
async function api(path, options) {
  const res = await fetch(path, options);
  const body = await res.json().catch(() => ({}));

  if (res.status === 403) {
    throw new Error(
      'Access denied. Your Cloudflare Access session has probably expired — reload the page to sign in again.',
    );
  }
  if (!res.ok || body.success === false) {
    const detail = body.error || `HTTP ${res.status}`;
    throw new Error(body.requestId ? `${detail} (request ${body.requestId})` : detail);
  }
  return body.data ?? body;
}

// ------------------------------------------------------------- navigation
const loaders = {};
let loaded = {};

document.querySelectorAll('nav button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    btn.classList.add('active');
    $(`#view-${btn.dataset.view}`).classList.add('active');
    const load = loaders[btn.dataset.view];
    if (load && !loaded[btn.dataset.view]) { loaded[btn.dataset.view] = true; load(); }
  });
});

/** Views re-read after an import or a settings change. */
function invalidateViews() { loaded = {}; loaders.dashboard(); }

function table(headers, rows) {
  if (rows.length === 0) return el('div', { class: 'empty' }, 'Nothing to show.');
  return el('table', {},
    el('thead', {}, el('tr', {}, headers.map((h) =>
      el('th', { class: h.num ? 'num' : '' }, h.label ?? h)))),
    el('tbody', {}, rows));
}

// -------------------------------------------------------------- dashboard
loaders.dashboard = async () => {
  const data = await api('/api/club/summary');
  const tiles = $('#dash-tiles');
  tiles.replaceChildren();

  if (!data.imported || !data.summary) {
    $('#club-stamp').textContent = 'No club imported yet — drop an export below to begin.';
    return;
  }
  const s = data.summary;
  $('#club-stamp').textContent =
    `Exported ${new Date(data.exportedAt).toLocaleString()} · ${data.gameVersion}`;

  const tile = (label, value, cls) =>
    el('div', { class: 'tile' },
      el('div', { class: 'label' }, label),
      el('div', { class: `value ${cls || ''}` }, value));

  tiles.append(
    tile('Club players', n(s.totalPlayers)),
    tile('Estimated club value', n(s.estimatedValue), 'small'),
    tile('Protected', n(s.protectedCount)),
    tile('Usable', n(s.usableCount)),
    tile('Duplicate fodder', n(s.duplicateFodderCount)),
    tile('High-rated fodder', n(s.highRatedFodderCount)),
    tile('Tradeable value', n(s.tradeableValue), 'small'),
    tile('Untradeable value', n(s.untradeableValue), 'small'),
  );
};

// ------------------------------------------------------------------ import
const drop = $('#drop');
const fileInput = $('#file');
drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault(); drop.classList.remove('over');
  if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) handleFile(fileInput.files[0]);
});

/**
 * Chunked upload.
 *
 * The Worker has a 10ms CPU budget per request, so it cannot parse a 3MB export
 * or annotate 1,800 players in one go. The file is parsed here in the browser,
 * where CPU is free, and pushed up in batches the Worker can absorb.
 */
async function handleFile(file) {
  const out = $('#import-result');
  const step = $('#import-step');
  const bar = $('#import-progress');
  const fill = bar.firstElementChild;

  out.replaceChildren();
  bar.hidden = false;
  fill.style.width = '0%';
  step.textContent = `Reading ${file.name}...`;

  try {
    const payload = JSON.parse(await file.text());
    const items = payload.rawItems ?? payload.items ?? payload.itemData ?? (Array.isArray(payload) ? payload : []);
    const squads = payload.rawSquads ?? [];
    if (!Array.isArray(items) || items.length === 0) {
      throw new Error('No club items found. Expected a rawItems array from export-club.js.');
    }

    const begin = await api('/api/import/begin', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        exportedAt: payload.meta?.exportedAt,
        gameVersion: payload.meta?.gameVersion,
      }),
    });

    const size = begin.maxChunk ?? 250;
    let sent = 0;
    for (let i = 0; i < items.length; i += size) {
      const slice = items.slice(i, i + size);
      const result = await api('/api/import/chunk', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: begin.token, items: slice }),
      });
      sent += result.inserted;
      const pct = Math.round(((i + slice.length) / items.length) * 100);
      fill.style.width = `${pct}%`;
      step.textContent = `Uploading ${sent} of ${items.length} players... ${pct}%`;
    }

    step.textContent = 'Linking squads, finding duplicates and applying protection rules...';
    const done = await api('/api/import/finish', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: begin.token, squads }),
    });

    fill.style.width = '100%';
    step.textContent = '';
    out.replaceChildren(
      el('p', {}, `Imported ${n(done.players)} players and ${done.squads} squad(s).`),
      done.squads === 0
        ? el('div', { class: 'banner' },
            'No squads in this export, so active-squad protection cannot apply. ' +
            'Lock those players by hand, or re-export with squads included.')
        : null,
    );
    invalidateViews();
  } catch (e) {
    bar.hidden = true;
    step.textContent = '';
    out.replaceChildren(el('div', { class: 'banner' }, `Import failed: ${e.message}`));
  }
}

// -------------------------------------------------------------------- club
async function loadClubTable() {
  const q = new URLSearchParams();
  if ($('#f-name').value) q.set('name', $('#f-name').value);
  if ($('#f-min').value) q.set('minRating', $('#f-min').value);
  if ($('#f-max').value) q.set('maxRating', $('#f-max').value);
  if ($('#f-trade').value) q.set('tradeability', $('#f-trade').value);
  if ($('#f-type').value) q.set('cardType', $('#f-type').value);
  if ($('#f-dup').checked) q.set('duplicatesOnly', 'true');
  if ($('#f-unprot').checked) q.set('unprotectedOnly', 'true');

  const data = await api(`/api/club/players?${q}`);
  const rows = data.players.map((p) => el('tr', {},
    el('td', { class: 'num' }, p.rating),
    el('td', {}, p.name),
    el('td', {}, p.position.primary),
    el('td', {}, p.cardType),
    el('td', {}, p.tradeability === 'tradeable' ? 'Tradeable' : 'Untradeable'),
    el('td', { class: 'num' }, n(p.value?.coins ?? 0)),
    el('td', {},
      p.isDuplicate ? el('span', { class: 'pill dup' }, `x${p.duplicateCount}`) : null,
      ' ',
      p.isProtected ? el('span', { class: 'pill prot', title: p.protectionReasons.join('; ') }, 'protected') : null),
    el('td', {}, el('button', {
      class: 'ghost',
      onclick: async (e) => {
        const locking = !p.manuallyLocked;
        await api('/api/lock', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ itemId: p.id, locked: locking }),
        });
        e.target.textContent = locking ? 'Locked' : 'Lock';
        p.manuallyLocked = locking;
      },
    }, p.manuallyLocked ? 'Locked' : 'Lock')),
  ));

  $('#club-table').replaceChildren(
    el('p', { class: 'muted' }, `${n(data.total)} matching players${data.total > data.players.length ? `, showing ${data.players.length}` : ''}.`),
    table([{ label: 'Rating', num: true }, 'Name', 'Pos', 'Card', 'Trade', { label: 'Value', num: true }, 'Flags', ''], rows),
  );
}
loaders.club = loadClubTable;
$('#f-go').addEventListener('click', loadClubTable);
$('#f-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadClubTable(); });

// ------------------------------------------------------------------ solver
loaders.solver = async () => {
  const { sets } = await api('/api/sbcs');
  $('#sbc-notices').replaceChildren();

  // The scrape button only appears when a source is actually configured —
  // offering it otherwise just produces an error on click.
  try {
    const settings = await api('/api/settings');
    $('#scrape-go').hidden = !(settings.sbcSources?.scraperEnabled && settings.sbcSources?.scraperBaseUrl);
  } catch {
    $('#scrape-go').hidden = true;
  }

  const select = $('#sbc-select');
  select.replaceChildren();
  if (sets.length === 0) {
    select.append(el('option', { value: '' }, 'No SBCs defined'));
    $('#solve-result').replaceChildren(el('div', { class: 'empty' },
      'No SBCs available. Copy an example into data/sbcs/, or enable a source in Settings.'));
    return;
  }
  for (const set of sets) {
    const conf = set.sourceKind === 'scraped'
      ? ` — ${Math.round(set.confidence * 100)}% parsed` : '';
    select.append(el('option', { value: set.id },
      `${set.name} (${set.challengeCount} challenge${set.challengeCount === 1 ? '' : 's'})${conf}`));
  }
};

/**
 * Solve the whole set in one request, falling back to the per-challenge walk.
 *
 * The single-request path runs the real global allocator, including the
 * refinement passes that release a challenge's players and re-solve it against
 * the freed pool. That is what undoes a bad early commitment — the thing the
 * sequential walk structurally cannot do.
 *
 * Measured at ~5ms for a five-squad set on a 1,500-player club, so there is no
 * reason to prefer the slower path unless the fast one actually fails.
 */
$('#solve-go').addEventListener('click', async () => {
  const sbcId = $('#sbc-select').value;
  if (!sbcId) return;

  const btn = $('#solve-go');
  btn.disabled = true;
  $('#solve-result').replaceChildren();
  $('#solve-status').textContent = 'Solving...';

  try {
    const data = await api('/api/solve/set', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sbcId }),
    });

    renderSolution(data.set, data.challenges.map((c) => ({
      challenge: c.challenge,
      solved: c.solved,
      message: c.message,
      preview: c.preview,
    })), data.searched);
    $('#solve-status').textContent = '';
  } catch (e) {
    // Fall back rather than fail: the per-challenge walk uses less CPU per
    // request and will still produce a usable answer.
    $('#solve-status').textContent = 'Retrying one squad at a time...';
    try {
      await solveChallengeByChallenge(sbcId);
      $('#solve-status').textContent = '';
    } catch (fallbackError) {
      $('#solve-result').replaceChildren(
        el('div', { class: 'banner' }, `${e.message}`),
        el('div', { class: 'banner' }, `Fallback also failed: ${fallbackError.message}`),
      );
      $('#solve-status').textContent = '';
    }
  } finally {
    btn.disabled = false;
  }
});

/** The incremental path. Kept as a fallback and for very large SBC sets. */
async function solveChallengeByChallenge(sbcId) {
  const plan = await api(`/api/solve/plan?sbcId=${encodeURIComponent(sbcId)}`);
  const results = [];
  const committedIds = [];

  for (let i = 0; i < plan.order.length; i++) {
    const ch = plan.order[i];
    $('#solve-status').textContent = `Solving ${ch.name} (${i + 1} of ${plan.order.length})...`;
    const result = await api('/api/solve/challenge', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sbcId, challengeId: ch.id, committedIds }),
    });
    if (result.solved) committedIds.push(...result.usedIds);
    results.push(result);
  }

  renderSolution(plan.set, results, null);
}

const STATUS_CLASS = {
  'SAFE': 'safe', 'READY': 'ready', 'CAUTION': 'caution', 'EXPENSIVE': 'expensive',
  'PROTECTED PLAYER DETECTED': 'danger', 'MISSING PLAYERS': 'caution',
  'NEEDS MANUAL CHECK': 'info',
};

function renderSolution(set, results, searched) {
  const out = $('#solve-result');

  // Totalled here rather than server-side: each solve is its own request, so
  // nothing on the Worker ever sees the whole set at once.
  const totals = results.reduce((acc, r) => {
    if (!r.solved) return acc;
    const s = r.preview.summary;
    acc.playersUsed += r.preview.players.length;
    acc.tradeableValue += s.tradeableValue;
    acc.untradeableValue += s.untradeableValue;
    acc.duplicatesUsed += s.duplicatesUsed;
    acc.protectedUsed += s.protectedUsed;
    acc.purchaseCost += s.purchaseCost;
    return acc;
  }, { playersUsed: 0, tradeableValue: 0, untradeableValue: 0, duplicatesUsed: 0, protectedUsed: 0, purchaseCost: 0 });

  const unsolved = results.filter((r) => !r.solved).length;
  const completable = unsolved === 0 && totals.purchaseCost === 0;

  const blocks = [
    el('div', { class: 'panel' },
      el('h3', {}, `${set.name} — set totals`),
      el('div', { class: 'tiles' },
        tileOf('Players used', n(totals.playersUsed)),
        tileOf('Tradeable value', n(totals.tradeableValue)),
        tileOf('Untradeable value', n(totals.untradeableValue)),
        tileOf('Duplicates used', n(totals.duplicatesUsed)),
        tileOf('Protected used', n(totals.protectedUsed)),
        tileOf('Coins to buy', n(totals.purchaseCost)),
      ),
      el('p', { class: 'muted' },
        completable
          ? 'Completable from your club as it stands.'
          : 'Not completable from your club alone — see the per-squad notes below.'),
      searched
        ? el('p', { class: 'muted', style: 'font-size:12px' },
            `Searched ${n(searched.poolRows)} candidate cards across ${searched.challenges} challenge${searched.challenges === 1 ? '' : 's'}.`)
        : null,
    ),
  ];

  for (const r of results) {
    if (!r.solved) {
      blocks.push(el('div', { class: 'panel' },
        el('h3', {}, r.challenge.name),
        el('div', { class: 'warn critical' },
          el('div', { class: 'msg' }, 'Could not be solved'),
          el('div', { class: 'detail' }, r.message ?? 'no solution')),
      ));
      continue;
    }

    const p = r.preview;
    const s = p.summary;

    blocks.push(el('div', { class: 'panel' },
      el('h3', {}, r.challenge.name, ' ',
        el('span', { class: `status ${STATUS_CLASS[p.status] || 'caution'}` }, p.status)),

      el('div', { class: 'tiles' },
        tileOf('Required', s.requiredRating ?? '—'),
        tileOf('Calculated', `${s.calculatedRating} (${s.exactRating.toFixed(2)})`),
        tileOf('Rating waste', s.ratingWaste.toFixed(2)),
        tileOf('Value sacrificed', n(s.totalValueSacrificed)),
        tileOf('Tradeable', n(s.tradeableValue)),
        tileOf('Duplicates', s.duplicatesUsed),
      ),

      table(
        [{ label: 'Rating', num: true }, 'Name', { label: 'Value', num: true }, 'Why this card'],
        p.players.map((row) => el('tr', {},
          el('td', { class: 'num' }, row.player.rating),
          el('td', {}, row.player.name,
            row.player.isProtected
              ? el('span', { class: 'pill prot', style: 'margin-left:6px' }, 'protected') : null),
          el('td', { class: 'num' }, n(row.value)),
          el('td', { class: 'muted' }, row.rationale),
        )),
      ),

      ...p.warnings.map((w) => el('div', { class: `warn ${w.severity}` },
        el('div', { class: 'msg' }, w.message),
        el('div', { class: 'detail' }, `Reason: ${w.reason}`),
        el('div', { class: 'detail' }, `Action: ${w.recommendation}`),
      )),

      el('div', { style: 'margin-top:12px' },
        el('button', {
          class: 'ghost',
          onclick: () => recordSubmission(set.name, r.challenge.name, p),
        }, 'Record as submitted'),
        el('span', { class: 'muted', style: 'margin-left:12px' },
          'Build this squad in the Web App yourself — nothing is submitted from here.'),
      ),
    ));
  }

  out.replaceChildren(...blocks);
}

function tileOf(label, value) {
  return el('div', { class: 'tile' },
    el('div', { class: 'label' }, label),
    el('div', { class: 'value small' }, value));
}

async function recordSubmission(sbcName, challengeName, preview) {
  await api('/api/history', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sbcName, challengeName,
      playersSubmitted: preview.players.length,
      playerIds: preview.players.map((r) => r.player.id),
      estimatedValue: preview.summary.totalValueSacrificed,
      tradeableValue: preview.summary.tradeableValue,
      untradeableValue: preview.summary.untradeableValue,
      duplicatesUsed: preview.summary.duplicatesUsed,
    }),
  });
  loaded.history = false;
  alert('Recorded. Note that this only updates your local history — it does not change your club.');
}

// -------------------------------------------------------------- duplicates
loaders.duplicates = async () => {
  const { groups } = await api('/api/club/duplicates');
  $('#dup-table').replaceChildren(table(
    [{ label: 'Rating', num: true }, 'Name', { label: 'Copies', num: true }, { label: 'Spare', num: true }, { label: 'Spare value', num: true }],
    groups.map((g) => el('tr', {},
      el('td', { class: 'num' }, g.rating),
      el('td', {}, g.name),
      el('td', { class: 'num' }, g.copies.length),
      el('td', { class: 'num' }, g.spare.length),
      el('td', { class: 'num' }, n(g.estimatedSpareValue)),
    )),
  ));
};

// ------------------------------------------------------------------ fodder
loaders.fodder = async () => {
  const { bands } = await api('/api/club/fodder');
  const total = bands.reduce((a, b) => a + b.estimatedValue, 0);
  $('#fodder-table').replaceChildren(
    el('p', { class: 'muted' }, `Estimated fodder value: ${n(total)} coins`),
    table(
      [{ label: 'Rating', num: true }, { label: 'Total', num: true }, { label: 'Tradeable', num: true },
       { label: 'Untradeable', num: true }, { label: 'Duplicate', num: true },
       { label: 'Protected', num: true }, { label: 'Est. value', num: true }],
      bands.map((b) => el('tr', {},
        el('td', { class: 'num' }, b.rating),
        el('td', { class: 'num' }, n(b.total)),
        el('td', { class: 'num' }, n(b.tradeable)),
        el('td', { class: 'num' }, n(b.untradeable)),
        el('td', { class: 'num' }, n(b.duplicate)),
        el('td', { class: 'num' }, n(b.protected)),
        el('td', { class: 'num' }, n(b.estimatedValue)),
      )),
    ),
  );
};

// --------------------------------------------------------------- protected
loaders.protected = async () => {
  const data = await api('/api/club/protected');
  $('#prot-table').replaceChildren(
    el('p', { class: 'muted' }, `${n(data.total)} protected players.`),
    table(
      [{ label: 'Rating', num: true }, 'Name', 'Card', { label: 'Value', num: true }, 'Why protected'],
      data.players.map((p) => el('tr', {},
        el('td', { class: 'num' }, p.rating),
        el('td', {}, p.name),
        el('td', {}, p.cardType),
        el('td', { class: 'num' }, n(p.value?.coins ?? 0)),
        el('td', { class: 'muted' }, p.protectionReasons.join(', ')),
      )),
    ),
  );
};

// ----------------------------------------------------------------- history
loaders.history = async () => {
  const { entries } = await api('/api/history');
  $('#hist-table').replaceChildren(table(
    ['Date', 'SBC', 'Challenge', { label: 'Players', num: true },
     { label: 'Value', num: true }, { label: 'Tradeable', num: true }, { label: 'Dupes', num: true }],
    entries.map((e) => el('tr', {},
      el('td', {}, new Date(e.date).toLocaleDateString()),
      el('td', {}, e.sbcName),
      el('td', {}, e.challengeName),
      el('td', { class: 'num' }, e.playersSubmitted),
      el('td', { class: 'num' }, n(e.estimatedValue)),
      el('td', { class: 'num' }, n(e.tradeableValue)),
      el('td', { class: 'num' }, e.duplicatesUsed),
    )),
  ));
};

// ---------------------------------------------------------------- settings
loaders.settings = async () => {
  const s = await api('/api/settings');
  $('#s-strict').checked = s.strictProtection;
  $('#s-value').value = s.protection.valueThreshold;
  $('#s-promo').value = s.protection.promoValueThreshold;
  $('#s-active').checked = s.protection.protectActiveSquad;
  $('#s-squads').checked = s.protection.protectAllSquads;
  $('#s-evo').checked = s.protection.protectEvolutions;
  $('#s-icons').checked = s.protection.protectIcons;
  $('#s-heroes').checked = s.protection.protectHeroes;
  $('#s-promos').checked = s.protection.protectPromos;
  $('#s-fav').checked = s.protection.protectFavourites;
  $('#s-single').checked = s.protection.protectSingletonRares;
  $('#s-rating').value = s.protection.protectAboveRating;
  $('#s-mode').value = s.solverMode;
  $('#s-budget').value = s.searchBudgetMs;
  $('#s-scrape').checked = s.sbcSources.scraperEnabled;
  $('#s-url').value = s.sbcSources.scraperBaseUrl;
  $('#s-ttl').value = s.sbcSources.cacheTtlMinutes;
};

/**
 * Saving settings changes which cards count as protected, so every stored
 * annotation goes stale. The Worker re-annotates in pages to stay inside its
 * CPU budget; this drives that loop to completion before reporting success,
 * because a half-annotated club means the solver is working from two different
 * sets of protection rules at once.
 */
$('#s-save').addEventListener('click', async () => {
  const btn = $('#s-save');
  btn.disabled = true;
  $('#s-saved').textContent = 'Saving...';

  try {
    const result = await api('/api/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        strictProtection: $('#s-strict').checked,
        solverMode: $('#s-mode').value,
        searchBudgetMs: Number($('#s-budget').value),
        protection: {
          valueThreshold: Number($('#s-value').value),
          promoValueThreshold: Number($('#s-promo').value),
          protectActiveSquad: $('#s-active').checked,
          protectAllSquads: $('#s-squads').checked,
          protectEvolutions: $('#s-evo').checked,
          protectIcons: $('#s-icons').checked,
          protectHeroes: $('#s-heroes').checked,
          protectPromos: $('#s-promos').checked,
          protectFavourites: $('#s-fav').checked,
          protectSingletonRares: $('#s-single').checked,
          protectAboveRating: Number($('#s-rating').value),
        },
        sbcSources: {
          scraperEnabled: $('#s-scrape').checked,
          scraperBaseUrl: $('#s-url').value,
          cacheTtlMinutes: Number($('#s-ttl').value),
        },
      }),
    });

    let { done, nextOffset } = result.reannotate;
    let total = result.reannotate.updated;
    let guard = 0;
    while (!done && guard++ < 200) {
      $('#s-saved').textContent = `Re-applying protection rules... ${n(total)} players`;
      const page = await api('/api/reannotate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offset: nextOffset }),
      });
      total += page.updated;
      done = page.done;
      nextOffset = page.nextOffset;
    }

    $('#s-saved').textContent = `Saved. Protection re-applied to ${n(total)} players.`;
    setTimeout(() => { $('#s-saved').textContent = ''; }, 5000);
    invalidateViews();
  } catch (e) {
    $('#s-saved').textContent = e.message;
  } finally {
    btn.disabled = false;
  }
});

// ── 8. identity ──────────────────────────────────────────────────────────────
/** Show the identity Access verified, so it is clear who the Worker thinks you are. */
async function loadIdentity() {
  try {
    const me = await api('/api/me');
    $('#who').textContent = me.email;
  } catch {
    $('#who').textContent = 'unknown';
  }
}

loadIdentity();
loaders.dashboard();
