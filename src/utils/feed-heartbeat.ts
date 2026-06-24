/**
 * feed-heartbeat.ts — DataFeedHealth heartbeat writer
 *
 * Called by ingest workers after each run to record success/failure
 * into the DataFeedHealth Spanner table. This is the ONLY writer —
 * the table was previously read-only with no heartbeat source.
 *
 * Also inserts a row into DataFeedHealthLog for audit history.
 *
 * Usage:
 *   import { recordFeedHeartbeat } from "../utils/feed-heartbeat";
 *
 *   await recordFeedHeartbeat({
 *     feedId: "odds_live",
 *     success: true,
 *     rowsWritten: 1166,
 *     runId: "abc123",
 *   });
 */

import { edgeDb } from "../db/spanner";
import { logger } from "./logger";

export interface FeedHeartbeatOpts {
  /** Feed identifier — must match a row in DataFeedHealth (e.g. "espn_scores", "pm_kalshi") */
  feedId: string;
  /** Whether the ingest run succeeded */
  success: boolean;
  /** Number of rows written/upserted in this run */
  rowsWritten: number;
  /** Unique run identifier for traceability */
  runId: string;
  /** Error message if the run failed */
  errorMessage?: string;
}

// Feed-specific defaults for auto-created DataFeedHealth rows
const FEED_DEFAULTS: Record<string, { expectedIntervalSec: number; maxStalenessBeforeAlarmSec: number; isGameWindow: boolean }> = {
  odds_live: { expectedIntervalSec: 60, maxStalenessBeforeAlarmSec: 180, isGameWindow: true },
};
const CONSERVATIVE_DEFAULTS = { expectedIntervalSec: 300, maxStalenessBeforeAlarmSec: 900, isGameWindow: true };

