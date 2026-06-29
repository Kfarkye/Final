-- 002_mlb_pubsub_pipeline_v1_2.ddl
--
-- Truth MLB Pub/Sub Pipeline v1.2 control-plane schema.
--
-- Purpose:
--   Adds commercially viable control-plane tables for:
--   - Pub/Sub schema registry
--   - odds historical backfill run tracking
--   - per-snapshot job tracking
--   - global idempotency
--   - transactional outbox
--   - provider request logging
--   - live monitors
--   - live monitor evaluations
--   - live game signal snapshots
--   - alert ledger
--   - notification delivery ledger
--   - dead-letter ledger
--
-- Notes:
--   1. This migration intentionally does NOT recreate existing domain tables such as:
--        MlbGames
--        MlbOddsHistory
--        MlbPlayByPlay
--        PitchData
--
--   2. Existing MlbOddsHistory remains the canonical historical odds table.
--      These new tables are pipeline/control-plane tables.
--
--   3. Primary keys use bounded STRING lengths instead of STRING(MAX).
--      This is a commercial production correction for Cloud Spanner key design.
--
--   4. All tables are tenant/environment aware so the same physical database can safely
--      separate dev/staging/prod or future customer/tenant scopes if needed.
--
--   5. JSON columns are used for flexible rules, receipts, payloads, and normalized
--      provider metadata. Frequently filtered dimensions are broken out into typed columns.
--
--   6. Spanner TTL (ROW DELETION POLICY) is added to all event/log/ledger tables.

CREATE TABLE MlbPipelineSchemaRegistry (
  TenantId STRING(64) NOT NULL,
  Environment STRING(32) NOT NULL,
  ContractName STRING(128) NOT NULL,
  ContractVersion STRING(32) NOT NULL,
  Status STRING(32) NOT NULL,
  SchemaJson JSON NOT NULL,
  CompatibilityMode STRING(32),
  SupersedesVersion STRING(32),
  CreatedBy STRING(128),
  CreatedAt TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp=true),
  UpdatedAt TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp=true)
) PRIMARY KEY (
  TenantId,
  Environment,
  ContractName,
  ContractVersion
);

CREATE INDEX MlbPipelineSchemaRegistryByStatus
ON MlbPipelineSchemaRegistry (
  TenantId,
  Environment,
  Status,
  ContractName,
  ContractVersion
);

CREATE TABLE MlbOddsBackfillRuns (
  TenantId STRING(64) NOT NULL,
  Environment STRING(32) NOT NULL,
  RunId STRING(128) NOT NULL,
  CommandMessageId STRING(64),
  CorrelationId STRING(128),
  Status STRING(32) NOT NULL,
  Sport STRING(64) NOT NULL,
  Provider STRING(64) NOT NULL,
  StartDate TIMESTAMP,
  EndDate TIMESTAMP,
  IntervalHours FLOAT64,
  MarketsJson JSON,
  RegionsJson JSON,
  BookmakersJson JSON,
  SnapshotType STRING(64),
  QuotaFloor INT64,
  MaxCreditsBudget INT64,
  CreditsReserved INT64,
  CreditsUsed INT64,
  CreateMissingParents BOOL,
  StrictParentRequired BOOL,
  DryRun BOOL,
  RequestedBy STRING(128),
  Priority STRING(32),
  PlannedSnapshotCount INT64,
  PublishedSnapshotCount INT64,
  SnapshotsPlanned INT64,
  SnapshotsCompleted INT64,
  SnapshotsFailed INT64,
  SnapshotsSkipped INT64,
  EventsSeen INT64,
  EventsMatchedToParent INT64,
  EventsSkippedNoParent INT64,
  EventsAmbiguousParent INT64,
  ParentGamesCreated INT64,
  HighFidelityRowsWritten INT64,
  ThinRollupRowsWritten INT64,
  RowsDeduped INT64,
  HistoryRowsPrepared INT64,
  HistoryRowsWritten INT64,
  HistoryRowsDeduped INT64,
  LastRequestedSnapshotDate TIMESTAMP,
  LastApiTimestampReturned TIMESTAMP,
  LastQuotaRemaining INT64,
  LastQuotaUsed INT64,
  LastRequestCost INT64,
  LastErrorCode STRING(128),
  LastErrorMessage STRING(MAX),
  CreatedAt TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp=true),
  UpdatedAt TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp=true),
  StartedAt TIMESTAMP,
  FinishedAt TIMESTAMP,
  ExpiresAt TIMESTAMP
) PRIMARY KEY (
  TenantId,
  Environment,
  RunId
);

