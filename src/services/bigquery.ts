import { BigQuery } from "@google-cloud/bigquery";
import { logger } from "../utils/logger";
import { env } from "../config/env";

const bq = new BigQuery({ projectId: env.GCP_PROJECT_ID || 'reverie' });
const DATASET_ID = 'reverie_analytics';
const TABLE_ID = 'odds_audit_log';

export async function logOddsAudit(record: any) {
  try {
    const dataset = bq.dataset(DATASET_ID);
    const table = dataset.table(TABLE_ID);
    
    await table.insert(record);
    logger.info({ msg: "Audit log inserted into BigQuery", recordId: record.id });
  } catch (err: any) {
    logger.error({ msg: "BigQuery insert failed", err: err.message, details: err.errors });
  }
}
