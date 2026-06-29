/**
 * src/contracts/mlbPubsubPipeline.v1.2.ts
 *
 * Truth MLB Pub/Sub Pipeline Contract v1.2
 *
 * Purpose:
 *   Runtime Zod schemas and TypeScript types for the Pub/Sub-first MLB pipeline:
 *
 *   - historical odds backfill
 *   - per-snapshot odds workers
 *   - result reducer
 *   - live monitor commands
 *   - live monitor ticks
 *   - live state committed events
 *   - receipt-backed alerts
 *
 * Commercial v1.2 corrections:
 *   1. Adds tenantId and environment to every envelope.
 *   2. Treats Pub/Sub as at-least-once delivery.
 *   3. Requires idempotencyKey on every message.
 *   4. Removes secrets from payloads.
 *   5. Adds command-specific validation.
 *   6. Fixes active-live-slate monitor fanout by allowing monitor commands without a
 *      single game while requiring game identity on actual tick messages.
 *   7. Adds source receipts for all alerts and live state commits.
 *   8. Adds stale tick controls.
 */

import { z } from "zod";

export const MLB_PIPELINE_CONTRACT_NAME = "truth.mlb.pubsub.pipeline.v1";
export const MLB_PIPELINE_SCHEMA_VERSION = "1.2.0" as const;

export const EnvironmentSchema = z.enum([
  "development",
  "staging",
  "production",
  "test"
]);

export const PrioritySchema = z.enum([
  "LOW",
  "NORMAL",
  "HIGH",
  "URGENT"
]);

export const SportKeySchema = z.enum([
  "baseball_mlb"
]);

export const LiveSportSchema = z.enum([
  "mlb"
]);

export const OddsProviderSchema = z.enum([
  "the_odds_api"
]);

export const MarketSchema = z.enum([
  "h2h",
  "spreads",
  "totals"
]);

export const SnapshotTypeSchema = z.string().min(1).max(64);

export const DateTimeSchema = z.string().datetime({
  offset: true
});

export const UuidSchema = z.string().uuid();

export const BoundedString = {
  tenantId: z.string().min(1).max(64),
  environment: EnvironmentSchema,
  messageId: UuidSchema,
  correlationId: z.string().min(1).max(128),
  causationId: z.string().min(1).max(64).nullable().optional(),
  runId: z.string().min(1).max(128),
  nullableRunId: z.string().min(1).max(128).nullable().optional(),
  monitorId: z.string().min(1).max(128),
  nullableMonitorId: z.string().min(1).max(128).nullable().optional(),
  idempotencyKey: z.string().min(1).max(512),
  source: z.string().min(1).max(128),
  team: z.string().min(1).max(64),
  eventId: z.string().min(1).max(128),
  gamePk: z.string().min(1).max(64),
  label: z.string().min(1).max(256),
  headline: z.string().min(1).max(512),
  url: z.string().url()
};

export const MessageTypeSchema = z.enum([
  "odds.backfill.command.v1",
  "odds.backfill.snapshot.requested.v1",
  "odds.backfill.snapshot.completed.v1",
  "odds.backfill.snapshot.failed.v1",
  "odds.backfill.run.completed.v1",
  "live.monitor.command.v1",
  "live.monitor.tick.v1",
  "live.state.committed.v1",
  "live.monitor.alert.v1"
]);

export type MessageType = z.infer<typeof MessageTypeSchema>;

export const ReceiptSourceSchema = z.enum([
  "mlb_stats_api_play_by_play",
  "mlb_stats_api_schedule",
  "mlb_stats_api_boxscore",
  "espn_scoreboard",
  "espn_game_summary",
  "the_odds_api",
  "spanner_live_state",
  "spanner_odds_history",
  "internal_calculation"
]);

export const SourceReceiptSchema = z.object({
  source: ReceiptSourceSchema.or(z.string().min(1).max(128)),
  field: z.string().min(1).max(128),
  value: z.unknown(),
  observedAt: DateTimeSchema,
  url: BoundedString.url.nullable().optional(),
  sourceId: z.string().min(1).max(128).nullable().optional(),
  providerTimestamp: DateTimeSchema.nullable().optional(),
  confidence: z.number().min(0).max(1).nullable().optional()
}).strict();

export type SourceReceipt = z.infer<typeof SourceReceiptSchema>;