CREATE INDEX MlbOddsBackfillRunsByStatus
ON MlbOddsBackfillRuns (
  TenantId,
  Environment,
  Status,
  UpdatedAt DESC
);

CREATE INDEX MlbOddsBackfillRunsBySportProvider
ON MlbOddsBackfillRuns (
  TenantId,
  Environment,
  Sport,
  Provider,
  Status,
  CreatedAt DESC
);

CREATE INDEX MlbOddsBackfillRunsByCorrelationId
ON MlbOddsBackfillRuns (
  TenantId,
  Environment,
  CorrelationId,
  CreatedAt DESC
);

CREATE TABLE MlbOddsBackfillSnapshotJobs (
  TenantId STRING(64) NOT NULL,
  Environment STRING(32) NOT NULL,
  RunId STRING(128) NOT NULL,
  RequestedSnapshotDate TIMESTAMP NOT NULL,
  JobId STRING(160) NOT NULL,
  Status STRING(32) NOT NULL,
  Sport STRING(64) NOT NULL,
  Provider STRING(64) NOT NULL,
  MarketsJson JSON,
  RegionsJson JSON,
  BookmakersJson JSON,
  SnapshotType STRING(64),
  ApiTimestampReturned TIMESTAMP,
  AttemptCount INT64,
  MaxAttempts INT64,
  LastAttemptAt TIMESTAMP,
  NextAttemptAt TIMESTAMP,
  WorkerId STRING(128),
  LeaseToken STRING(128),
  LeaseExpiresAt TIMESTAMP,
  EventsSeen INT64,
  EventsMatchedToParent INT64,
  EventsSkippedNoParent INT64,
  EventsAmbiguousParent INT64,
  ParentGamesCreated INT64,
  HighFidelityRowsWritten INT64,
  ThinRollupRowsWritten INT64,
  RowsDeduped INT64,
  HistoryRowsPrepared INT64,
  HistoryRowsWritten INT64,
  HistoryRowsDeduped INT64,
  QuotaRemaining INT64,
  QuotaUsed INT64,
  LastRequestCost INT64,
  LastErrorCode STRING(128),
  LastErrorMessage STRING(MAX),
  CreatedAt TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp=true),
  UpdatedAt TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp=true),
  PublishedAt TIMESTAMP,
  StartedAt TIMESTAMP,
  FinishedAt TIMESTAMP
) PRIMARY KEY (
  TenantId,
  Environment,
  RunId,
  RequestedSnapshotDate
);

CREATE INDEX MlbOddsBackfillSnapshotJobsByRunStatus
ON MlbOddsBackfillSnapshotJobs (
  TenantId,
  Environment,
  RunId,
  Status,
  RequestedSnapshotDate
);

CREATE INDEX MlbOddsBackfillSnapshotJobsRetryable
ON MlbOddsBackfillSnapshotJobs (
  TenantId,
  Environment,
  Status,
  NextAttemptAt,
  AttemptCount
);

CREATE INDEX MlbOddsBackfillSnapshotJobsByLease
ON MlbOddsBackfillSnapshotJobs (
  TenantId,
  Environment,
  LeaseExpiresAt,
  Status
);

CREATE TABLE MlbPipelineMessageLedger (
  TenantId STRING(64) NOT NULL,
  Environment STRING(32) NOT NULL,
  IdempotencyKey STRING(512) NOT NULL,
  MessageId STRING(64) NOT NULL,
  MessageType STRING(128) NOT NULL,
  SchemaVersion STRING(32) NOT NULL,
  CorrelationId STRING(128),
  CausationId STRING(64),
  RunId STRING(128),
  MonitorId STRING(128),
  Source STRING(128),
  Priority STRING(32),
  Status STRING(32) NOT NULL,
  DeliveryAttempt INT64,
  PayloadHash STRING(128),
  FirstSeenAt TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp=true),
  LastSeenAt TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp=true),
  ProcessingStartedAt TIMESTAMP,
  SideEffectCommittedAt TIMESTAMP,
  ResultPublishedAt TIMESTAMP,
  CompletedAt TIMESTAMP,
  FailedAt TIMESTAMP,
  ErrorCode STRING(128),
  ErrorMessage STRING(MAX),
  ErrorDetailsJson JSON
) PRIMARY KEY (
  TenantId,
  Environment,
  IdempotencyKey
), ROW DELETION POLICY (OLDER_THAN(LastSeenAt, INTERVAL 90 DAY));

