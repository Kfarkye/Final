import { z } from 'zod';

// Basic Primitives
export const TraceId = z.string().uuid();
export const IsoTimestamp = z.string().datetime();
export const HashString = z.string().regex(/^[a-f0-9]{64}$/);

// Receipts
export const TruthReceipt = z.object({
  validatedAt: IsoTimestamp,
  sourceIdentity: z.enum(['sportradar', 'mlb_stats_api', 'opta']),
  freshnessMs: z.number().int().max(30000),
  isCanonical: z.boolean()
});

export const PolicyReceipt = z.object({
  decision: z.enum(['APPROVED', 'DENIED', 'STALE', 'CONFLICTED']),
  policyVersion: z.string(),
  governanceHash: HashString,
  restrictions: z.array(z.string())
});

export const ExecutionReceipt = z.object({
  contractId: z.string(),
  version: z.string(),
  actorId: z.string(),
  traceId: TraceId,
  payloadHash: HashString,
  durationMs: z.number().int(),
  resultStatus: z.enum(['COMPLETED', 'FAILED', 'FALLBACK_USED'])
});

// Domain Models
export const NormalizedLiveGame = z.object({
  eventId: z.string(),
  league: z.enum(['MLB', 'NFL', 'NBA', 'NHL', 'FIFA']),
  period: z.string(),
  clock: z.string(),
  homeTeam: z.object({
    id: z.string(),
    abbr: z.string().length(3),
    score: z.number().int().min(0)
  }),
  awayTeam: z.object({
    id: z.string(),
    abbr: z.string().length(3),
    score: z.number().int().min(0)
  }),
  marketSnapshots: z.array(z.object({
    marketId: z.string(),
    line: z.number(),
    price: z.number().int()
  })).max(10)
});

export const LiveGameViewModel = z.object({
  hero: z.object({
    homeScore: z.number().int(),
    awayScore: z.number().int(),
    situationStr: z.string().max(64)
  }),
  feed: z.array(z.object({
    playId: z.string(),
    desc: z.string().max(256)
  })).max(10)
});

export const NormalizedGameOutcome = z.object({
  gamePk: z.string(),
  indicator: z.string(),
  edgeSide: z.string(),
  flaggedAt: IsoTimestamp,
  flaggedPrice: z.number().int().nullable(),
  flaggedFairProb: z.number(),
  closingPrice: z.number().int().nullable(),
  closingFairProb: z.number().nullable(),
  clvCents: z.number().nullable(),
  clvProbDelta: z.number().nullable()
});

export const SettleWagerViewModel = z.object({
  gamePk: z.string(),
  outcomesSettled: z.number().int(),
  details: z.array(z.object({
    indicator: z.string(),
    edgeSide: z.string(),
    result: z.enum(['win', 'loss', 'push'])
  }))
});

// Envelopes
export const ErrorEnvelope = z.object({
  status: z.literal('error'),
  errorType: z.enum([
    'input_validation_error',
    'authentication_required',
    'authorization_denied',
    'policy_violation',
    'stale_data',
    'truth_validation_failed',
    'identity_mismatch',
    'dependency_unavailable',
    'timeout',
    'state_conflict',
    'duplicate_request',
    'render_failure',
    'internal_error'
  ]),
  failedStage: z.string(),
  safeMessage: z.string(),
  retryable: z.boolean(),
  traceId: TraceId
});

export const SuccessEnvelope = z.object({
  status: z.literal('success'),
  contractId: z.string(),
  contractVersion: z.string(),
  result: z.union([LiveGameViewModel, SettleWagerViewModel]),
  truthReceipt: TruthReceipt,
  policyReceipt: PolicyReceipt,
  executionReceipt: ExecutionReceipt,
  traceId: TraceId
});

export type GovernedResponse = z.infer<typeof SuccessEnvelope> | z.infer<typeof ErrorEnvelope>;
