import { Router, Request, Response } from "express";
import { OAuth2Client } from "google-auth-library";
import { edgeDb } from "../db/spanner.js";
import { logger } from "../utils/logger.js";
import {
  decodePubsubPushMessage,
  ensureNoSecretsInPayload,
  MlbPubsubMessage
} from "../contracts/mlbPubsubPipeline.v1.2.js";

const authClient = new OAuth2Client();
export const pubsubWorkersRouter = Router();

// Middleware: Verify Google Pub/Sub OIDC ID Token
async function verifyPubsubOidc(req: Request, res: Response, next: any) {
  // Bypass OIDC verification in development if explicitly requested via header
  if (process.env.NODE_ENV !== "production" && req.headers["x-bypass-oidc"] === "true") {
    return next();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    logger.warn({ msg: "Missing or invalid Authorization header on Pub/Sub route" });
    return res.status(401).json({ error: "Missing or invalid Authorization header" });
  }

  const token = authHeader.split(" ")[1];
  const expectedAudience = `${req.protocol}://${req.get("host")}${req.originalUrl}`;

  try {
    const ticket = await authClient.verifyIdToken({
      idToken: token,
      audience: expectedAudience
    });
    
    const payload = ticket.getPayload();
    const allowedEmails = [
      "truth-ingest-invoker@gen-lang-client-0281999829.iam.gserviceaccount.com",
      "70323048967-compute@developer.gserviceaccount.com" // Compute Engine Default Service Account
    ];

    if (!payload || !payload.email || !allowedEmails.includes(payload.email)) {
      logger.error({ msg: "OIDC token identity rejected", email: payload?.email });
      return res.status(403).json({ error: `Unauthorized identity: ${payload?.email}` });
    }

    next();
  } catch (err: any) {
    logger.error({ msg: "OIDC token verification failed", error: err.message });
    return res.status(401).json({ error: `OIDC verification failed: ${err.message}` });
  }
}

// Helper to wrap the database transaction and prevent premature acking
async function handlePubsubMessage(
  req: Request,
  res: Response,
  expectedType: string,
  persistSideEffect: (txn: any, msg: MlbPubsubMessage) => Promise<void>
) {
  const startMs = Date.now();
  let decodedMessage: MlbPubsubMessage;

  try {
    // 1. Decode Pub/Sub envelope
    decodedMessage = decodePubsubPushMessage(req.body);

    // 2. Validate message type matches the endpoint
    if (decodedMessage.messageType !== expectedType) {
      logger.error({
        msg: "Pub/Sub message type mismatch",
        expected: expectedType,
        received: decodedMessage.messageType
      });
      return res.status(400).json({ error: `Expected message type ${expectedType}` });
    }

    // 3. Safety: Ensure no credentials/secrets exist in payload
    ensureNoSecretsInPayload(decodedMessage);

  } catch (err: any) {
    logger.error({ msg: "Failed to decode/validate Pub/Sub envelope", error: err.message });
    // Return 200/204 on schema validation or security block to prevent infinite DLQ loops
    return res.status(204).end();
  }

  const { tenantId, environment, idempotencyKey, messageId } = decodedMessage;

  try {
    // 4. Run inside a Spanner transaction to ensure exact-once processing
    await edgeDb.runTransactionAsync(async (transaction) => {
      // Check idempotency ledger
      const [existing] = await transaction.run({
        sql: `SELECT Status FROM MlbPipelineMessageLedger 
              WHERE TenantId = @tenantId 
              AND Environment = @environment 
              AND IdempotencyKey = @idempotencyKey`,
        params: { tenantId, environment, idempotencyKey }
      });

      if (existing && existing.length > 0) {
        const status = (existing[0] as any).Status;
        if (status === "COMPLETED") {
          logger.info({ msg: "Message already successfully processed", idempotencyKey });
          return;
        }
      }

      // Record the message as PROCESSING in the ledger
      await transaction.run({
        sql: `INSERT OR UPDATE MlbPipelineMessageLedger (
                TenantId, Environment, MessageId, IdempotencyKey, MessageType, 
                Status, CorrelationId, Source, LastSeenAt
              ) VALUES (
                @tenantId, @environment, @messageId, @idempotencyKey, @messageType, 
                'PROCESSING', @correlationId, @source, PENDING_COMMIT_TIMESTAMP()
              )`,
        params: {
          tenantId,
          environment,
          messageId,
          idempotencyKey,
          messageType: decodedMessage.messageType,
          correlationId: decodedMessage.correlationId,
          source: decodedMessage.source
        }
      });

      // 5. Execute the specific database side effect
      await persistSideEffect(transaction, decodedMessage);

      // 6. Update ledger to COMPLETED
      await transaction.run({
        sql: `UPDATE MlbPipelineMessageLedger 
              SET Status = 'COMPLETED', LastSeenAt = PENDING_COMMIT_TIMESTAMP()
              WHERE TenantId = @tenantId 
              AND Environment = @environment 
              AND IdempotencyKey = @idempotencyKey`,
        params: { tenantId, environment, idempotencyKey }
      });
    });

    logger.info({
      msg: "Pub/Sub message processed and durably committed",
      messageId,
      idempotencyKey,
      durationMs: Date.now() - startMs
    });

    // 7. Acknowledge message only after durable Spanner commit
    return res.status(204).end();

  } catch (err: any) {
    logger.error({
      msg: "Spanner transaction failed for Pub/Sub message",
      idempotencyKey,
      error: err.message,
      stack: err.stack
    });

    // Return a 503 so Pub/Sub retries the message for transient Spanner errors
    return res.status(503).json({ error: `Transient processing failure: ${err.message}` });
  }
}