CREATE INDEX MlbPipelineMessageLedgerByMessageId
ON MlbPipelineMessageLedger (
  TenantId,
  Environment,
  MessageId
);

CREATE INDEX MlbPipelineMessageLedgerByStatus
ON MlbPipelineMessageLedger (
  TenantId,
  Environment,
  Status,
  LastSeenAt DESC
);

CREATE INDEX MlbPipelineMessageLedgerByRun
ON MlbPipelineMessageLedger (
  TenantId,
  Environment,
  RunId,
  MessageType,
  Status,
  LastSeenAt DESC
);

CREATE INDEX MlbPipelineMessageLedgerByMonitor
ON MlbPipelineMessageLedger (
  TenantId,
  Environment,
  MonitorId,
  MessageType,
  Status,
  LastSeenAt DESC
);

CREATE TABLE MlbPipelineOutbox (
  TenantId STRING(64) NOT NULL,
  Environment STRING(32) NOT NULL,
  OutboxId STRING(128) NOT NULL,
  Topic STRING(256) NOT NULL,
  MessageType STRING(128) NOT NULL,
  SchemaVersion STRING(32) NOT NULL,
  IdempotencyKey STRING(512) NOT NULL,
  CorrelationId STRING(128),
  CausationId STRING(64),
  RunId STRING(128),
  MonitorId STRING(128),
  OrderingKey STRING(256),
  AttributesJson JSON,
  PayloadJson JSON NOT NULL,
  PayloadHash STRING(128),
  Status STRING(32) NOT NULL,
  AttemptCount INT64,
  MaxAttempts INT64,
  NextAttemptAt TIMESTAMP,
  PublishedMessageId STRING(128),
  LastErrorCode STRING(128),
  LastErrorMessage STRING(MAX),
  CreatedAt TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp=true),
  UpdatedAt TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp=true),
  PublishedAt TIMESTAMP
) PRIMARY KEY (
  TenantId,
  Environment,
  OutboxId
), ROW DELETION POLICY (OLDER_THAN(CreatedAt, INTERVAL 30 DAY));

CREATE INDEX MlbPipelineOutboxPending
ON MlbPipelineOutbox (
  TenantId,
  Environment,
  Status,
  NextAttemptAt,
  CreatedAt
);

CREATE INDEX MlbPipelineOutboxByRun
ON MlbPipelineOutbox (
  TenantId,
  Environment,
  RunId,
  Status,
  CreatedAt DESC
);

CREATE INDEX MlbPipelineOutboxByMonitor
ON MlbPipelineOutbox (
  TenantId,
  Environment,
  MonitorId,
  Status,
  CreatedAt DESC
);

CREATE INDEX MlbPipelineOutboxByIdempotencyKey
ON MlbPipelineOutbox (
  TenantId,
  Environment,
  IdempotencyKey
);

CREATE TABLE MlbProviderRequestLog (
  TenantId STRING(64) NOT NULL,
  Environment STRING(32) NOT NULL,
  RequestId STRING(128) NOT NULL,
  Provider STRING(64) NOT NULL,
  Endpoint STRING(512),
  Method STRING(16),
  Sport STRING(64),
  EventId STRING(128),
  GamePk STRING(64),
  RunId STRING(128),
  MonitorId STRING(128),
  RequestedAt TIMESTAMP NOT NULL,
  CompletedAt TIMESTAMP,
  DurationMs INT64,
  HttpStatus INT64,
  Retryable BOOL,
  RateLimited BOOL,
  RequestsRemaining INT64,
  RequestsUsed INT64,
  LastRequestCost INT64,
  RequestParamsJson JSON,
  ResponseMetadataJson JSON,
  ErrorCode STRING(128),
  ErrorMessage STRING(MAX),
  CreatedAt TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp=true)
) PRIMARY KEY (
  TenantId,
  Environment,
  RequestId
);

