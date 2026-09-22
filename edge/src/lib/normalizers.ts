/**
 * Raw export -> domain model.
 *
 * This is the only layer that knows about EA's field names. It is written
 * defensively: raw exports vary between game versions and platforms, and a
 * field that is missing should degrade one player's metadata, not fail the
 * whole import. Anything genuinely unusable is reported to the caller.
 */

import {
  RARITY_ID_TO_CARD_TYPE,
  UNKNOWN_SPECIAL_RARITY_FLOOR,
  POSITION_GROUPS,
} from '../shared/constants';
import type { CardType, Player, Position, PositionGroup } from '../shared/player';

/** Loose shape of a raw club item. Every field is treated as untrusted. */
export type RawItem = Record<string, unknown>;

const str = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined;
const num = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
};
const bool = (v: unknown): boolean | undefined =>
  typeof v === 'boolean' ? v : v === 1 ? true : v === 0 ? false : undefined;

/** First defined value among several candidate field names. */
function pick<T>(raw: RawItem, keys: string[], coerce: (v: unknown) => T | undefined): T | undefined {
  for (const k of keys) {
    const v = coerce(raw[k]);
    if (v !== undefined) return v;
  }
  return undefined;
}

/**
 * Map EA's rarity id to a card family.
 *
 * Unmapped ids at or above UNKNOWN_SPECIAL_RARITY_FLOOR become 'promo' rather
 * than 'unknown'. This is intentional: an unrecognised special card is far more
 * likely to be valuable promo content than common fodder, and the protection
 * engine treats 'promo' as precious. Guessing wrong costs a slightly worse
 * squad; guessing the other way costs the card.
 */
export function normalizeCardType(raw: RawItem): { cardType: CardType; rawRarityId?: number } {
  const rarityId = pick(raw, ['rareflag', 'rarityId', 'rareFlag', 'rarity'], num);

  // Evolutions are flagged separately from rarity and take precedence, since
  // an evolved common is still something you never want to burn.
  const evoFlag =
    pick(raw, ['isEvolved', 'evolutionary', 'hasEvolution'], bool) ??
    (pick(raw, ['evolutionId', 'evolutionPathId'], str) !== undefined);
  if (evoFlag) return { cardType: 'evolution', rawRarityId: rarityId };

  if (rarityId === undefined) return { cardType: 'unknown' };

  const mapped = RARITY_ID_TO_CARD_TYPE[rarityId];
  if (mapped) return { cardType: mapped, rawRarityId: rarityId };

  if (rarityId >= UNKNOWN_SPECIAL_RARITY_FLOOR) {
    return { cardType: 'promo', rawRarityId: rarityId };
  }
  return { cardType: 'unknown', rawRarityId: rarityId };
}

export function normalizePosition(raw: RawItem): Position {
  const primary = pick(raw, ['preferredPosition', 'position', 'pos'], str)?.toUpperCase() ?? 'UNK';

  const rawAlts = raw['possiblePositions'] ?? raw['alternatePositions'];
  const alternates = Array.isArray(rawAlts)
    ? rawAlts.map((p) => str(p)?.toUpperCase()).filter((p): p is string => !!p && p !== primary)
    : [];

  const group: PositionGroup = POSITION_GROUPS[primary] ?? 'MID';
  return { primary, alternates, group };
}

/**
 * Tradeability.
 *
 * EA has expressed this as both an `untradeable` boolean and an `itemState`
 * string over the years, and a loaned item is untradeable regardless. When no
 * signal is present we assume untradeable, because treating a tradeable card as
 * untradeable only misprices it slightly, whereas the reverse can cause the
 * solver to burn something it believed was worthless.
 */
export function normalizeTradeability(raw: RawItem): {
  tradeability: 'tradeable' | 'untradeable';
  untradeableUntil?: string;
} {
  const untradeableFlag = pick(raw, ['untradeable', 'isUntradeable'], bool);
  const itemState = pick(raw, ['itemState', 'state'], str);
  const loanLeft = pick(raw, ['loansRemaining', 'loans'], num);

  const untradeableUntil = pick(raw, ['untradeableUntil', 'tradeableAfter'], str);

  const isUntradeable =
    untradeableFlag === true ||
    itemState === 'invalid' ||
    (loanLeft !== undefined && loanLeft > 0) ||
    untradeableFlag === undefined;

  return {
    tradeability: isUntradeable ? 'untradeable' : 'tradeable',
    ...(untradeableUntil ? { untradeableUntil } : {}),
  };
}

/** Result of normalizing one item: either a player or a reason it was skipped. */
export type NormalizeResult =
  | { ok: true; player: Player }
  | { ok: false; reason: string; raw: RawItem };

/**
 * Normalize a single raw item.
 *
 * Duplicate counts are not knowable per-item — they are filled in by
 * `importClub` once the whole club is present.
 */
export function normalizeItem(raw: RawItem): NormalizeResult {
  const id = pick(raw, ['id', 'itemId', 'itemid'], str);
  if (!id) return { ok: false, reason: 'no item id', raw };

  const rating = pick(raw, ['rating', 'ovr', 'overall'], num);
  if (rating === undefined) return { ok: false, reason: `item ${id} has no rating`, raw };

  const assetId = pick(raw, ['assetId', 'assetid', 'baseId', 'definitionId'], str) ?? id;

  const { cardType, rawRarityId } = normalizeCardType(raw);
  const { tradeability, untradeableUntil } = normalizeTradeability(raw);

  const evoPathId = pick(raw, ['evolutionId', 'evolutionPathId'], str);
  const evoRatingGained = pick(raw, ['evolutionRatingGain', 'ratingGained'], num);

  const player: Player = {
    id,
    assetId,
    resourceId: pick(raw, ['resourceId', 'resourceid'], str),
    // Web App item payloads frequently omit names — they are resolved from a
    // separate metadata call the app makes. An unnamed card is still fully
    // usable by the solver, so we fall back rather than reject.
    name: pick(raw, ['name', 'lastName', 'commonName', 'firstName'], str) ?? `Item ${id}`,
    rating,
    position: normalizePosition(raw),
    nationId: pick(raw, ['nation', 'nationId'], num) ?? 0,
    nationName: pick(raw, ['nationName'], str),
    leagueId: pick(raw, ['leagueId', 'league'], num) ?? 0,
    leagueName: pick(raw, ['leagueName'], str),
    clubId: pick(raw, ['teamid', 'teamId', 'clubId'], num) ?? 0,
    clubName: pick(raw, ['clubName', 'teamName'], str),
    cardType,
    ...(rawRarityId !== undefined ? { rawRarityId } : {}),
    tradeability,
    ...(untradeableUntil ? { untradeableUntil } : {}),
    // Filled in by importClub once the full club is known.
    isDuplicate: false,
    duplicateCount: 1,
    evolution: {
      isEvolved: cardType === 'evolution',
      ...(evoPathId ? { pathId: evoPathId } : {}),
      ...(evoRatingGained !== undefined ? { ratingGained: evoRatingGained } : {}),
    },
    isFirstOwner: pick(raw, ['owners', 'ownerCount'], num) === 1,
    squadUsage: [],
    inActiveSquad: false,
    contracts: pick(raw, ['contract', 'contracts'], num),
    manuallyLocked: false,
    isFavourite: pick(raw, ['favourite', 'isFavourite'], bool) ?? false,
  };

  return { ok: true, player };
}