// ── Endpoints & Side Effects ──────────────────────────────────────────────────

// A. Odds Backfill Command
pubsubWorkersRouter.post(
  "/internal/pubsub/v1/odds-backfill-command",
  verifyPubsubOidc,
  async (req: Request, res: Response) => {
    await handlePubsubMessage(req, res, "odds.backfill.command.v1", async (txn, msg) => {
      const payload = msg.payload as any;
      await txn.run({
        sql: `INSERT OR UPDATE MlbOddsBackfillRuns (
                TenantId, Environment, RunId, CommandMessageId, CorrelationId, 
                Status, Sport, Provider, StartDate, EndDate, IntervalHours, 
                MarketsJson, RegionsJson, BookmakersJson, SnapshotType, QuotaFloor, 
                MaxCreditsBudget, CreditsReserved, CreditsUsed, CreateMissingParents, 
                StrictParentRequired, DryRun, RequestedBy, Priority, 
                CreatedAt, UpdatedAt
              ) VALUES (
                @tenantId, @environment, @runId, @messageId, @correlationId, 
                'PLANNED', @sport, @provider, @startDate, @endDate, @intervalHours, 
                TO_JSON(@markets), TO_JSON(@regions), TO_JSON(@bookmakers), @snapshotType, @quotaFloor, 
                @maxCreditsBudget, 0, 0, @createMissingParents, 
                @strictParentRequired, @dryRun, @requestedBy, @priority, 
                PENDING_COMMIT_TIMESTAMP(), PENDING_COMMIT_TIMESTAMP()
              )`,
        params: {
          tenantId: msg.tenantId,
          environment: msg.environment,
          runId: msg.runId || `run-${msg.messageId}`,
          messageId: msg.messageId,
          correlationId: msg.correlationId,
          sport: payload.sport,
          provider: payload.provider,
          startDate: payload.startDate ? new Date(payload.startDate) : null,
          endDate: payload.endDate ? new Date(payload.endDate) : null,
          intervalHours: payload.intervalHours,
          markets: payload.markets,
          regions: payload.regions,
          bookmakers: payload.bookmakers,
          snapshotType: payload.snapshotType,
          quotaFloor: payload.quotaFloor,
          maxCreditsBudget: payload.maxCreditsBudget,
          createMissingParents: payload.createMissingParents,
          strictParentRequired: payload.strictParentRequired,
          dryRun: payload.dryRun,
          requestedBy: payload.requestedBy,
          priority: msg.priority
        }
      });
    });
  }
);