CREATE INDEX MlbProviderRequestLogByProviderTime
ON MlbProviderRequestLog (
  TenantId,
  Environment,
  Provider,
  RequestedAt DESC
);

CREATE INDEX MlbProviderRequestLogByRun
ON MlbProviderRequestLog (
  TenantId,
  Environment,
  RunId,
  RequestedAt DESC
);

CREATE INDEX MlbProviderRequestLogByMonitor
ON MlbProviderRequestLog (
  TenantId,
  Environment,
  MonitorId,
  RequestedAt DESC
);

CREATE INDEX MlbProviderRequestLogByStatus
ON MlbProviderRequestLog (
  TenantId,
  Environment,
  Provider,
  HttpStatus,
  RequestedAt DESC
);

CREATE TABLE MlbLiveMonitors (
  TenantId STRING(64) NOT NULL,
  Environment STRING(32) NOT NULL,
  MonitorId STRING(128) NOT NULL,
  Status STRING(32) NOT NULL,
  Sport STRING(32) NOT NULL,
  EventId STRING(128),
  GamePk STRING(64),
  TeamFocusJson JSON,
  Label STRING(256),
  RulesJson JSON,
  NotificationTargetsJson JSON,
  CreatedBy STRING(128),
  CreatedAt TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp=true),
  UpdatedAt TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp=true),
  LastTickPublishedAt TIMESTAMP,
  LastEvaluatedAt TIMESTAMP,
  LastAlertAt TIMESTAMP,
  ExpiresAt TIMESTAMP,
  CancelledAt TIMESTAMP,
  CancelledBy STRING(128),
  Version INT64
) PRIMARY KEY (
  TenantId,
  Environment,
  MonitorId
);

CREATE INDEX MlbLiveMonitorsByStatus
ON MlbLiveMonitors (
  TenantId,
  Environment,
  Status,
  ExpiresAt,
  UpdatedAt DESC
);

CREATE INDEX MlbLiveMonitorsByGamePk
ON MlbLiveMonitors (
  TenantId,
  Environment,
  GamePk,
  Status,
  UpdatedAt DESC
);

CREATE INDEX MlbLiveMonitorsByEventId
ON MlbLiveMonitors (
  TenantId,
  Environment,
  EventId,
  Status,
  UpdatedAt DESC
);

CREATE TABLE MlbLiveMonitorEvaluations (
  TenantId STRING(64) NOT NULL,
  Environment STRING(32) NOT NULL,
  MonitorId STRING(128) NOT NULL,
  EvaluationBucket TIMESTAMP NOT NULL,
  EventKey STRING(128) NOT NULL,
  Status STRING(32) NOT NULL,
  EventId STRING(128),
  GamePk STRING(64),
  EvaluationTime TIMESTAMP,
  StartedAt TIMESTAMP,
  FinishedAt TIMESTAMP,
  ForceRefresh BOOL,
  MaxAgeSeconds INT64,
  StaleSkipped BOOL,
  SignalsJson JSON,
  ReceiptsJson JSON,
  AlertPublished BOOL,
  AlertId STRING(128),
  LastErrorCode STRING(128),
  LastErrorMessage STRING(MAX),
  CreatedAt TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp=true),
  UpdatedAt TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp=true)
) PRIMARY KEY (
  TenantId,
  Environment,
  MonitorId,
  EvaluationBucket,
  EventKey
), ROW DELETION POLICY (OLDER_THAN(EvaluationBucket, INTERVAL 30 DAY));

CREATE INDEX MlbLiveMonitorEvaluationsByStatus
ON MlbLiveMonitorEvaluations (
  TenantId,
  Environment,
  Status,
  EvaluationBucket DESC
);

CREATE INDEX MlbLiveMonitorEvaluationsByGame
ON MlbLiveMonitorEvaluations (
  TenantId,
  Environment,
  GamePk,
  EvaluationBucket DESC
);