export async function recordFeedHeartbeat(opts: FeedHeartbeatOpts): Promise<void> {
  try {
    await edgeDb.runTransactionAsync(async (txn) => {
      // Attempt UPDATE first (existing row)
      const [updateCount] = await txn.runUpdate({
        sql: `UPDATE DataFeedHealth SET
          LastCheckAt = CURRENT_TIMESTAMP(),
          LastSuccessAt = CASE WHEN @success THEN CURRENT_TIMESTAMP() ELSE LastSuccessAt END,
          RowsWrittenL5Min =
            CASE
              WHEN LastCheckAt IS NULL
                OR LastCheckAt < TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 5 MINUTE)
              THEN @rowsWritten
              ELSE COALESCE(RowsWrittenL5Min, 0) + @rowsWritten
            END,
          RowsWrittenL1Hour =
            CASE
              WHEN LastCheckAt IS NULL
                OR LastCheckAt < TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 HOUR)
              THEN @rowsWritten
              ELSE COALESCE(RowsWrittenL1Hour, 0) + @rowsWritten
            END,
          IsHealthy = @success,
          ConsecutiveAlarms = CASE WHEN @success THEN 0 ELSE COALESCE(ConsecutiveAlarms, 0) + 1 END,
          AlarmFiredAt = CASE WHEN NOT @success THEN CURRENT_TIMESTAMP() ELSE AlarmFiredAt END,
          LastErrorMessage = @errorMessage,
          LastIngestRunId = @runId,
          ComputedAt = PENDING_COMMIT_TIMESTAMP()
        WHERE FeedId = @feedId`,
        params: {
          feedId: opts.feedId,
          success: opts.success,
          rowsWritten: opts.rowsWritten,
          errorMessage: opts.errorMessage || null,
          runId: opts.runId,
        },
        types: {
          feedId: { type: "string" },
          success: { type: "bool" },
          rowsWritten: { type: "int64" },
          errorMessage: { type: "string" },
          runId: { type: "string" },
        },
      });

      // If no row was updated, insert a new one with feed-specific defaults
      if (updateCount === 0) {
        const defaults = FEED_DEFAULTS[opts.feedId] || CONSERVATIVE_DEFAULTS;
        logger.info({ msg: "DataFeedHealth row missing, auto-creating", feedId: opts.feedId, defaults });
        await txn.runUpdate({
          sql: `INSERT INTO DataFeedHealth (
            FeedId, LastCheckAt, LastSuccessAt, RowsWrittenL5Min, RowsWrittenL1Hour,
            ExpectedIntervalSec, MaxStalenessBeforeAlarmSec, IsHealthy, IsGameWindow,
            ConsecutiveAlarms, LastErrorMessage, LastIngestRunId, ComputedAt
          ) VALUES (
            @feedId, CURRENT_TIMESTAMP(),
            CASE WHEN @success THEN CURRENT_TIMESTAMP() ELSE NULL END,
            @rowsWritten, @rowsWritten,
            @expectedIntervalSec, @maxStalenessBeforeAlarmSec, @success, @isGameWindow,
            CASE WHEN @success THEN 0 ELSE 1 END,
            @errorMessage, @runId, PENDING_COMMIT_TIMESTAMP()
          )`,
          params: {
            feedId: opts.feedId,
            success: opts.success,
            rowsWritten: opts.rowsWritten,
            errorMessage: opts.errorMessage || null,
            runId: opts.runId,
            expectedIntervalSec: defaults.expectedIntervalSec,
            maxStalenessBeforeAlarmSec: defaults.maxStalenessBeforeAlarmSec,
            isGameWindow: defaults.isGameWindow,
          },
          types: {
            feedId: { type: "string" },
            success: { type: "bool" },
            rowsWritten: { type: "int64" },
            errorMessage: { type: "string" },
            runId: { type: "string" },
            expectedIntervalSec: { type: "int64" },
            maxStalenessBeforeAlarmSec: { type: "int64" },
            isGameWindow: { type: "bool" },
          },
        });
      }

      // Insert audit log row into DataFeedHealthLog
      // Read the current state so log reflects computed values
      const [healthRows] = await txn.run({
        sql: `SELECT IsHealthy, IsGameWindow, RowsWrittenL5Min, RowsWrittenL1Hour FROM DataFeedHealth WHERE FeedId = @feedId`,
        params: { feedId: opts.feedId },
        types: { feedId: { type: "string" } },
      });
      const healthState = healthRows.length > 0 ? (healthRows[0] as any).toJSON() : null;

      await txn.runUpdate({
        sql: `INSERT INTO DataFeedHealthLog (
          FeedId, CheckAt, IsHealthy, IsGameWindow, RowsWrittenL5Min, RowsWrittenL1Hour, ErrorMessage
        ) VALUES (
          @feedId, CURRENT_TIMESTAMP(), @isHealthy, @isGameWindow, @rowsWrittenL5Min, @rowsWrittenL1Hour, @errorMessage
        )`,
        params: {
          feedId: opts.feedId,
          isHealthy: healthState?.IsHealthy ?? opts.success,
          isGameWindow: healthState?.IsGameWindow ?? true,
          rowsWrittenL5Min: healthState?.RowsWrittenL5Min ?? opts.rowsWritten,
          rowsWrittenL1Hour: healthState?.RowsWrittenL1Hour ?? opts.rowsWritten,
          errorMessage: opts.errorMessage || null,
        },
        types: {
          feedId: { type: "string" },
          isHealthy: { type: "bool" },
          isGameWindow: { type: "bool" },
          rowsWrittenL5Min: { type: "int64" },
          rowsWrittenL1Hour: { type: "int64" },
          errorMessage: { type: "string" },
        },
      });

      await txn.commit();
    });

    logger.info({
      msg: "Feed heartbeat recorded",
      feedId: opts.feedId,
      success: opts.success,
      rowsWritten: opts.rowsWritten,
      runId: opts.runId,
    });
  } catch (err: any) {
    // Heartbeat failure must NOT crash the worker — log and move on
    logger.error({
      msg: "Feed heartbeat write failed",
      feedId: opts.feedId,
      err: err.message,
    });
  }
}