// B. Odds Backfill Snapshot Requested (Materialize Job for Background Pull Loop)
pubsubWorkersRouter.post(
  "/internal/pubsub/v1/odds-backfill-snapshot-requested",
  verifyPubsubOidc,
  async (req: Request, res: Response) => {
    await handlePubsubMessage(req, res, "odds.backfill.snapshot.requested.v1", async (txn, msg) => {
      const payload = msg.payload as any;
      await txn.run({
        sql: `INSERT OR UPDATE MlbOddsBackfillSnapshotJobs (
                TenantId, Environment, RunId, RequestedSnapshotDate, JobId, 
                Status, Sport, Provider, MarketsJson, RegionsJson, BookmakersJson, 
                SnapshotType, AttemptCount, MaxAttempts, CreatedAt, UpdatedAt
              ) VALUES (
                @tenantId, @environment, @runId, @requestedSnapshotDate, @jobId, 
                'PLANNED', @sport, @provider, TO_JSON(@markets), TO_JSON(@regions), TO_JSON(@bookmakers), 
                @snapshotType, 0, @maxAttempts, PENDING_COMMIT_TIMESTAMP(), PENDING_COMMIT_TIMESTAMP()
              )`,
        params: {
          tenantId: msg.tenantId,
          environment: msg.environment,
          runId: msg.runId!,
          requestedSnapshotDate: new Date(payload.requestedSnapshotDate),
          jobId: payload.jobId || `job-${msg.messageId}`,
          sport: payload.sport,
          provider: payload.provider,
          markets: payload.markets,
          regions: payload.regions,
          bookmakers: payload.bookmakers,
          snapshotType: payload.snapshotType,
          maxAttempts: payload.maxAttempts
        }
      });
    });
  }
);

// C. Odds Backfill Snapshot Completed
pubsubWorkersRouter.post(
  "/internal/pubsub/v1/odds-backfill-snapshot-result",
  verifyPubsubOidc,
  async (req: Request, res: Response) => {
    await handlePubsubMessage(req, res, "odds.backfill.snapshot.completed.v1", async (txn, msg) => {
      const payload = msg.payload as any;
      const counts = payload.counts;
      const quota = payload.quota;

      await txn.run({
        sql: `UPDATE MlbOddsBackfillSnapshotJobs 
              SET Status = 'COMPLETED', 
                  ApiTimestampReturned = @apiTimestampReturned,
                  EventsSeen = @eventsSeen,
                  EventsMatchedToParent = @eventsMatchedToParent,
                  EventsSkippedNoParent = @eventsSkippedNoParent,
                  EventsAmbiguousParent = @eventsAmbiguousParent,
                  ParentGamesCreated = @parentGamesCreated,
                  HighFidelityRowsWritten = @highFidelityRowsWritten,
                  ThinRollupRowsWritten = @thinRollupRowsWritten,
                  RowsDeduped = @rowsDeduped,
                  HistoryRowsPrepared = @historyRowsPrepared,
                  HistoryRowsWritten = @historyRowsWritten,
                  HistoryRowsDeduped = @historyRowsDeduped,
                  QuotaRemaining = @quotaRemaining,
                  QuotaUsed = @quotaUsed,
                  LastRequestCost = @lastRequestCost,
                  UpdatedAt = PENDING_COMMIT_TIMESTAMP(),
                  FinishedAt = PENDING_COMMIT_TIMESTAMP()
              WHERE TenantId = @tenantId 
              AND Environment = @environment 
              AND RunId = @runId 
              AND RequestedSnapshotDate = @requestedSnapshotDate`,
        params: {
          tenantId: msg.tenantId,
          environment: msg.environment,
          runId: msg.runId!,
          requestedSnapshotDate: new Date(payload.requestedSnapshotDate),
          apiTimestampReturned: payload.apiTimestampReturned ? new Date(payload.apiTimestampReturned) : null,
          eventsSeen: counts.eventsSeen,
          eventsMatchedToParent: counts.eventsMatchedToParent,
          eventsSkippedNoParent: counts.eventsSkippedNoParent,
          eventsAmbiguousParent: counts.eventsAmbiguousParent,
          parentGamesCreated: counts.parentGamesCreated,
          highFidelityRowsWritten: counts.highFidelityRowsWritten,
          thinRollupRowsWritten: counts.thinRollupRowsWritten,
          rowsDeduped: counts.rowsDeduped,
          historyRowsPrepared: counts.historyRowsPrepared,
          historyRowsWritten: counts.historyRowsWritten,
          historyRowsDeduped: counts.historyRowsDeduped,
          quotaRemaining: quota.requestsRemaining,
          quotaUsed: quota.requestsUsed,
          lastRequestCost: quota.lastRequestCost
        }
      });
    });
  }
);

