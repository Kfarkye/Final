import { Spanner } from '@google-cloud/spanner';
import { env } from '../src/config/env';

async function main() {
  const spanner = new Spanner({ projectId: env.GCP_PROJECT });
  const db = spanner.instance(env.SPANNER_INSTANCE_ID || 'clearspace').database(env.SPANNER_DATABASE_ID || 'sports-mlb-db');

  console.log('═══ 1. EXPIRED ODDS CHECK ═══');
  const [expiredRows] = await db.run({
    sql: `SELECT 
            COUNT(*) AS total_active,
            COUNTIF(ValidUntil < CURRENT_TIMESTAMP()) AS expired_active,
            COUNTIF(ValidUntil >= CURRENT_TIMESTAMP()) AS valid_active
          FROM CurrentOdds WHERE IsActive = TRUE`,
  });
  for (const r of expiredRows) {
    const j = r.toJSON();
    console.log(`  Total active: ${j.total_active}`);
    console.log(`  Expired but active: ${j.expired_active}`);
    console.log(`  Valid active: ${j.valid_active}`);
  }

  console.log('\n═══ 2. FEED HEALTH CHECK ═══');
  const [healthRows] = await db.run({
    sql: `SELECT FeedId, IsHealthy, LastCheckAt, LastSuccessAt, RowsWrittenL5Min, RowsWrittenL1Hour, LastIngestRunId, ComputedAt 
          FROM DataFeedHealth WHERE FeedId = 'odds_live'`,
  });
  if (healthRows.length === 0) {
    console.log('  NO ROW FOUND for odds_live');
  } else {
    for (const r of healthRows) {
      const j = r.toJSON();
      console.log(`  IsHealthy: ${j.IsHealthy}`);
      console.log(`  LastCheckAt: ${j.LastCheckAt?.value || j.LastCheckAt}`);
      console.log(`  LastSuccessAt: ${j.LastSuccessAt?.value || j.LastSuccessAt}`);
      console.log(`  RowsWrittenL5Min: ${j.RowsWrittenL5Min}`);
      console.log(`  RowsWrittenL1Hour: ${j.RowsWrittenL1Hour}`);
      console.log(`  LastIngestRunId: ${j.LastIngestRunId}`);
      console.log(`  ComputedAt: ${j.ComputedAt?.value || j.ComputedAt}`);
    }
  }

  console.log('\n═══ 3. FEED HEALTH LOG CHECK ═══');
  const [logRows] = await db.run({
    sql: `SELECT FeedId, CheckAt, IsHealthy, RowsWrittenL5Min FROM DataFeedHealthLog WHERE FeedId = 'odds_live' ORDER BY CheckAt DESC LIMIT 5`,
  });
  console.log(`  Rows found: ${logRows.length}`);
  for (const r of logRows) {
    const j = r.toJSON();
    console.log(`    ${j.CheckAt?.value || j.CheckAt} | healthy=${j.IsHealthy} | L5Min=${j.RowsWrittenL5Min}`);
  }

  console.log('\n═══ 4. LATEST INGEST RUNS ═══');
  const [runRows] = await db.run({
    sql: `SELECT RunId, Status, EventCount, SnapshotCount, CommittedAt, ErrorMessage 
          FROM OddsIngestionRuns ORDER BY CommittedAt DESC LIMIT 5`,
  });
  for (const r of runRows) {
    const j = r.toJSON();
    console.log(`  ${j.CommittedAt?.value || j.CommittedAt} | ${j.Status} | events=${j.EventCount} snapshots=${j.SnapshotCount} ${j.ErrorMessage ? '| ERR: ' + j.ErrorMessage : ''}`);
  }

  console.log('\n═══ 5. QUOTA CHECK ═══');
  const [quotaRows] = await db.run({
    sql: `SELECT Provider, QuotaRemaining, QuotaUsed, LastRequestCost, PollingMode, UpdatedAt FROM OddsApiQuota`,
  });
  for (const r of quotaRows) {
    const j = r.toJSON();
    console.log(`  ${j.Provider}: remaining=${j.QuotaRemaining} used=${j.QuotaUsed} lastCost=${j.LastRequestCost} mode=${j.PollingMode} updated=${j.UpdatedAt?.value || j.UpdatedAt}`);
  }

  await db.close();
}
main().catch(console.error);
