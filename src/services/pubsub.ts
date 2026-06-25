import { PubSub } from "@google-cloud/pubsub";
import { logger } from "../utils/logger";
import { env } from "../config/env";

const pubsub = new PubSub({ projectId: env.GCP_PROJECT_ID || 'reverie' });
const TOPIC_NAME = 'live-odds-ingest';

export async function publishRawOdds(payload: any) {
  try {
    const topic = pubsub.topic(TOPIC_NAME);
    const dataBuffer = Buffer.from(JSON.stringify(payload));
    const messageId = await topic.publishMessage({ data: dataBuffer });
    logger.info({ msg: "Published raw odds to Pub/Sub", messageId });
    return messageId;
  } catch (err: any) {
    logger.error({ msg: "Failed to publish raw odds", err: err.message });
    throw err;
  }
}