CREATE INDEX MlbLiveMonitorEvaluationsByMonitorStatus
ON MlbLiveMonitorEvaluations (
  TenantId,
  Environment,
  MonitorId,
  Status,
  EvaluationBucket DESC
);

CREATE TABLE MlbLiveGameStateSnapshots (
  TenantId STRING(64) NOT NULL,
  Environment STRING(32) NOT NULL,
  GamePk STRING(64) NOT NULL,
  ObservedAt TIMESTAMP NOT NULL,
  SourceSetHash STRING(128) NOT NULL,
  EventId STRING(128),
  GameStatus STRING(64),
  Inning STRING(64),
  InningNumber INT64,
  InningHalf STRING(16),
  Score STRING(64),
  HomeTeam STRING(128),
  AwayTeam STRING(128),
  HomeTeamAbbr STRING(16),
  AwayTeamAbbr STRING(16),
  HomeScore INT64,
  AwayScore INT64,
  LiveTotal FLOAT64,
  PreviousLiveTotal FLOAT64,
  LiveTotalSource STRING(64),
  LiveTotalBookmaker STRING(64),
  CurrentPitcherId STRING(64),
  CurrentPitcherName STRING(128),
  CurrentPitcherRole STRING(32),
  StarterPitcherId STRING(64),
  StarterPitcherName STRING(128),
  StarterPitchCount INT64,
  StarterStillInGame BOOL,
  BullpenEntered BOOL,
  RelieverEnteredAt TIMESTAMP,
  VelocityDropMph FLOAT64,
  CommandRiskScore FLOAT64,
  CommandRiskModelVersion STRING(64),
  Walks INT64,
  ThreeBallCounts INT64,
  HardContactRecent BOOL,
  RunnersInScoringPosition BOOL,
  SignalsJson JSON,
  ReceiptsJson JSON NOT NULL,
  CreatedAt TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp=true)
) PRIMARY KEY (
  TenantId,
  Environment,
  GamePk,
  ObservedAt,
  SourceSetHash
), ROW DELETION POLICY (OLDER_THAN(ObservedAt, INTERVAL 180 DAY));

CREATE INDEX MlbLiveGameStateSnapshotsLatestByGame
ON MlbLiveGameStateSnapshots (
  TenantId,
  Environment,
  GamePk,
  ObservedAt DESC
);

CREATE INDEX MlbLiveGameStateSnapshotsByEvent
ON MlbLiveGameStateSnapshots (
  TenantId,
  Environment,
  EventId,
  ObservedAt DESC
);

CREATE INDEX MlbLiveGameStateSnapshotsByLiveTotal
ON MlbLiveGameStateSnapshots (
  TenantId,
  Environment,
  LiveTotal,
  ObservedAt DESC
);

CREATE INDEX MlbLiveGameStateSnapshotsByPitchCount
ON MlbLiveGameStateSnapshots (
  TenantId,
  Environment,
  StarterPitchCount,
  ObservedAt DESC
);

CREATE TABLE MlbLiveMonitorAlerts (
  TenantId STRING(64) NOT NULL,
  Environment STRING(32) NOT NULL,
  MonitorId STRING(128) NOT NULL,
  AlertId STRING(128) NOT NULL,
  AlertRuleHash STRING(128),
  DedupeBucket TIMESTAMP,
  EventId STRING(128),
  GamePk STRING(64),
  Severity STRING(32) NOT NULL,
  Headline STRING(512) NOT NULL,
  Sport STRING(32) NOT NULL,
  HomeTeam STRING(128),
  AwayTeam STRING(128),
  GameStatus STRING(64),
  Inning STRING(64),
  Score STRING(64),
  SignalsJson JSON NOT NULL,
  ReceiptsJson JSON NOT NULL,
  TriggeredAt TIMESTAMP NOT NULL,
  FirstDeliveredAt TIMESTAMP,
  LastDeliveredAt TIMESTAMP,
  DeliveryStatus STRING(32),
  CreatedAt TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp=true)
) PRIMARY KEY (
  TenantId,
  Environment,
  MonitorId,
  AlertId
), ROW DELETION POLICY (OLDER_THAN(TriggeredAt, INTERVAL 365 DAY));

