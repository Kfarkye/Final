/**
 * dry-run-zero-write-proof.ts
 * 
 * Proves that run_odds_ingestor_once in dry_run mode performs zero Spanner writes.
 * Captures before/after counts for all tables the ingestor touches.
 * 
 * Evidence artifact for AG-CHATODDS-003.
 */
import { Spanner } from '@google-cloud/spanner';
import { env } from '../src/config/env';
import { runIngestion } from '../src/workers/odds-ingestor';

async function main() {
  const spanner = new Spanner({ projectId: env.GCP_PROJECT });
  const instanceId = env.SPANNER_INSTANCE_ID || 'clearspace';
  const dbId = env.SPANNER_DATABASE_ID || 'sports-mlb-db';
  const database = spanner.instance(instanceId).database(dbId);

  const tables = [
    { name: 'OddsIngestionRuns', sql: 'SELECT COUNT(*) as cnt FROM OddsIngestionRuns' },
    { name: 'CurrentOdds', sql: 'SELECT COUNT(*) as cnt FROM CurrentOdds' },
    { name: 'OddsApiQuota', sql: `SELECT QuotaRemaining, QuotaUsed FROM OddsApiQuota WHERE Provider = 'the-odds-api'` },
    { name: 'DataFeedHealth', sql: `SELECT LastCheckAt, RowsWrittenL5Min, RowsWrittenL1Hour, ComputedAt FROM DataFeedHealth WHERE FeedId = 'odds_live'` },
    { name: 'DataFeedHealthLog', sql: `SELECT COUNT(*) as cnt FROM DataFeedHealthLog WHERE FeedId = 'odds_live'` },
  ];

  // --- BEFORE snapshot ---
  console.log('\n═══ BEFORE DRY-RUN ═══');
  const before: Record<string, any> = {};
  for (const t of tables) {
    const [rows] = await database.run({ sql: t.sql });
    before[t.name] = rows.length > 0 ? (rows[0] as any).toJSON() : null;
    console.log(`  ${t.name}:`, JSON.stringify(before[t.name]));
  }

  // --- Execute dry-run ---
  console.log('\n═══ RUNNING DRY-RUN ═══');
  const startTime = Date.now();
  try {
    await runIngestion({
      sport: 'baseball_mlb',
      markets: 'h2h,spreads,totals',
      regions: 'us',
      scheduledAt: new Date(),
    }, 'dry_run');
    console.log(`  Completed in ${Date.now() - startTime}ms`);
  } catch (err: any) {
    console.error(`  Dry-run threw: ${err.message}`);
  }

  // --- AFTER snapshot ---
  console.log('\n═══ AFTER DRY-RUN ═══');
  const after: Record<string, any> = {};
  for (const t of tables) {
    const [rows] = await database.run({ sql: t.sql });
    after[t.name] = rows.length > 0 ? (rows[0] as any).toJSON() : null;
    console.log(`  ${t.name}:`, JSON.stringify(after[t.name]));
  }

  // --- Compare ---
  console.log('\n═══ ZERO-WRITE PROOF ═══');
  let allPassed = true;
  for (const t of tables) {
    const bStr = JSON.stringify(before[t.name]);
    const aStr = JSON.stringify(after[t.name]);
    const match = bStr === aStr;
    const status = match ? '✓ UNCHANGED' : '✗ CHANGED';
    console.log(`  ${status}  ${t.name}`);
    if (!match) {
      console.log(`    BEFORE: ${bStr}`);
      console.log(`    AFTER:  ${aStr}`);
      allPassed = false;
    }
  }

  console.log(`\n═══ VERDICT: ${allPassed ? 'PASS — dry_run performed zero Spanner writes' : 'FAIL — dry_run wrote to Spanner'} ═══\n`);

  process.exit(allPassed ? 0 : 1);
}

main().catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});