export const ProviderSourceReceiptSchema = z.object({
  provider: z.string().min(1).max(64),
  endpoint: z.string().min(1).max(512),
  httpStatus: z.number().int().min(100).max(599),
  observedAt: DateTimeSchema,
  requestId: z.string().min(1).max(128).nullable().optional(),
  requestsRemaining: z.number().int().nullable().optional(),
  requestsUsed: z.number().int().nullable().optional(),
  lastRequestCost: z.number().int().nullable().optional()
}).strict();

export type ProviderSourceReceipt = z.infer<typeof ProviderSourceReceiptSchema>;

export const PubsubEnvelopeBaseSchema = z.object({
  schemaVersion: z.literal(MLB_PIPELINE_SCHEMA_VERSION),
  contractName: z.literal(MLB_PIPELINE_CONTRACT_NAME).optional(),
  messageType: MessageTypeSchema,
  messageId: BoundedString.messageId,
  tenantId: BoundedString.tenantId,
  environment: EnvironmentSchema,
  correlationId: BoundedString.correlationId,
  causationId: BoundedString.causationId,
  runId: BoundedString.nullableRunId,
  monitorId: BoundedString.nullableMonitorId,
  idempotencyKey: BoundedString.idempotencyKey,
  publishedAt: DateTimeSchema,
  source: BoundedString.source,
  priority: PrioritySchema.default("NORMAL"),
  payload: z.unknown()
}).strict();

export type PubsubEnvelopeBase = z.infer<typeof PubsubEnvelopeBaseSchema>;

export const OddsBackfillCommandTypeSchema = z.enum([
  "START_RANGE",
  "RUN_SNAPSHOT",
  "STOP_RUN",
  "RESUME_RUN",
  "REQUEUE_FAILED",
  "GAP_SCAN",
  "REPLAY_RANGE"
]);

export const OddsBackfillCommandPayloadSchema = z.object({
  command: OddsBackfillCommandTypeSchema,
  sport: SportKeySchema,
  provider: OddsProviderSchema,
  runId: BoundedString.runId.nullable().optional(),
  startDate: DateTimeSchema.nullable().optional(),
  endDate: DateTimeSchema.nullable().optional(),
  snapshotDate: DateTimeSchema.nullable().optional(),
  intervalHours: z.number().min(0.25).max(24).default(1),
  markets: z.array(MarketSchema).min(1).default([
    "h2h",
    "spreads",
    "totals"
  ]),
  regions: z.array(z.string().min(1).max(32)).default(["us"]),
  bookmakers: z.array(z.string().min(1).max(64)).default([]),
  snapshotType: SnapshotTypeSchema.nullable().optional(),
  quotaFloor: z.number().int().min(0).default(100),
  maxCreditsBudget: z.number().int().min(0).default(250000),
  createMissingParents: z.boolean().default(false),
  strictParentRequired: z.boolean().default(true),
  dryRun: z.boolean().default(false),
  requestedBy: z.string().min(1).max(128),
  maxSnapshotsPerRun: z.number().int().min(1).max(50000).default(10000),
  publishBatchSize: z.number().int().min(1).max(1000).default(100)
}).strict().superRefine((value, ctx) => {
  const requireField = (
    field: keyof z.infer<typeof OddsBackfillCommandPayloadSchema>,
    message: string
  ) => {
    if (value[field] === undefined || value[field] === null || value[field] === "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message
      });
    }
  };

  if (value.command === "START_RANGE") {
    requireField("runId", "START_RANGE requires runId.");
    requireField("startDate", "START_RANGE requires startDate.");
    requireField("endDate", "START_RANGE requires endDate.");
    requireField("snapshotType", "START_RANGE requires snapshotType.");

    if (value.startDate && value.endDate) {
      const start = Date.parse(value.startDate);
      const end = Date.parse(value.endDate);

      if (Number.isFinite(start) && Number.isFinite(end) && start < end) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["startDate"],
          message: "START_RANGE expects startDate >= endDate when walking backward."
        });
      }
    }
  }

  if (value.command === "RUN_SNAPSHOT") {
    requireField("runId", "RUN_SNAPSHOT requires runId.");
    requireField("snapshotDate", "RUN_SNAPSHOT requires snapshotDate.");
    requireField("snapshotType", "RUN_SNAPSHOT requires snapshotType.");
  }

  if (
    value.command === "STOP_RUN" ||
    value.command === "RESUME_RUN" ||
    value.command === "REQUEUE_FAILED"
  ) {
    requireField("runId", `${value.command} requires runId.`);
  }

  if (value.command === "GAP_SCAN" || value.command === "REPLAY_RANGE") {
    requireField("runId", `${value.command} requires runId.`);
    requireField("startDate", `${value.command} requires startDate.`);
    requireField("endDate", `${value.command} requires endDate.`);
  }
});

