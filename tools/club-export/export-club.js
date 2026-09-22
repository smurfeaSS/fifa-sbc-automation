/* =====================================================================
 * FC 27 Smart SBC Assistant — club export snippet
 * =====================================================================
 *
 * WHAT THIS DOES
 *   Reads the club you already have open in the FC Web App and downloads it
 *   as a JSON file you then import into the assistant. Nothing is uploaded
 *   anywhere. Nothing is written to your account.
 *
 * HOW TO USE
 *   1. Log in to the FC Web App as normal and let it finish loading.
 *   2. Open devtools (F12) -> Console.
 *   3. Paste this whole file, press Enter.
 *   4. Wait. It reports progress and downloads `club-export-<date>.json`.
 *   5. Import with:  npm run cli -- import ./club-export-<date>.json
 *
 * SAFETY PROPERTIES (see automation.md §22, §23)
 *   - READ-ONLY. Every request is a GET, and an allowlist below rejects any
 *     URL that is not a known read endpoint. There is no code path here that
 *     buys, sells, lists, submits or modifies anything.
 *   - THROTTLED. Randomised delay between page reads, so the request pattern
 *     resembles a human scrolling their club rather than a burst.
 *   - ONE-SHOT. Runs once when you paste it, then stops. No polling, no
 *     background timer, no extension, nothing left behind.
 *   - NO CREDENTIALS. It never reads your password, and it neither stores nor
 *     transmits your session token — the token stays in the page, used only
 *     to talk to EA exactly as the app itself does.
 *   - FAILS CLOSED. Any non-200 response aborts the whole run rather than
 *     retrying into a rate limit.
 *
 * Run it when your club has meaningfully changed, not every session.
 * ===================================================================== */

(async () => {
  'use strict';

  const CONFIG = {
    /** Randomised inter-request delay. Do not lower these. */
    minDelayMs: 800,
    maxDelayMs: 1500,
    /** Items per club page. The app itself uses ~91. */
    pageSize: 91,
    /** Hard stop, so a bad response can never spin forever. ~9k items. */
    maxPages: 100,
    /** 'auto' detects from the page; override with e.g. 'fc27' if detection fails. */
    gameVersion: 'auto',
    /** true = probe and report what was found, then stop without reading. */
    probeOnly: false,
  };

/* ---------------------------------------------------------------- logging */
  const log = (...a) => console.log('%c[SBC Export]', 'color:#4ade80;font-weight:bold', ...a);
  const warn = (...a) => console.warn('%c[SBC Export]', 'color:#fbbf24;font-weight:bold', ...a);
  const err = (...a) => console.error('%c[SBC Export]', 'color:#f87171;font-weight:bold', ...a);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = () =>
    CONFIG.minDelayMs + Math.random() * (CONFIG.maxDelayMs - CONFIG.minDelayMs);

/* ------------------------------------------------------- read-only guard */
  /**
   * Only these paths may be requested. This is the single enforcement point
   * for the read-only promise above — if a URL does not match, we throw rather
   * than send it. Kept deliberately tight; widen only with good reason.
   */
  const ALLOWED_PATH_PATTERNS = [
    /\/ut\/game\/[^/]+\/club(\?|$)/, /* club item pages */
    /\/ut\/game\/[^/]+\/club\/stat\/?(\?|$)/, /* club summary counts */
    /\/ut\/game\/[^/]+\/squad\/\d+(\?|$)/, /* a saved squad */
    /\/ut\/game\/[^/]+\/squadlist(\?|$)/, /* list of saved squads */
    /\/ut\/game\/[^/]+\/user\/massinfo(\?|$)/, /* account summary (coins, counts) */
  ];

  function assertReadOnly(url, method) {
    const m = String(method || 'GET').toUpperCase();
    if (m !== 'GET') {
      throw new Error(`Refusing non-GET request (${m}). This tool is read-only.`);
    }
    const path = url.startsWith('http') ? new URL(url).pathname + new URL(url).search : url;
    if (!ALLOWED_PATH_PATTERNS.some((re) => re.test(path))) {
      throw new Error(`Refusing request to non-allowlisted path: ${path}`);
    }
  }

/* ------------------------------------------------------------- discovery */
  /**
   * The Web App is a single-page app whose internals change between versions.
   * Rather than hard-coding one access route, probe for several and report
   * what is actually present, so this stays fixable without guesswork.
   */
  function probe() {
    const found = {
      gameVersion: null,
      apiBase: null,
      sessionId: null,
      serviceLayer: null,
      notes: [],
    };

/* Game version, e.g. "fc27" — appears in the API path and often in config. */
    if (CONFIG.gameVersion !== 'auto') {
      found.gameVersion = CONFIG.gameVersion;
      found.notes.push(`game version pinned by config: ${CONFIG.gameVersion}`);
    } else {
      const fromUrl = location.href.match(/\bfc(\d{2})\b/i);
      const fromGlobal =
        (typeof window.GAME_SKU === 'string' && window.GAME_SKU.match(/fc(\d{2})/i)) ||
        (window.services?.Config?.gameSku && String(window.services.Config.gameSku).match(/fc(\d{2})/i));
      const m = fromUrl || fromGlobal;
      if (m) {
        found.gameVersion = `fc${m[1]}`;
        found.notes.push(`game version detected: ${found.gameVersion}`);
      } else {
        found.notes.push('game version NOT detected — set CONFIG.gameVersion manually');
      }
    }

/* The app's own service layer. Preferred route: requests go out through the */
/* app's real code path, so headers and session handling match exactly. */
    const svc = window.services || window.UTServices || null;
    if (svc && (svc.Club || svc.Item)) {
      found.serviceLayer = svc;
      found.notes.push('app service layer found (preferred read route)');
    } else {
      found.notes.push('app service layer NOT found — will fall back to direct GETs');
    }

/* Session id, used by the fallback route. We read it, use it for GETs to */
/* EA's own host, and never store or transmit it. */
    const sid =
      window.services?.Authentication?.sessionId ||
      window.gSessionId ||
      (() => {
        try { return JSON.parse(sessionStorage.getItem('utas_auth') || '{}').sid || null; }
        catch { return null; }
      })();
    if (sid) {
      found.sessionId = sid;
      found.notes.push('session id present (value not logged)');
    } else {
      found.notes.push('session id NOT found — direct fallback unavailable');
    }

/* API host. Varies by platform/region; prefer whatever the app is using. */
    found.apiBase =
      window.services?.Config?.utasUrl ||
      window.UTAS_BASE ||
      'https://utas.mob.v1.fut.ea.com';

    return found;
  }

/* ------------------------------------------------------------ fetch path */
  async function readJson(env, path) {
    const url = `${env.apiBase}${path}`;
    assertReadOnly(url, 'GET');

    const res = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: {
        'Accept': 'application/json',
        'X-UT-SID': env.sessionId,
      },
    });

/* Fail closed rather than retry — a retry loop against a rate limit is */
/* exactly the traffic shape we are trying not to produce. */
    if (!res.ok) {
      throw new Error(
        `Request failed with HTTP ${res.status}. Aborting.\n` +
        `If this is 401/403 your session expired — reload the Web App and rerun.\n` +
        `If this is 429 you are rate limited — wait several minutes before retrying.`
      );
    }
    return res.json();
  }

