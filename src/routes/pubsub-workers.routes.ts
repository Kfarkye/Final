import { Router, Request, Response } from "express";
import { logger } from "../utils/logger.js";
import { decodePubsubPushMessage } from "../contracts/mlbPubsubPipeline.v1.2.js";

export const pubsubWorkersRouter = Router();

// Helper to handle and validate Pub/Sub push messages
function createPubsubHandler(expectedType: string) {
  return async (req: Request, res: Response) => {
    try {
      logger.info({ msg: `Received Pub/Sub push message for ${expectedType}` });

      // 1. Decode the Pub/Sub push envelope
      const decodedMessage = decodePubsubPushMessage(req.body);
      
      // 2. Validate the message type matches the endpoint
      if (decodedMessage.messageType !== expectedType) {
        logger.error({
          msg: "Pub/Sub message type mismatch",
          expected: expectedType,
          received: decodedMessage.messageType
        });
        res.status(400).json({ error: `Expected message type ${expectedType}` });
        return;
      }

      logger.info({
        msg: "Pub/Sub message successfully decoded and validated",
        messageId: decodedMessage.messageId,
        messageType: decodedMessage.messageType,
        tenantId: decodedMessage.tenantId,
        environment: decodedMessage.environment
      });

      // Acknowledge receipt
      res.status(200).json({
        success: true,
        messageId: decodedMessage.messageId,
        message: "Message received and validated."
      });
    } catch (err: any) {
      logger.error({
        msg: "Failed to process Pub/Sub push message",
        error: err.message,
        stack: err.stack
      });
      res.status(200).json({ error: err.message });
    }
  };
}

// Register endpoints for all v1.2.0 pipeline messages
pubsubWorkersRouter.post("/internal/pubsub/odds-backfill-command", createPubsubHandler("odds.backfill.command.v1"));
pubsubWorkersRouter.post("/internal/pubsub/odds-backfill-snapshot-requested", createPubsubHandler("odds.backfill.snapshot.requested.v1"));
pubsubWorkersRouter.post("/internal/pubsub/odds-backfill-snapshot-completed", createPubsubHandler("odds.backfill.snapshot.completed.v1"));
pubsubWorkersRouter.post("/internal/pubsub/odds-backfill-snapshot-failed", createPubsubHandler("odds.backfill.snapshot.failed.v1"));
pubsubWorkersRouter.post("/internal/pubsub/odds-backfill-run-completed", createPubsubHandler("odds.backfill.run.completed.v1"));
pubsubWorkersRouter.post("/internal/pubsub/live-monitor-command", createPubsubHandler("live.monitor.command.v1"));
pubsubWorkersRouter.post("/internal/pubsub/live-monitor-tick", createPubsubHandler("live.monitor.tick.v1"));
pubsubWorkersRouter.post("/internal/pubsub/live-state-committed", createPubsubHandler("live.state.committed.v1"));
pubsubWorkersRouter.post("/internal/pubsub/live-monitor-alert", createPubsubHandler("live.monitor.alert.v1"));
