/**
 * Requirement text -> structured constraints.
 *
 * Shared by every SBC source: the scraper, pasted text, and hand-written JSON
 * all end up here. In-game requirement lines are terse and fairly consistent
 * ("Squad Rating: Min 84", "Same League Count: Min 5"), which makes them
 * parseable, but EA rewords them between titles.
 *
 * The governing rule: never guess. A line we do not recognise becomes an
 * `unparsed` requirement carrying the original text, which checkRequirement
 * always reports as unsatisfied. That surfaces in the UI as "check this by
 * hand" and keeps the squad out of SAFE state. Silently dropping a requirement
 * we failed to read would produce a squad the game then rejects — or worse, one
 * that passes for the wrong reasons.
 */

import type { Comparator, Requirement } from '../shared/types/sbc.js';

/** Card quality bands, used by "Player Quality" lines. */
const QUALITY_MIN_RATING: Record<string, number> = {
  bronze: 0,
  silver: 65,
  gold: 75,
};

function normalise(line: string): string {
  return line
    .replace(/\s+/g, ' ')
    .replace(/[：]/g, ':')
    .trim();
}

/** Pull "Min 5" / "Max 3" / "Exactly 2" / a bare number out of a value part. */
function extractCount(value: string, fallback: Comparator = 'min'):
  { comparator: Comparator; value: number } | null {
  const v = value.toLowerCase().trim();

  const m = v.match(/(min(?:imum)?|max(?:imum)?|exactly|exact)\D{0,3}(\d+)/);
  if (m) {
    const word = m[1]!;
    const comparator: Comparator =
      word.startsWith('min') ? 'min' : word.startsWith('max') ? 'max' : 'exact';
    return { comparator, value: Number(m[2]) };
  }

  const bare = v.match(/(\d+)/);
  if (bare) return { comparator: fallback, value: Number(bare[1]) };

  return null;
}

/** Split "Label: value" into its parts. Falls back to treating it all as label. */
function splitLine(line: string): { label: string; value: string } {
  const idx = line.indexOf(':');
  if (idx === -1) return { label: line.toLowerCase(), value: line };
  return {
    label: line.slice(0, idx).toLowerCase().trim(),
    value: line.slice(idx + 1).trim(),
  };
}

type Matcher = (label: string, value: string, whole: string) => Requirement | null;

/**
 * Ordered matchers. Order matters where labels overlap — "same league count"
 * must be tested before the generic "league" matcher.
 */