export type OddsBackfillCommandPayload =
  z.infer<typeof OddsBackfillCommandPayloadSchema>;

export const OddsBackfillSnapshotRequestedPayloadSchema = z.object({
  runId: BoundedString.runId,
  sport: SportKeySchema,
  provider: OddsProviderSchema,
  requestedSnapshotDate: DateTimeSchema,
  markets: z.array(MarketSchema).min(1),
  regions: z.array(z.string().min(1).max(32)),
  bookmakers: z.array(z.string().min(1).max(64)).default([]),
  snapshotType: SnapshotTypeSchema,
  createMissingParents: z.boolean(),
  strictParentRequired: z.boolean(),
  dryRun: z.boolean(),
  attempt: z.number().int().min(1),
  maxAttempts: z.number().int().min(1).max(20).default(5),
  jobId: z.string().min(1).max(160).nullable().optional()
}).strict();

export type OddsBackfillSnapshotRequestedPayload =
  z.infer<typeof OddsBackfillSnapshotRequestedPayloadSchema>;

export const OddsSnapshotCountsSchema = z.object({
  eventsSeen: z.number().int().min(0),
  eventsMatchedToParent: z.number().int().min(0),
  eventsSkippedNoParent: z.number().int().min(0),
  eventsAmbiguousParent: z.number().int().min(0),
  parentGamesCreated: z.number().int().min(0),
  highFidelityRowsWritten: z.number().int().min(0),
  thinRollupRowsWritten: z.number().int().min(0),
  rowsDeduped: z.number().int().min(0)
}).strict();

export const OddsApiQuotaSchema = z.object({
  requestsRemaining: z.number().int().nullable().optional(),
  requestsUsed: z.number().int().nullable().optional(),
  lastRequestCost: z.number().int().nullable().optional()
}).strict();

export const OddsBackfillSnapshotCompletedPayloadSchema = z.object({
  runId: BoundedString.runId,
  sport: SportKeySchema,
  provider: OddsProviderSchema,
  requestedSnapshotDate: DateTimeSchema,
  apiTimestampReturned: DateTimeSchema.nullable().optional(),
  status: z.literal("COMPLETED"),
  dryRun: z.boolean(),
  counts: OddsSnapshotCountsSchema,
  quota: OddsApiQuotaSchema,
  sourceReceipt: ProviderSourceReceiptSchema,
  warnings: z.array(z.string().min(1).max(512)).default([])
}).strict();

export type OddsBackfillSnapshotCompletedPayload =
  z.infer<typeof OddsBackfillSnapshotCompletedPayloadSchema>;

export const ErrorCodeSchema = z.enum([
  "ODDS_API_429",
  "ODDS_API_500",
  "ODDS_API_TIMEOUT",
  "SPANNER_WRITE_FAILED",
  "SPANNER_ABORTED",
  "SPANNER_UNAVAILABLE",
  "PUBSUB_PUBLISH_FAILED",
  "PARENT_RESOLUTION_FAILED",
  "PARENT_RESOLUTION_AMBIGUOUS",
  "PARENT_RESOLUTION_FAILED_WHEN_STRICT",
  "PARENT_RESOLUTION_AMBIGUOUS_WHEN_STRICT",
  "TEMPORARY_PROVIDER_EMPTY_RESPONSE",
  "INVALID_MESSAGE",
  "INVALID_MARKET",
  "INVALID_DATE_RANGE",
  "UNSUPPORTED_SPORT",
  "MISSING_REQUIRED_SECRET",
  "NETWORK_TIMEOUT",
  "UNKNOWN"
]);

export const PipelineErrorSchema = z.object({
  code: ErrorCodeSchema.or(z.string().min(1).max(128)),
  message: z.string().min(1).max(4000),
  details: z.record(z.string(), z.unknown()).optional()
}).strict();

export type PipelineError = z.infer<typeof PipelineErrorSchema>;

export const OddsBackfillSnapshotFailedPayloadSchema = z.object({
  runId: BoundedString.runId,
  sport: SportKeySchema,
  provider: OddsProviderSchema,
  requestedSnapshotDate: DateTimeSchema,
  status: z.literal("FAILED"),
  attempt: z.number().int().min(1),
  retryable: z.boolean(),
  error: PipelineErrorSchema,
  quota: OddsApiQuotaSchema.optional()
}).strict();

