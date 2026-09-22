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

async function api(path, options) {
  const res = await fetch(path, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
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
  const data = await api('/api/summary');
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

async function handleFile(file) {
  const out = $('#import-result');
  out.replaceChildren(el('p', { class: 'muted' }, `Reading ${file.name}...`));
  try {
    const text = await file.text();
    const result = await api('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: text,
    });
    out.replaceChildren(
      el('p', {}, `Imported ${n(result.imported)} players and ${result.squads} squad(s).`),
      ...(result.warnings || []).map((w) => el('div', { class: 'banner' }, w)),
      result.skipped ? el('p', { class: 'muted' }, `${result.skipped} item(s) skipped.`) : null,
    );
    invalidateViews();
  } catch (e) {
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

  const data = await api(`/api/players?${q}`);
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
  const { sets, notices } = await api('/api/sbcs');
  $('#sbc-notices').replaceChildren(...notices.map((x) => el('div', { class: 'banner' }, x)));

  const select = $('#sbc-select');
  select.replaceChildren();
  if (sets.length === 0) {
    select.append(el('option', { value: '' }, 'No SBCs defined'));
    $('#solve-result').replaceChildren(el('div', { class: 'empty' },
      'No SBCs available. Copy an example into data/sbcs/, or enable a source in Settings.'));
    return;
  }
  for (const set of sets) {
    const conf = set.source.kind === 'scraped'
      ? ` — ${Math.round(set.source.confidence * 100)}% parsed` : '';
    select.append(el('option', { value: set.id },
      `${set.name} (${set.challenges.length} challenge${set.challenges.length === 1 ? '' : 's'})${conf}`));
  }
};

$('#solve-go').addEventListener('click', async () => {
  const sbcId = $('#sbc-select').value;
  if (!sbcId) return;
  const btn = $('#solve-go');
  btn.disabled = true;
  $('#solve-status').textContent = 'Solving all challenges together...';
  $('#solve-result').replaceChildren();

  try {
    const data = await api('/api/solve', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sbcId }),
    });
    renderSolution(data);
    $('#solve-status').textContent = '';
  } catch (e) {
    $('#solve-result').replaceChildren(el('div', { class: 'banner' }, e.message));
    $('#solve-status').textContent = '';
  } finally {
    btn.disabled = false;
  }
});

const STATUS_CLASS = {
  'SAFE': 'safe', 'READY': 'ready', 'CAUTION': 'caution', 'EXPENSIVE': 'expensive',
  'PROTECTED PLAYER DETECTED': 'danger', 'MISSING PLAYERS': 'caution',
  'NEEDS MANUAL CHECK': 'info',
};

function renderSolution(data) {
  const out = $('#solve-result');
  const t = data.totals;

  const blocks = [
    el('div', { class: 'panel' },
      el('h3', {}, `${data.set.name} — set totals`),
      el('div', { class: 'tiles' },
        tileOf('Players used', n(t.playersUsed)),
        tileOf('Tradeable value', n(t.tradeableValue)),
        tileOf('Untradeable value', n(t.untradeableValue)),
        tileOf('Duplicates used', n(t.duplicatesUsed)),
        tileOf('Protected used', n(t.protectedUsed)),
        tileOf('Coins to buy', n(t.purchaseCost)),
      ),
      el('p', { class: 'muted' },
        data.completable
          ? 'Completable from your club as it stands.'
          : 'Not completable from your club alone — see the per-squad notes below.'),
    ),
  ];

  for (const ch of data.challenges) {
    if (!ch.preview) {
      blocks.push(el('div', { class: 'panel' },
        el('h3', {}, ch.name),
        el('div', { class: 'warn critical' },
          el('div', { class: 'msg' }, 'Could not be solved'),
          el('div', { class: 'detail' }, ch.failure?.message ?? 'no solution')),
      ));
      continue;
    }
    const p = ch.preview;
    const s = p.summary;

    blocks.push(el('div', { class: 'panel' },
      el('h3', {}, ch.name, ' ',
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
          onclick: () => recordSubmission(data.set.name, ch.name, p),
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
  const { groups } = await api('/api/duplicates');
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
  const { bands } = await api('/api/fodder');
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
  const data = await api('/api/protected');
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

$('#s-save').addEventListener('click', async () => {
  await api('/api/settings', {
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
  $('#s-saved').textContent = 'Saved. Protection rules re-applied to your club.';
  setTimeout(() => { $('#s-saved').textContent = ''; }, 4000);
  invalidateViews();
});

loaders.dashboard();