const MATCHERS: Matcher[] = [
  // Squad / team rating.
  (label, value) => {
    if (!/\b(squad|team)\s*rating\b/.test(label)) return null;
    const c = extractCount(value);
    return c ? { kind: 'squad-rating', comparator: c.comparator, value: c.value } : null;
  },

  // Chemistry.
  (label, value) => {
    if (!/\bchemistry\b/.test(label)) return null;
    const c = extractCount(value);
    return c ? { kind: 'team-chemistry', comparator: c.comparator, value: c.value } : null;
  },

  // Squad size.
  (label, value) => {
    if (!/\bnumber of players\b|\bsquad size\b|\bplayers in the squad\b/.test(label)) return null;
    const c = extractCount(value, 'exact');
    return c ? { kind: 'player-count', value: c.value } : null;
  },

  // "Same League Count: Min 5" and its nation/club siblings.
  (label, value) => {
    const m = label.match(/\bsame (league|nation|nationality|club|team)\b/);
    if (!m) return null;
    const c = extractCount(value);
    if (!c) return null;
    const what = m[1]!;
    if (what === 'league') return { kind: 'same-league', value: c.value };
    if (what === 'club' || what === 'team') return { kind: 'same-club', value: c.value };
    return { kind: 'same-nation', value: c.value };
  },

  // Distinct counts: "Leagues: Max 3", "Nationalities: Min 5".
  (label, value) => {
    const c = extractCount(value);
    if (!c) return null;
    if (/\b(nationalit(y|ies)|nations?)\b/.test(label) && !/\bplayers? from\b/.test(label)) {
      return { kind: 'distinct-nations', comparator: c.comparator, value: c.value };
    }
    if (/\bleagues\b/.test(label) && !/\bplayers? from\b/.test(label)) {
      return { kind: 'distinct-leagues', comparator: c.comparator, value: c.value };
    }
    if (/\b(clubs|teams)\b/.test(label) && !/\bplayers? from\b/.test(label)) {
      return { kind: 'distinct-clubs', comparator: c.comparator, value: c.value };
    }
    return null;
  },

  // "Players from <X>: Min 2" — the entity is named, so we keep the name and
  // let the solver resolve it against the club by name.
  (label, value) => {
    const m = label.match(/players? from (?:the )?(.+)/);
    if (!m) return null;
    const c = extractCount(value);
    if (!c) return null;
    const name = m[1]!.trim();
    // Which dimension it is cannot be told from the text alone, so it is
    // resolved against the club at solve time. Nation is the common case.
    return { kind: 'nation-count', nationName: name, comparator: c.comparator, value: c.value };
  },

  // Rare.
  (label, value) => {
    if (!/\brare\b/.test(label)) return null;
    const c = extractCount(value);
    return c ? { kind: 'rare-count', comparator: c.comparator, value: c.value } : null;
  },

  // Team of the Week / inform.
  (label, value) => {
    if (!/\b(team of the week|totw|inform|in-form)\b/.test(label)) return null;
    const c = extractCount(value);
    return c ? { kind: 'card-type-count', cardType: 'totw', comparator: c.comparator, value: c.value } : null;
  },

  // Icons and Heroes appear as their own requirement lines.
  (label, value) => {
    if (!/\bicons?\b/.test(label)) return null;
    const c = extractCount(value);
    return c ? { kind: 'card-type-count', cardType: 'icon', comparator: c.comparator, value: c.value } : null;
  },
  (label, value) => {
    if (!/\bheroe?s?\b/.test(label)) return null;
    const c = extractCount(value);
    return c ? { kind: 'card-type-count', cardType: 'hero', comparator: c.comparator, value: c.value } : null;
  },

  // "Player Quality: Gold" constrains every player, so count is the squad size.
  (label, value) => {
    if (!/\bplayer quality\b|\bquality\b/.test(label)) return null;
    const band = value.toLowerCase().match(/bronze|silver|gold/);
    if (!band) return null;
    const rating = QUALITY_MIN_RATING[band[0]];
    if (rating === undefined) return null;
    return { kind: 'min-rating', comparator: 'min', value: rating, count: 11 };
  },

  // "Minimum OVR of X: 5" — five players rated at least X.
  (label, value) => {
    const m = label.match(/(?:minimum|min)\.? ?(?:ovr|rating|overall) of (\d+)/);
    if (!m) return null;
    const c = extractCount(value);
    if (!c) return null;
    return { kind: 'min-rating', comparator: c.comparator, value: Number(m[1]), count: c.value };
  },

  // Item Score. Recognised but not locally verifiable — see checkRequirement.
  (label, value) => {
    if (!/\bitem score\b/.test(label)) return null;
    const c = extractCount(value);
    return c ? { kind: 'item-score', comparator: c.comparator, value: c.value } : null;
  },
];

/** Parse one requirement line. Never throws; unknown lines become `unparsed`. */
export function parseRequirementLine(raw: string): Requirement {
  const line = normalise(raw);
  if (!line) return { kind: 'unparsed', text: raw };

  const { label, value } = splitLine(line);
  for (const matcher of MATCHERS) {
    try {
      const req = matcher(label, value, line);
      if (req) return req;
    } catch {
      // A matcher throwing is a bug, but it must not take the import down with
      // it — fall through and report the line as unparsed.
    }
  }
  return { kind: 'unparsed', text: line };
}

export interface ParsedRequirements {
  requirements: Requirement[];
  /** 0..1 — the share of lines we understood. Drives the source confidence. */
  confidence: number;
  unparsed: string[];
}

export function parseRequirements(lines: readonly string[]): ParsedRequirements {
  const cleaned = lines.map(normalise).filter((l) => l.length > 0);
  const requirements = cleaned.map(parseRequirementLine);
  const unparsed = requirements
    .filter((r): r is Extract<Requirement, { kind: 'unparsed' }> => r.kind === 'unparsed')
    .map((r) => r.text);

  // An SBC with no recognisable requirements at all is not 100% confident just
  // because there was nothing to get wrong.
  const confidence = cleaned.length === 0
    ? 0
    : (cleaned.length - unparsed.length) / cleaned.length;

  return { requirements, confidence, unparsed };
}
