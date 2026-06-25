import fs from 'fs';

const filePath = 'src/tools/odds_admin.tools.ts';
let content = fs.readFileSync(filePath, 'utf8');

// Add import
const importStatement = "import { runIngestion } from '../workers/odds-ingestor.js';\n";
if (!content.includes('runIngestion')) {
  content = content.replace("import { promisify } from 'util';", "import { promisify } from 'util';\n" + importStatement);
}

// Redact secret helper
const redactHelper = `
function redactSecret(obj: any): any {
  if (!obj) return obj;
  if (typeof obj === 'string') {
    return obj.replace(/(?:apiKey=|key=|-H ['"]?x-api-key: )([a-zA-Z0-9_-]{10,})/gi, (match, p1) => match.replace(p1, '[REDACTED]'));
  }
  if (typeof obj === 'object') {
    if (Array.isArray(obj)) return obj.map(redactSecret);
    const newObj: any = {};
    for (const key of Object.keys(obj)) {
      if (key.toLowerCase().includes('apikey') || key.toLowerCase().includes('secret')) {
        newObj[key] = '[REDACTED]';
      } else {
        newObj[key] = redactSecret(obj[key]);
      }
    }
    return newObj;
  }
  return obj;
}
`;
if (!content.includes('redactSecret')) {
  content = content.replace("export const oddsAdminTools", redactHelper + "\nexport const oddsAdminTools");
}

const newTools = `
  {
    definition: {
      name: "audit_odds_ingestor",
      description: "Audits the recent odds ingestion runs, checking status, quota usage, and ServiceBindings. Returns a summary of the ingestion health.",
      schema: z.object({
        limit: z.number().optional().default(5).describe("Number of recent runs to fetch")
      })
    },
    handler: async (args, context) => {
      try {
        const db = getDatabase();
        
        // Fetch recent runs
        const [runs] = await db.run({
          sql: \`SELECT RunId, Status, EventCount, SnapshotCount, ErrorMessage, RequestedAt, CompletedAt 
                FROM OddsIngestionRuns 
                ORDER BY RequestedAt DESC LIMIT @limit\`,
          params: { limit: args.limit }
        });
        
        // Fetch service bindings
        const [bindings] = await db.run({
          sql: \`SELECT BindingId, Status, LiveTestPassed, LiveDataRowCount, UpdatedAt 
                FROM ServiceBindings WHERE BindingId = 'bind:odds-api-external'\`
        });

        // Fetch quota info
        const [quotas] = await db.run({
          sql: \`SELECT Provider, RequestCount, QuotaLimit, ResetsAt, PollingMode 
                FROM OddsApiQuota WHERE Provider = 'odds_api_external'\`
        });

        return redactSecret({
          success: true,
          recentRuns: runs.map((r: any) => r.toJSON()),
          serviceBindings: bindings.map((r: any) => r.toJSON()),
          quotaState: quotas.map((r: any) => r.toJSON())
        });
      } catch (err: any) {
        return redactSecret({ error: \`Audit failed: \${err.message}\` });
      }
    }
  },
  {
    definition: {
      name: "run_odds_ingestor_once",
      description: "Manually triggers the odds ingestion worker in one-shot or dry-run mode. Requires approval for one-shot mode.",
      schema: z.object({
        sport: z.string().default("baseball_mlb").describe("Sport key (e.g. baseball_mlb)"),
        markets: z.string().default("h2h,spreads,totals").describe("Comma-separated markets"),
        regions: z.string().default("us").describe("Regions"),
        mode: z.enum(["one_shot", "dry_run"]).default("dry_run").describe("Execution mode")
      })
    },
    handler: async (args, context) => {
      if (args.mode === 'one_shot' && context.connectionId) {
        const approvalId = \`approve_run_\${Math.random().toString(36).substring(2, 11)}\`;
        sseManager.sendEvent(context.connectionId, 'tool_approval_required', {
          approvalId,
          tool: "run_odds_ingestor_once",
          args
        });
        const approved = await waitForApproval(approvalId, "run_odds_ingestor_once", args);
        if (!approved) {
          return { error: "Permission Denied: User did not approve a live odds ingestion run." };
        }
      }

      try {
        const startTime = Date.now();
        await runIngestion({
          sport: args.sport,
          markets: args.markets,
          regions: args.regions,
          scheduledAt: new Date()
        }, args.mode as any);
        const duration = Date.now() - startTime;

        return redactSecret({
          success: true,
          message: \`Odds ingestion (\${args.mode}) completed successfully in \${duration}ms.\`
        });
      } catch (err: any) {
        return redactSecret({ error: \`Ingestion run failed: \${err.message}\` });
      }
    }
  },
`;

// Insert the new tools inside the oddsAdminTools array
content = content.replace("export const oddsAdminTools: RegisteredTool<any>[] = [", "export const oddsAdminTools: RegisteredTool<any>[] = [\n" + newTools);

fs.writeFileSync(filePath, content);
console.log("Added new tools and redaction to odds_admin.tools.ts");