/* ---------------------------------------------------------- club reading */
  async function readClubViaServices(env) {
    const Club = env.serviceLayer.Club;
    if (!Club || typeof Club.search !== 'function') return null;

    const items = [];
    for (let page = 0; page < CONFIG.maxPages; page++) {
      const start = page * CONFIG.pageSize;
      const res = await Club.search({
        count: CONFIG.pageSize,
        start,
        sort: 'desc',
        sortBy: 'value',
        type: 'player',
      });
      const batch = res?.items || res?.response?.itemData || [];
      items.push(...batch);
      log(`read ${items.length} items (page ${page + 1})`);
      if (batch.length < CONFIG.pageSize) break;
      await sleep(jitter());
    }
    return items;
  }

  async function readClubViaApi(env) {
    if (!env.sessionId) {
      throw new Error(
        'Cannot read the club: no service layer and no session id.\n' +
        'Make sure the Web App has finished loading, then rerun. If it still ' +
        'fails, run with CONFIG.probeOnly = true and share the output.'
      );
    }

    const items = [];
    for (let page = 0; page < CONFIG.maxPages; page++) {
      const start = page * CONFIG.pageSize;
      const path =
        `/ut/game/${env.gameVersion}/club` +
        `?sort=desc&sortBy=value&type=player&start=${start}&count=${CONFIG.pageSize}`;
      const data = await readJson(env, path);
      const batch = data?.itemData || data?.items || [];
      items.push(...batch);
      log(`read ${items.length} items (page ${page + 1})`);
      if (batch.length < CONFIG.pageSize) break;
      await sleep(jitter());
    }
    return items;
  }

  async function readSquads(env) {
/* Squads tell us which players are in use, which drives a large part of */
/* the protection engine. Missing squads is not fatal — we warn and go on. */
    try {
      const path = `/ut/game/${env.gameVersion}/squadlist`;
      const data = await readJson(env, path);
      await sleep(jitter());
      return data?.squad || data?.squads || [];
    } catch (e) {
      warn('Could not read squads; active-squad protection will be unavailable.', e.message);
      return [];
    }
  }

/* ---------------------------------------------------------------- output */
  function download(obj, filename) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

/* ------------------------------------------------------------------ main */
  try {
    log('Probing the Web App...');
    const env = probe();
    env.notes.forEach((n) => log('  ·', n));

    if (!env.gameVersion) {
      throw new Error(
        'Game version could not be detected. Edit CONFIG.gameVersion at the top ' +
        "of this snippet (e.g. 'fc27') and rerun."
      );
    }

    if (CONFIG.probeOnly) {
      log('probeOnly is set — stopping without reading the club.');
      log('Findings:', { ...env, sessionId: env.sessionId ? '<present>' : null, serviceLayer: !!env.serviceLayer });
      return;
    }

    const estMin = Math.round((CONFIG.minDelayMs + CONFIG.maxDelayMs) / 2 / 1000);
    log(`Reading club. Throttled to roughly one page every ${estMin}s — this is deliberate.`);
    log('Leave this tab open and do not navigate away.');

    let rawItems = null;
    if (env.serviceLayer) {
      try {
        rawItems = await readClubViaServices(env);
      } catch (e) {
        warn('Service-layer read failed, falling back to direct GETs:', e.message);
      }
    }
    if (!rawItems || rawItems.length === 0) {
      rawItems = await readClubViaApi(env);
    }

    const rawSquads = await readSquads(env);

    const payload = {
      meta: {
        schema: 'fc-sbc-assistant/club-export@1',
        exportedAt: new Date().toISOString(),
        gameVersion: env.gameVersion,
        itemCount: rawItems.length,
        squadCount: rawSquads.length,
        readRoute: env.serviceLayer ? 'service-layer' : 'direct-get',
      },
      rawItems,
      rawSquads,
    };

    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `club-export-${stamp}.json`;
    download(payload, filename);

    log(`Done. ${rawItems.length} items, ${rawSquads.length} squads -> ${filename}`);
    log(`Next:  npm run cli -- import ./${filename}`);
  } catch (e) {
    err(e.message || e);
    err('Nothing was written to your account. Safe to retry later.');
  }
})();