// D. Odds Backfill Snapshot Failed
pubsubWorkersRouter.post(
  "/internal/pubsub/v1/odds-backfill-snapshot-failed",
  verifyPubsubOidc,
  async (req: Request, res: Response) => {
    await handlePubsubMessage(req, res, "odds.backfill.snapshot.failed.v1", async (txn, msg) => {
      const payload = msg.payload as any;
      const err = payload.error;

      await txn.run({
        sql: `UPDATE MlbOddsBackfillSnapshotJobs 
              SET Status = 'FAILED', 
                  AttemptCount = @attempt,
                  LastErrorCode = @code,
                  LastErrorMessage = @message,
                  UpdatedAt = PENDING_COMMIT_TIMESTAMP(),
                  FinishedAt = PENDING_COMMIT_TIMESTAMP()
              WHERE TenantId = @tenantId 
              AND Environment = @environment 
              AND RunId = @runId 
              AND RequestedSnapshotDate = @requestedSnapshotDate`,
        params: {
          tenantId: msg.tenantId,
          environment: msg.environment,
          runId: msg.runId!,
          requestedSnapshotDate: new Date(payload.requestedSnapshotDate),
          attempt: payload.attempt,
          code: err.code,
          message: err.message
        }
      });
    });
  }
);

// E. Odds Backfill Run Completed
pubsubWorkersRouter.post(
  "/internal/pubsub/v1/odds-backfill-run-result",
  verifyPubsubOidc,
  async (req: Request, res: Response) => {
    await handlePubsubMessage(req, res, "odds.backfill.run.completed.v1", async (txn, msg) => {
      const payload = msg.payload as any;
      const counts = payload.counts;

      await txn.run({
        sql: `UPDATE MlbOddsBackfillRuns 
              SET Status = @status, 
                  SnapshotsPlanned = @snapshotsPlanned,
                  SnapshotsCompleted = @snapshotsCompleted,
                  SnapshotsFailed = @snapshotsFailed,
                  SnapshotsSkipped = @snapshotsSkipped,
                  EventsSeen = @eventsSeen,
                  EventsMatchedToParent = @eventsMatchedToParent,
                  EventsSkippedNoParent = @eventsSkippedNoParent,
                  EventsAmbiguousParent = @eventsAmbiguousParent,
                  HistoryRowsWritten = @historyRowsWritten,
                  HistoryRowsPrepared = @historyRowsPrepared,
                  HistoryRowsDeduped = @historyRowsDeduped,
                  StartedAt = @startedAt,
                  FinishedAt = @finishedAt,
                  UpdatedAt = PENDING_COMMIT_TIMESTAMP()
              WHERE TenantId = @tenantId 
              AND Environment = @environment 
              AND RunId = @runId`,
        params: {
          tenantId: msg.tenantId,
          environment: msg.environment,
          runId: msg.runId!,
          status: payload.status,
          snapshotsPlanned: counts.snapshotsPlanned,
          snapshotsCompleted: counts.snapshotsCompleted,
          snapshotsFailed: counts.snapshotsFailed,
          snapshotsSkipped: counts.snapshotsSkipped || 0,
          eventsSeen: counts.eventsSeen,
          eventsMatchedToParent: counts.eventsMatchedToParent,
          eventsSkippedNoParent: counts.eventsSkippedNoParent,
          eventsAmbiguousParent: counts.eventsAmbiguousParent,
          historyRowsWritten: counts.historyRowsWritten,
          historyRowsPrepared: counts.historyRowsPrepared || 0,
          historyRowsDeduped: counts.historyRowsDeduped || 0,
          startedAt: new Date(payload.startedAt),
          finishedAt: new Date(payload.finishedAt)
        }
      });
    });
  }
);