export type OddsBackfillSnapshotFailedPayload =
  z.infer<typeof OddsBackfillSnapshotFailedPayloadSchema>;

export const OddsBackfillRunStatusSchema = z.enum([
  "COMPLETED",
  "COMPLETED_WITH_ERRORS",
  "STOPPED_QUOTA_FLOOR",
  "STOPPED_MANUAL",
  "FAILED"
]);

export const OddsBackfillRunCompletedPayloadSchema = z.object({
  runId: BoundedString.runId,
  status: OddsBackfillRunStatusSchema,
  startedAt: DateTimeSchema,
  finishedAt: DateTimeSchema,
  counts: z.object({
    snapshotsPlanned: z.number().int().min(0),
    snapshotsCompleted: z.number().int().min(0),
    snapshotsFailed: z.number().int().min(0),
    snapshotsSkipped: z.number().int().min(0).optional(),
    eventsSeen: z.number().int().min(0),
    eventsMatchedToParent: z.number().int().min(0),
    eventsSkippedNoParent: z.number().int().min(0),
    eventsAmbiguousParent: z.number().int().min(0),
    historyRowsWritten: z.number().int().min(0)
  }).strict(),
  quota: z.object({
    lastKnownRemaining: z.number().int().nullable().optional(),
    lastKnownUsed: z.number().int().nullable().optional()
  }).strict().optional(),
  errors: z.array(PipelineErrorSchema).default([])
}).strict();

export type OddsBackfillRunCompletedPayload =
  z.infer<typeof OddsBackfillRunCompletedPayloadSchema>;

export const NotificationTargetSchema = z.object({
  type: z.enum([
    "dashboard",
    "email",
    "sms",
    "webhook",
    "slack"
  ]),
  target: z.string().min(1).max(512)
}).strict();

export type NotificationTarget = z.infer<typeof NotificationTargetSchema>;

export const LiveMonitorRulesSchema = z.object({
  totalAtOrBelow: z.number().nullable().optional(),
  totalCrossedDownTo: z.number().nullable().optional(),
  starterPitchCountAtOrAbove: z.number().int().min(0).nullable().optional(),
  starterVelocityDropMphAtOrAbove: z.number().min(0).nullable().optional(),
  commandRiskEnabled: z.boolean().default(true),
  commandRiskAtOrAbove: z.number().min(0).nullable().optional(),
  bullpenEntered: z.boolean().default(true),
  runnersInScoringPosition: z.boolean().default(false),
  lateInning: z.number().int().min(1).max(20).nullable().optional(),
  dedupeWindowSeconds: z.number().int().min(30).max(86400).default(300),
  staleTickMaxAgeSeconds: z.number().int().min(10).max(600).default(90),
  heartbeatAlertsEnabled: z.boolean().default(false),
  delayAwareAlertsEnabled: z.boolean().default(false)
}).strict();

export type LiveMonitorRules = z.infer<typeof LiveMonitorRulesSchema>;

export const LiveMonitorCommandTypeSchema = z.enum([
  "CREATE_MONITOR",
  "UPDATE_MONITOR",
  "PAUSE_MONITOR",
  "RESUME_MONITOR",
  "CANCEL_MONITOR",
  "TICK_ACTIVE_MONITORS"
]);

export const LiveMonitorCommandPayloadSchema = z.object({
  command: LiveMonitorCommandTypeSchema,
  monitorId: BoundedString.monitorId.nullable().optional(),
  sport: LiveSportSchema,
  eventId: BoundedString.eventId.nullable().optional(),
  gamePk: BoundedString.gamePk.nullable().optional(),
  teamFocus: z.array(z.string().min(1).max(16)).max(30).default([]),
  label: BoundedString.label.nullable().optional(),
  expiresAt: DateTimeSchema.nullable().optional(),
  rules: LiveMonitorRulesSchema.nullable().optional(),
  notificationTargets: z.array(NotificationTargetSchema).default([
    {
      type: "dashboard",
      target: "truth-live-slate"
    }
  ]),
  commandVersion: z.number().int().min(1).default(1),
  requestedBy: z.string().min(1).max(128).nullable().optional()
}).strict().superRefine((value, ctx) => {
  const requiresMonitorId = value.command !== "TICK_ACTIVE_MONITORS";

  if (requiresMonitorId && !value.monitorId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["monitorId"],
      message: `${value.command} requires monitorId.`
    });
  }

  if (value.command === "CREATE_MONITOR") {
    if (!value.rules) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rules"],
        message: "CREATE_MONITOR requires rules."
      });
    }

    const hasSpecificScope =
      Boolean(value.eventId) ||
      Boolean(value.gamePk) ||
      value.teamFocus.length > 0 ||
      value.monitorId === "active-live-slate";

    if (!hasSpecificScope) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["monitorId"],
        message:
          "CREATE_MONITOR requires at least one of eventId, gamePk, teamFocus, or monitorId=active-live-slate."
      });
    }
  }
});

