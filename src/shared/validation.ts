/**
 * Runtime validation for anything crossing a trust boundary: club exports read
 * from disk, SBC definitions (especially scraped ones), and persisted settings.
 *
 * Internal function boundaries rely on the type system instead — validating
 * there would just be noise.
 */

import { z } from 'zod';

export const positionSchema = z.object({
  primary: z.string(),
  alternates: z.array(z.string()).default([]),
  group: z.enum(['GK', 'DEF', 'MID', 'ATT']),
});

export const valueEstimateSchema = z.object({
  coins: z.number().nonnegative(),
  source: z.enum(['market', 'user', 'heuristic', 'untradeable']),
  asOf: z.string(),
  confidence: z.number().min(0).max(1),
});

export const playerSchema = z.object({
  id: z.string().min(1),
  assetId: z.string().min(1),
  resourceId: z.string().optional(),
  name: z.string(),
  rating: z.number().int().min(0).max(99),
  position: positionSchema,
  nationId: z.number().int(),
  nationName: z.string().optional(),
  leagueId: z.number().int(),
  leagueName: z.string().optional(),
  clubId: z.number().int(),
  clubName: z.string().optional(),
  cardType: z.enum([
    'common', 'rare', 'totw', 'icon', 'hero', 'promo',
    'evolution', 'sbc-reward', 'objective-reward', 'unknown',
  ]),
  rawRarityId: z.number().optional(),
  tradeability: z.enum(['tradeable', 'untradeable']),
  untradeableUntil: z.string().optional(),
  isDuplicate: z.boolean(),
  duplicateCount: z.number().int().min(1),
  evolution: z.object({
    isEvolved: z.boolean(),
    pathId: z.string().optional(),
    ratingGained: z.number().optional(),
  }),
  isFirstOwner: z.boolean(),
  squadUsage: z.array(z.string()).default([]),
  inActiveSquad: z.boolean(),
  contracts: z.number().optional(),
  value: valueEstimateSchema.optional(),
  manuallyLocked: z.boolean(),
  isFavourite: z.boolean(),
  note: z.string().optional(),
});

export const squadSchema = z.object({
  id: z.string(),
  name: z.string(),
  formation: z.string().optional(),
  playerIds: z.array(z.string()),
  isActive: z.boolean(),
});

export const clubSchema = z.object({
  ownerRef: z.string().optional(),
  exportedAt: z.string(),
  gameVersion: z.string(),
  players: z.array(playerSchema),
  squads: z.array(squadSchema).default([]),
  coins: z.number().optional(),
});

const comparatorSchema = z.enum(['min', 'max', 'exact']);

export const requirementSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('squad-rating'), comparator: comparatorSchema, value: z.number() }),
  z.object({ kind: z.literal('team-chemistry'), comparator: comparatorSchema, value: z.number() }),
  z.object({ kind: z.literal('player-count'), value: z.number() }),
  z.object({ kind: z.literal('min-rating'), comparator: comparatorSchema, value: z.number(), count: z.number() }),
  z.object({ kind: z.literal('rare-count'), comparator: comparatorSchema, value: z.number() }),
  z.object({ kind: z.literal('card-type-count'), cardType: z.string(), comparator: comparatorSchema, value: z.number() }),
  z.object({ kind: z.literal('nation-count'), nationId: z.number().optional(), nationName: z.string().optional(), comparator: comparatorSchema, value: z.number() }),
  z.object({ kind: z.literal('league-count'), leagueId: z.number().optional(), leagueName: z.string().optional(), comparator: comparatorSchema, value: z.number() }),
  z.object({ kind: z.literal('club-count'), clubId: z.number().optional(), clubName: z.string().optional(), comparator: comparatorSchema, value: z.number() }),
  z.object({ kind: z.literal('distinct-nations'), comparator: comparatorSchema, value: z.number() }),
  z.object({ kind: z.literal('distinct-leagues'), comparator: comparatorSchema, value: z.number() }),
  z.object({ kind: z.literal('distinct-clubs'), comparator: comparatorSchema, value: z.number() }),
  z.object({ kind: z.literal('same-league'), value: z.number() }),
  z.object({ kind: z.literal('same-nation'), value: z.number() }),
  z.object({ kind: z.literal('same-club'), value: z.number() }),
  z.object({ kind: z.literal('item-score'), comparator: comparatorSchema, value: z.number() }),
  z.object({ kind: z.literal('specific-player'), assetId: z.string(), name: z.string().optional() }),
  z.object({ kind: z.literal('unparsed'), text: z.string() }),
]);

export const challengeSchema = z.object({
  id: z.string(),
  name: z.string(),
  requirements: z.array(requirementSchema),
  reward: z.object({
    description: z.string(),
    estimatedValue: z.number().optional(),
    untradeable: z.boolean().optional(),
  }).optional(),
  formation: z.string().optional(),
  completed: z.boolean().optional(),
  repeatsRemaining: z.number().optional(),
});

export const sbcSetSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: z.string().optional(),
  description: z.string().optional(),
  challenges: z.array(challengeSchema),
  expiresAt: z.string().optional(),
  repeatable: z.boolean().optional(),
  reward: z.object({
    description: z.string(),
    estimatedValue: z.number().optional(),
    untradeable: z.boolean().optional(),
  }).optional(),
  source: z.object({
    kind: z.enum(['local', 'scraped', 'manual']),
    origin: z.string().optional(),
    fetchedAt: z.string().optional(),
    confidence: z.number().min(0).max(1),
  }),
});

/**
 * Parse with a readable error rather than zod's default dump.
 * Used at every disk/network boundary so a corrupt file names its own problem.
 */
export function parseOrThrow<T>(schema: z.ZodType<T>, data: unknown, what: string): T {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const issues = result.error.issues
    .slice(0, 10)
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  const more = result.error.issues.length > 10
    ? `\n  ...and ${result.error.issues.length - 10} more`
    : '';
  throw new Error(`Invalid ${what}:\n${issues}${more}`);
}