CREATE UNIQUE INDEX MlbLiveMonitorAlertsByDedupe
ON MlbLiveMonitorAlerts (
  TenantId,
  Environment,
  MonitorId,
  AlertRuleHash,
  GamePk,
  DedupeBucket
);

CREATE INDEX MlbLiveMonitorAlertsByGame
ON MlbLiveMonitorAlerts (
  TenantId,
  Environment,
  GamePk,
  TriggeredAt DESC
);

CREATE INDEX MlbLiveMonitorAlertsBySeverity
ON MlbLiveMonitorAlerts (
  TenantId,
  Environment,
  Severity,
  TriggeredAt DESC
);

CREATE INDEX MlbLiveMonitorAlertsByDeliveryStatus
ON MlbLiveMonitorAlerts (
  TenantId,
  Environment,
  DeliveryStatus,
  TriggeredAt DESC
);

CREATE TABLE MlbNotificationDeliveries (
  TenantId STRING(64) NOT NULL,
  Environment STRING(32) NOT NULL,
  DeliveryId STRING(128) NOT NULL,
  MonitorId STRING(128) NOT NULL,
  AlertId STRING(128) NOT NULL,
  TargetType STRING(32) NOT NULL,
  TargetHash STRING(128) NOT NULL,
  Status STRING(32) NOT NULL,
  AttemptCount INT64,
  MaxAttempts INT64,
  NextAttemptAt TIMESTAMP,
  Provider STRING(64),
  ProviderMessageId STRING(128),
  LastErrorCode STRING(128),
  LastErrorMessage STRING(MAX),
  CreatedAt TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp=true),
  UpdatedAt TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp=true),
  DeliveredAt TIMESTAMP
) PRIMARY KEY (
  TenantId,
  Environment,
  DeliveryId
), ROW DELETION POLICY (OLDER_THAN(CreatedAt, INTERVAL 365 DAY));

CREATE INDEX MlbNotificationDeliveriesPending
ON MlbNotificationDeliveries (
  TenantId,
  Environment,
  Status,
  NextAttemptAt,
  CreatedAt
);

CREATE INDEX MlbNotificationDeliveriesByAlert
ON MlbNotificationDeliveries (
  TenantId,
  Environment,
  MonitorId,
  AlertId,
  CreatedAt
);

CREATE INDEX MlbNotificationDeliveriesByTarget
ON MlbNotificationDeliveries (
  TenantId,
  Environment,
  TargetType,
  TargetHash,
  CreatedAt DESC
);

CREATE TABLE MlbPipelineDeadLetters (
  TenantId STRING(64) NOT NULL,
  Environment STRING(32) NOT NULL,
  DeadLetterId STRING(128) NOT NULL,
  OriginalTopic STRING(256),
  OriginalSubscription STRING(256),
  OriginalMessageId STRING(64),
  MessageType STRING(128),
  SchemaVersion STRING(32),
  CorrelationId STRING(128),
  RunId STRING(128),
  MonitorId STRING(128),
  IdempotencyKey STRING(512),
  DeliveryAttempt INT64,
  FailureCode STRING(128),
  FailureMessage STRING(MAX),
  FailureDetailsJson JSON,
  OriginalAttributesJson JSON,
  OriginalPayloadJson JSON,
  Status STRING(32) NOT NULL,
  AssignedTo STRING(128),
  Resolution STRING(MAX),
  CreatedAt TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp=true),
  UpdatedAt TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp=true),
  ResolvedAt TIMESTAMP
) PRIMARY KEY (
  TenantId,
  Environment,
  DeadLetterId
);

CREATE INDEX MlbPipelineDeadLettersByStatus
ON MlbPipelineDeadLetters (
  TenantId,
  Environment,
  Status,
  CreatedAt DESC
);

CREATE INDEX MlbPipelineDeadLettersByRun
ON MlbPipelineDeadLetters (
  TenantId,
  Environment,
  RunId,
  CreatedAt DESC
);

CREATE INDEX MlbPipelineDeadLettersByMonitor
ON MlbPipelineDeadLetters (
  TenantId,
  Environment,
  MonitorId,
  CreatedAt DESC
);

CREATE INDEX MlbPipelineDeadLettersByFailureCode
ON MlbPipelineDeadLetters (
  TenantId,
  Environment,
  FailureCode,
  CreatedAt DESC
);