export type LiveMonitorCommandPayload =
  z.infer<typeof LiveMonitorCommandPayloadSchema>;

export const LiveMonitorTickPayloadSchema = z.object({
  monitorId: BoundedString.monitorId,
  sport: LiveSportSchema,
  eventId: BoundedString.eventId.nullable().optional(),
  gamePk: BoundedString.gamePk.nullable().optional(),
  evaluationTime: DateTimeSchema,
  forceRefresh: z.boolean().default(false),
  maxAgeSeconds: z.number().int().min(10).max(600).default(90)
}).strict().superRefine((value, ctx) => {
  if (!value.eventId && !value.gamePk) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["gamePk"],
      message: "live.monitor.tick.v1 requires eventId or gamePk."
    });
  }
});

export type LiveMonitorTickPayload =
  z.infer<typeof LiveMonitorTickPayloadSchema>;

export const CurrentPitcherRoleSchema = z.enum([
  "STARTER",
  "OPENER",
  "BULK",
  "RELIEVER",
  "UNKNOWN"
]);

export const LiveSignalsSchema = z.object({
  liveTotal: z.number().nullable().optional(),
  previousLiveTotal: z.number().nullable().optional(),
  totalThresholdCrossed: z.number().nullable().optional(),
  starterName: z.string().min(1).max(128).nullable().optional(),
  starterPitcherId: z.string().min(1).max(64).nullable().optional(),
  starterPitchCount: z.number().int().min(0).nullable().optional(),
  starterStillInGame: z.boolean().nullable().optional(),
  bullpenEntered: z.boolean().nullable().optional(),
  currentPitcherName: z.string().min(1).max(128).nullable().optional(),
  currentPitcherId: z.string().min(1).max(64).nullable().optional(),
  currentPitcherRole: CurrentPitcherRoleSchema.nullable().optional(),
  velocityDropMph: z.number().nullable().optional(),
  commandRiskScore: z.number().nullable().optional(),
  commandRiskModelVersion: z.string().min(1).max(64).nullable().optional(),
  walks: z.number().int().min(0).nullable().optional(),
  threeBallCounts: z.number().int().min(0).nullable().optional(),
  hardContactRecent: z.boolean().nullable().optional(),
  runnersInScoringPosition: z.boolean().nullable().optional()
}).catchall(z.unknown());

export type LiveSignals = z.infer<typeof LiveSignalsSchema>;

export const LiveStateCommittedPayloadSchema = z.object({
  eventId: BoundedString.eventId.nullable().optional(),
  gamePk: BoundedString.gamePk,
  observedAt: DateTimeSchema,
  sourceSetHash: z.string().min(1).max(128).optional(),
  gameStatus: z.string().min(1).max(64).nullable().optional(),
  inning: z.string().min(1).max(64).nullable().optional(),
  score: z.string().min(1).max(64).nullable().optional(),
  homeTeam: z.string().min(1).max(128).nullable().optional(),
  awayTeam: z.string().min(1).max(128).nullable().optional(),
  signals: LiveSignalsSchema,
  receipts: z.array(SourceReceiptSchema).min(1)
}).strict();

export type LiveStateCommittedPayload =
  z.infer<typeof LiveStateCommittedPayloadSchema>;

export const AlertSeveritySchema = z.enum([
  "INFO",
  "WATCH",
  "ACTIONABLE",
  "CRITICAL"
]);

