import type { Player } from '../src/shared/types/player.js';

/** Minimal player factory for tests. Overrides win. */
export function mkPlayer(over: Partial<Player> & { id: string; rating: number }): Player {
  return {
    assetId: over.assetId ?? `asset-${over.id}`,
    name: `P${over.id}`,
    position: { primary: 'CM', alternates: [], group: 'MID' },
    nationId: 1,
    leagueId: 1,
    clubId: 1,
    cardType: 'rare',
    tradeability: 'untradeable',
    isDuplicate: false,
    duplicateCount: 1,
    evolution: { isEvolved: false },
    isFirstOwner: false,
    squadUsage: [],
    inActiveSquad: false,
    manuallyLocked: false,
    isFavourite: false,
    ...over,
  } as Player;
}