// F. Live Monitor Command
pubsubWorkersRouter.post(
  "/internal/pubsub/v1/live-monitor-command",
  verifyPubsubOidc,
  async (req: Request, res: Response) => {
    await handlePubsubMessage(req, res, "live.monitor.command.v1", async (txn, msg) => {
      const payload = msg.payload as any;
      await txn.run({
        sql: `INSERT OR UPDATE MlbLiveMonitors (
                TenantId, Environment, MonitorId, Status, Sport, EventId, GamePk, 
                TeamFocusJson, Label, RulesJson, NotificationTargetsJson, 
                CommandVersion, RequestedBy, CreatedAt, UpdatedAt
              ) VALUES (
                @tenantId, @environment, @monitorId, 'ACTIVE', @sport, @eventId, @gamePk, 
                TO_JSON(@teamFocus), @label, TO_JSON(@rules), TO_JSON(@notificationTargets), 
                @commandVersion, @requestedBy, PENDING_COMMIT_TIMESTAMP(), PENDING_COMMIT_TIMESTAMP()
              )`,
        params: {
          tenantId: msg.tenantId,
          environment: msg.environment,
          monitorId: msg.monitorId || `monitor-${msg.messageId}`,
          sport: payload.sport,
          eventId: payload.eventId,
          gamePk: payload.gamePk,
          teamFocus: payload.teamFocus,
          label: payload.label,
          rules: payload.rules,
          notificationTargets: payload.notificationTargets,
          commandVersion: payload.commandVersion,
          requestedBy: payload.requestedBy
        }
      });
    });
  }
);

// G. Live Monitor Tick
pubsubWorkersRouter.post(
  "/internal/pubsub/v1/live-monitor-tick",
  verifyPubsubOidc,
  async (req: Request, res: Response) => {
    await handlePubsubMessage(req, res, "live.monitor.tick.v1", async (txn, msg) => {
      const payload = msg.payload as any;
      await txn.run({
        sql: `INSERT INTO MlbLiveMonitorEvaluations (
                TenantId, Environment, MonitorId, EvaluationBucket, EventId, GamePk, 
                Status, MessageId, CreatedAt
              ) VALUES (
                @tenantId, @environment, @monitorId, @evaluationTime, @eventId, @gamePk, 
                'EVALUATED', @messageId, PENDING_COMMIT_TIMESTAMP()
              )`,
        params: {
          tenantId: msg.tenantId,
          environment: msg.environment,
          monitorId: msg.monitorId!,
          evaluationTime: new Date(payload.evaluationTime),
          eventId: payload.eventId,
          gamePk: payload.gamePk,
          messageId: msg.messageId
        }
      });
    });
  }
);

// H. Live State Committed
pubsubWorkersRouter.post(
  "/internal/pubsub/v1/live-state-committed",
  verifyPubsubOidc,
  async (req: Request, res: Response) => {
    await handlePubsubMessage(req, res, "live.state.committed.v1", async (txn, msg) => {
      const payload = msg.payload as any;
      await txn.run({
        sql: `INSERT OR UPDATE MlbLiveGameStateSnapshots (
                TenantId, Environment, GamePk, ObservedAt, EventId, 
                SourceSetHash, GameStatus, Inning, Score, HomeTeam, AwayTeam, 
                SignalsJson, ReceiptsJson, CreatedAt
              ) VALUES (
                @tenantId, @environment, @gamePk, @observedAt, @eventId, 
                @sourceSetHash, @gameStatus, @inning, @score, @homeTeam, @awayTeam, 
                TO_JSON(@signals), TO_JSON(@receipts), PENDING_COMMIT_TIMESTAMP()
              )`,
        params: {
          tenantId: msg.tenantId,
          environment: msg.environment,
          gamePk: payload.gamePk,
          observedAt: new Date(payload.observedAt),
          eventId: payload.eventId,
          sourceSetHash: payload.sourceSetHash || null,
          gameStatus: payload.gameStatus,
          inning: payload.inning,
          score: payload.score,
          homeTeam: payload.homeTeam,
          awayTeam: payload.awayTeam,
          signals: payload.signals,
          receipts: payload.receipts
        }
      });
    });
  }
);