export const LiveMonitorAlertPayloadSchema = z.object({
  monitorId: BoundedString.monitorId,
  alertId: z.string().min(1).max(128),
  sport: LiveSportSchema,
  severity: AlertSeveritySchema,
  event: z.object({
    eventId: BoundedString.eventId.nullable().optional(),
    gamePk: BoundedString.gamePk.nullable().optional(),
    homeTeam: z.string().min(1).max(128).nullable().optional(),
    awayTeam: z.string().min(1).max(128).nullable().optional(),
    inning: z.string().min(1).max(64).nullable().optional(),
    score: z.string().min(1).max(64).nullable().optional(),
    gameStatus: z.string().min(1).max(64).nullable().optional()
  }).strict(),
  triggeredAt: DateTimeSchema,
  headline: BoundedString.headline,
  signals: LiveSignalsSchema,
  receipts: z.array(SourceReceiptSchema).min(1),
  dedupeWindowSeconds: z.number().int().min(30).max(86400).default(300),
  alertRuleHash: z.string().min(1).max(128).nullable().optional(),
  dedupeBucket: DateTimeSchema.nullable().optional()
}).strict().superRefine((value, ctx) => {
  if (!value.event.eventId && !value.event.gamePk) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["event", "gamePk"],
      message: "live.monitor.alert.v1 requires event.eventId or event.gamePk."
    });
  }
});

export type LiveMonitorAlertPayload =
  z.infer<typeof LiveMonitorAlertPayloadSchema>;

function envelopeFor<
  TMessageType extends MessageType,
  TPayloadSchema extends z.ZodTypeAny
>(messageType: TMessageType, payloadSchema: TPayloadSchema) {
  return PubsubEnvelopeBaseSchema.extend({
    messageType: z.literal(messageType),
    payload: payloadSchema
  }).strict().superRefine((value, ctx) => {
    if (value.payload && typeof value.payload === "object") {
      const payload = value.payload as Record<string, unknown>;

      if (
        "runId" in payload &&
        payload.runId &&
        value.runId &&
        payload.runId !== value.runId
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["runId"],
          message: "Envelope runId must match payload.runId when both are present."
        });
      }

      if (
        "monitorId" in payload &&
        payload.monitorId &&
        value.monitorId &&
        payload.monitorId !== value.monitorId
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["monitorId"],
          message: "Envelope monitorId must match payload.monitorId when both are present."
        });
      }
    }
  });
}

export const OddsBackfillCommandMessageSchema = envelopeFor(
  "odds.backfill.command.v1",
  OddsBackfillCommandPayloadSchema
);

export const OddsBackfillSnapshotRequestedMessageSchema = envelopeFor(
  "odds.backfill.snapshot.requested.v1",
  OddsBackfillSnapshotRequestedPayloadSchema
);

export const OddsBackfillSnapshotCompletedMessageSchema = envelopeFor(
  "odds.backfill.snapshot.completed.v1",
  OddsBackfillSnapshotCompletedPayloadSchema
);

export const OddsBackfillSnapshotFailedMessageSchema = envelopeFor(
  "odds.backfill.snapshot.failed.v1",
  OddsBackfillSnapshotFailedPayloadSchema
);

export const OddsBackfillRunCompletedMessageSchema = envelopeFor(
  "odds.backfill.run.completed.v1",
  OddsBackfillRunCompletedPayloadSchema
);

export const LiveMonitorCommandMessageSchema = envelopeFor(
  "live.monitor.command.v1",
  LiveMonitorCommandPayloadSchema
);

export const LiveMonitorTickMessageSchema = envelopeFor(
  "live.monitor.tick.v1",
  LiveMonitorTickPayloadSchema
);

export const LiveStateCommittedMessageSchema = envelopeFor(
  "live.state.committed.v1",
  LiveStateCommittedPayloadSchema
);

export const LiveMonitorAlertMessageSchema = envelopeFor(
  "live.monitor.alert.v1",
  LiveMonitorAlertPayloadSchema
);

export const MlbPubsubMessageSchema = z.union([
  OddsBackfillCommandMessageSchema,
  OddsBackfillSnapshotRequestedMessageSchema,
  OddsBackfillSnapshotCompletedMessageSchema,
  OddsBackfillSnapshotFailedMessageSchema,
  OddsBackfillRunCompletedMessageSchema,
  LiveMonitorCommandMessageSchema,
  LiveMonitorTickMessageSchema,
  LiveStateCommittedMessageSchema,
  LiveMonitorAlertMessageSchema
]);

export type OddsBackfillCommandMessage =
  z.infer<typeof OddsBackfillCommandMessageSchema>;

export type OddsBackfillSnapshotRequestedMessage =
  z.infer<typeof OddsBackfillSnapshotRequestedMessageSchema>;

export type OddsBackfillSnapshotCompletedMessage =
  z.infer<typeof OddsBackfillSnapshotCompletedMessageSchema>;

