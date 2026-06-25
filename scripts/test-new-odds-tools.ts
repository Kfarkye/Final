import { oddsAdminTools } from '../src/tools/odds_admin.tools';
import { env } from '../src/config/env';

async function test() {
  const auditTool = oddsAdminTools.find(t => t.definition.name === 'audit_odds_ingestor')!;
  const runTool = oddsAdminTools.find(t => t.definition.name === 'run_odds_ingestor_once')!;
  
  console.log("Testing audit_odds_ingestor:");
  const auditResult = await auditTool.handler({ limit: 2 }, {});
  console.log(JSON.stringify(auditResult, null, 2));

  console.log("\nTesting run_odds_ingestor_once (dry_run):");
  const runResult = await runTool.handler({
    sport: 'baseball_mlb',
    markets: 'h2h,spreads,totals',
    regions: 'us',
    mode: 'dry_run'
  }, {});
  console.log(JSON.stringify(runResult, null, 2));
}

test().catch(console.error).finally(() => process.exit(0));