// I. Live Monitor Alert
pubsubWorkersRouter.post(
  "/internal/pubsub/v1/live-monitor-alert",
  verifyPubsubOidc,
  async (req: Request, res: Response) => {
    await handlePubsubMessage(req, res, "live.monitor.alert.v1", async (txn, msg) => {
      const payload = msg.payload as any;
      const event = payload.event;
      await txn.run({
        sql: `INSERT INTO MlbLiveMonitorAlerts (
                TenantId, Environment, MonitorId, AlertId, TriggeredAt, 
                Severity, EventId, GamePk, Headline, SignalsJson, ReceiptsJson, 
                DedupeBucket, CreatedAt
              ) VALUES (
                @tenantId, @environment, @monitorId, @alertId, @triggeredAt, 
                @severity, @eventId, @gamePk, @headline, TO_JSON(@signals), TO_JSON(@receipts), 
                @dedupeBucket, PENDING_COMMIT_TIMESTAMP()
              )`,
        params: {
          tenantId: msg.tenantId,
          environment: msg.environment,
          monitorId: msg.monitorId!,
          alertId: payload.alertId,
          triggeredAt: new Date(payload.triggeredAt),
          severity: payload.severity,
          eventId: event.eventId,
          gamePk: event.gamePk,
          headline: payload.headline,
          signals: payload.signals,
          receipts: payload.receipts,
          dedupeBucket: payload.dedupeBucket ? new Date(payload.dedupeBucket) : null
        }
      });
    });
  }
);

// J. Dead-Letter Queue (DLQ) Handler
pubsubWorkersRouter.post(
  "/internal/pubsub/v1/pipeline-dlq",
  verifyPubsubOidc,
  async (req: Request, res: Response) => {
    const startMs = Date.now();
    try {
      const rawBody = req.body;
      const pushMessage = rawBody.message;
      const decodedData = Buffer.from(pushMessage.data, "base64").toString("utf8");
      
      let parsedJson: any;
      try {
        parsedJson = JSON.parse(decodedData);
      } catch {
        parsedJson = { rawString: decodedData };
      }

      const tenantId = parsedJson.tenantId || "unknown";
      const environment = parsedJson.environment || "unknown";
      const messageId = pushMessage.messageId || `dlq-${Date.now()}`;
      const topicName = rawBody.subscription || "unknown-subscription";

      await edgeDb.runTransactionAsync(async (transaction) => {
        await transaction.run({
          sql: `INSERT INTO MlbPipelineDeadLetters (
                  TenantId, Environment, MessageId, DeadLetteredAt, 
                  TopicName, ErrorMessage, PayloadJson, CreatedAt
                ) VALUES (
                  @tenantId, @environment, @messageId, PENDING_COMMIT_TIMESTAMP(), 
                  @topicName, @errorMessage, TO_JSON(@payload), PENDING_COMMIT_TIMESTAMP()
                )`,
          params: {
            tenantId,
            environment,
            messageId,
            topicName,
            errorMessage: "Message exceeded max delivery attempts and was dead-lettered.",
            payload: parsedJson
          }
        });
      });

      logger.info({ msg: "DLQ message durably logged in Spanner", messageId, durationMs: Date.now() - startMs });
      return res.status(204).end();
    } catch (err: any) {
      logger.error({ msg: "Failed to log DLQ message", error: err.message });
      return res.status(500).json({ error: err.message });
    }
  }
);