export type OddsBackfillSnapshotFailedMessage =
  z.infer<typeof OddsBackfillSnapshotFailedMessageSchema>;

export type OddsBackfillRunCompletedMessage =
  z.infer<typeof OddsBackfillRunCompletedMessageSchema>;

export type LiveMonitorCommandMessage =
  z.infer<typeof LiveMonitorCommandMessageSchema>;

export type LiveMonitorTickMessage =
  z.infer<typeof LiveMonitorTickMessageSchema>;

export type LiveStateCommittedMessage =
  z.infer<typeof LiveStateCommittedMessageSchema>;

export type LiveMonitorAlertMessage =
  z.infer<typeof LiveMonitorAlertMessageSchema>;

export type MlbPubsubMessage = z.infer<typeof MlbPubsubMessageSchema>;

export const PubsubPushBodySchema = z.object({
  message: z.object({
    data: z.string().min(1),
    attributes: z.record(z.string(), z.string()).optional(),
    messageId: z.string().optional(),
    message_id: z.string().optional(),
    publishTime: z.string().optional(),
    publish_time: z.string().optional()
  }).passthrough(),
  subscription: z.string().optional()
}).passthrough();

export type PubsubPushBody = z.infer<typeof PubsubPushBodySchema>;

export function parseMlbPubsubMessage(input: unknown): MlbPubsubMessage {
  return MlbPubsubMessageSchema.parse(input);
}

export function safeParseMlbPubsubMessage(input: unknown) {
  return MlbPubsubMessageSchema.safeParse(input);
}

export function decodePubsubPushMessage(input: unknown): MlbPubsubMessage {
  const parsedPush = PubsubPushBodySchema.parse(input);
  const decoded = Buffer.from(parsedPush.message.data, "base64").toString("utf8");
  const json = JSON.parse(decoded);
  return parseMlbPubsubMessage(json);
}

export function encodePubsubMessageData(message: MlbPubsubMessage): string {
  const parsed = parseMlbPubsubMessage(message);
  return Buffer.from(JSON.stringify(parsed), "utf8").toString("base64");
}

export function buildPubsubAttributes(
  message: MlbPubsubMessage
): Record<string, string> {
  const attributes: Record<string, string> = {
    schemaVersion: message.schemaVersion,
    messageType: message.messageType,
    tenantId: message.tenantId,
    environment: message.environment,
    correlationId: message.correlationId,
    idempotencyKey: message.idempotencyKey,
    source: message.source,
    priority: message.priority
  };

  if (message.runId) {
    attributes.runId = message.runId;
  }

  if (message.monitorId) {
    attributes.monitorId = message.monitorId;
  }

  if (message.causationId) {
    attributes.causationId = message.causationId;
  }

  return attributes;
}

export function isOddsBackfillCommandMessage(
  message: MlbPubsubMessage
): message is OddsBackfillCommandMessage {
  return message.messageType === "odds.backfill.command.v1";
}

export function isOddsBackfillSnapshotRequestedMessage(
  message: MlbPubsubMessage
): message is OddsBackfillSnapshotRequestedMessage {
  return message.messageType === "odds.backfill.snapshot.requested.v1";
}

export function isOddsBackfillSnapshotCompletedMessage(
  message: MlbPubsubMessage
): message is OddsBackfillSnapshotCompletedMessage {
  return message.messageType === "odds.backfill.snapshot.completed.v1";
}

export function isOddsBackfillSnapshotFailedMessage(
  message: MlbPubsubMessage
): message is OddsBackfillSnapshotFailedMessage {
  return message.messageType === "odds.backfill.snapshot.failed.v1";
}

export function isOddsBackfillRunCompletedMessage(
  message: MlbPubsubMessage
): message is OddsBackfillRunCompletedMessage {
  return message.messageType === "odds.backfill.run.completed.v1";
}

export function isLiveMonitorCommandMessage(
  message: MlbPubsubMessage
): message is LiveMonitorCommandMessage {
  return message.messageType === "live.monitor.command.v1";
}

export function isLiveMonitorTickMessage(
  message: MlbPubsubMessage
): message is LiveMonitorTickMessage {
  return message.messageType === "live.monitor.tick.v1";
}

export function isLiveStateCommittedMessage(
  message: MlbPubsubMessage
): message is LiveStateCommittedMessage {
  return message.messageType === "live.state.committed.v1";
}

export function isLiveMonitorAlertMessage(
  message: MlbPubsubMessage
): message is LiveMonitorAlertMessage {
  return message.messageType === "live.monitor.alert.v1";
}

export function isoMinuteBucket(input: string | Date): string {
  const date = input instanceof Date ? input : new Date(input);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date for isoMinuteBucket: ${String(input)}`);
  }

  date.setUTCSeconds(0, 0);
  return date.toISOString();
}

export function ensureNoSecretsInPayload(message: MlbPubsubMessage): void {
  const serialized = JSON.stringify(message.payload).toLowerCase();

  const forbiddenFragments = [
    "api_key",
    "apikey",
    "api-key",
    "authorization",
    "bearer ",
    "secret",
    "password",
    "token"
  ];

  for (const fragment of forbiddenFragments) {
    if (serialized.includes(fragment)) {
      throw new Error(
        `Payload appears to contain forbidden secret-like fragment: ${fragment}`
      );
    }
  }
}

export function validateForPublish(message: unknown): MlbPubsubMessage {
  const parsed = parseMlbPubsubMessage(message);
  ensureNoSecretsInPayload(parsed);
  return parsed;
}

export function makeEnvelopeBase(input: {
  messageType: MessageType;
  messageId: string;
  tenantId: string;
  environment: z.infer<typeof EnvironmentSchema>;
  correlationId: string;
  causationId?: string | null;
  runId?: string | null;
  monitorId?: string | null;
  idempotencyKey: string;
  publishedAt?: string;
  source: string;
  priority?: z.infer<typeof PrioritySchema>;
}) {
  return {
    schemaVersion: MLB_PIPELINE_SCHEMA_VERSION,
    contractName: MLB_PIPELINE_CONTRACT_NAME,
    messageType: input.messageType,
    messageId: input.messageId,
    tenantId: input.tenantId,
    environment: input.environment,
    correlationId: input.correlationId,
    causationId: input.causationId ?? null,
    runId: input.runId ?? null,
    monitorId: input.monitorId ?? null,
    idempotencyKey: input.idempotencyKey,
    publishedAt: input.publishedAt ?? new Date().toISOString(),
    source: input.source,
    priority: input.priority ?? "NORMAL"
  };
}

export function buildOddsSnapshotIdempotencyKey(input: {
  runId: string;
  sport: string;
  requestedSnapshotDate: string;
  markets: string[];
  regions: string[];
  bookmakers: string[];
  snapshotType: string;
}): string {
  const markets = [...input.markets].sort().join("-");
  const regions = [...input.regions].sort().join("-");
  const bookmakers =
    input.bookmakers.length > 0 ? [...input.bookmakers].sort().join("-") : "all";

  return [
    "odds-snapshot",
    input.runId,
    input.sport,
    input.requestedSnapshotDate,
    markets,
    regions,
    bookmakers,
    input.snapshotType
  ].join(":");
}

export function buildLiveMonitorTickIdempotencyKey(input: {
  monitorId: string;
  eventId?: string | null;
  gamePk?: string | null;
  evaluationTime: string;
}): string {
  const eventKey = input.gamePk || input.eventId;

  if (!eventKey) {
    throw new Error("buildLiveMonitorTickIdempotencyKey requires eventId or gamePk.");
  }

  return [
    "live-monitor-tick",
    input.monitorId,
    eventKey,
    isoMinuteBucket(input.evaluationTime)
  ].join(":");
}

export function buildLiveAlertIdempotencyKey(input: {
  tenantId: string;
  monitorId: string;
  alertRuleHash: string;
  eventId?: string | null;
  gamePk?: string | null;
  triggeredAt: string;
  dedupeWindowSeconds: number;
}): string {
  const eventKey = input.gamePk || input.eventId;

  if (!eventKey) {
    throw new Error("buildLiveAlertIdempotencyKey requires eventId or gamePk.");
  }

  const triggeredMs = new Date(input.triggeredAt).getTime();
  if (!Number.isFinite(triggeredMs)) {
    throw new Error(`Invalid triggeredAt date: ${input.triggeredAt}`);
  }

  const bucketMs = Math.floor(triggeredMs / (input.dedupeWindowSeconds * 1000)) * (input.dedupeWindowSeconds * 1000);
  const dedupeBucketIso = new Date(bucketMs).toISOString();

  return [
    "live-alert",
    input.tenantId,
    input.monitorId,
    input.alertRuleHash,
    eventKey,
    dedupeBucketIso
  ].join(":");
}
