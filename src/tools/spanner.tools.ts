import { z } from 'zod';
import { RegisteredTool } from './types';
import { sseManager } from '../../lib/sse/sse-manager';
import { waitForApproval } from '../utils/approval';
import { Spanner } from '@google-cloud/spanner';
import { env } from '../config/env';

// Initialize Spanner client
const spanner = new Spanner({ projectId: env.SPANNER_PROJECT_ID });

// Helper: wrap database calls with a timeout to prevent silent hangs
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number = 10000): Promise<T> {
  let timeoutId: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Spanner request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
}

export const spannerTools: RegisteredTool<any>[] = [
  {
    definition: {
      name: "list_instances",
      description: "Lists all Cloud Spanner instances in the active project. Known instances: 'clearspace' (sports data). Start here if you don't know which instance to target.",
      schema: z.object({})
    },
    handler: async () => {
      const [instances] = await withTimeout(spanner.getInstances());
      const plainInstances = instances.map((inst: any) => ({
        id: inst.id,
        formattedName: inst.formattedName,
        nodeCount: inst.nodeCount,
        state: inst.state
      }));
      return { instances: plainInstances };
    }
  },
  {
    definition: {
      name: "list_databases",
      description: "Lists all databases inside a specific Spanner instance. For sports data, use instanceId='clearspace'. Known databases: 'sports-mlb-db' (MLB entities, governance contracts, odds).",
      schema: z.object({
        instanceId: z.string().min(1, "Instance ID is required")
      })
    },
    handler: async (args) => {
      const instance = spanner.instance(args.instanceId);
      const [databases] = await withTimeout(instance.getDatabases());
      const plainDatabases = databases.map((db: any) => ({
        id: db.id,
        formattedName: db.formattedName,
        state: db.state
      }));
      return { instanceId: args.instanceId, databases: plainDatabases };
    }
  },
  {
    definition: {
      name: "get_database_ddl",
      description: "Retrieves the full DDL (schema) for a database. WARNING: returns ALL tables — prefer describe_spanner_table for a single table. Use this only when you need the complete schema overview.",
      schema: z.object({
        instanceId: z.string().min(1, "Instance ID is required"),
        databaseId: z.string().min(1, "Database ID is required")
      })
    },
    handler: async (args) => {
      const database = spanner.instance(args.instanceId).database(args.databaseId);
      const [ddlStatements] = await withTimeout(database.getSchema());
      return { instanceId: args.instanceId, databaseId: args.databaseId, ddl: ddlStatements };
    }
  },
  {
    definition: {
      name: "execute_sql",
      description: "Executes a SQL query (SELECT) or DML (INSERT/UPDATE/DELETE) against Spanner. DML requires user approval. CANNOT run DDL — use execute_ddl instead. WORKFLOW: Always call describe_spanner_table FIRST to get exact column names before writing queries — this prevents hallucinated column references. Default: instanceId='clearspace', databaseId='sports-mlb-db'. For large DML operations (mass UPDATE/DELETE), increase timeoutMs up to 120000 (2 min).",
      schema: z.object({
        instanceId: z.string().min(1, "Instance ID is required"),
        databaseId: z.string().min(1, "Database ID is required"),
        sql: z.string().min(1, "SQL statement is required"),
        timeoutMs: z.number().int().min(1000).max(120000).optional()
          .describe("Timeout in ms. Defaults to 10000 for SELECT, 30000 for DML. Set up to 120000 for large maintenance DML.")
      })
    },
    handler: async (args, context) => {
      const sql = args.sql.trim();
      const isDDL = /^\s*(create|alter|drop)\s+(table|index|view|database|change\s+stream)\b/i.test(sql);
      const isWriteDML = /^\s*(insert|update|delete|merge)\b/i.test(sql);

      // ── DDL rejection: fail loud, not silent ──────────────────────
      if (isDDL) {
        return {
          error: "DDL statements (CREATE/ALTER/DROP TABLE) cannot be executed through execute_sql. " +
            "The Spanner Query/DML API does not support DDL. Use the 'execute_ddl' tool instead, " +
            "which calls the Database Admin API (UpdateDatabaseDdl RPC) and properly awaits the long-running operation."
        };
      }

      if (isWriteDML && context.connectionId) {
        const approvalId = `approve_${Math.random().toString(36).substring(2, 11)}`;
        sseManager.sendEvent(context.connectionId, 'tool_approval_required', { approvalId, tool: "execute_sql", args });
        const approved = await waitForApproval(approvalId, "execute_sql", args);
        if (!approved) {
          return { error: "Permission Denied: User did not approve execution of execute_sql write operation." };
        }
      }

      const database = spanner.instance(args.instanceId).database(args.databaseId);

      if (isWriteDML) {
        const dmlTimeout = args.timeoutMs || 30000; // 30s default for DML
        let rowCount = 0;
        await withTimeout(database.runTransactionAsync(async (transaction) => {
          const [count] = await transaction.runUpdate({ sql });
          await transaction.commit();
          rowCount = count;
        }), dmlTimeout);
        return { success: true, statement: "DML Executed successfully", rowCount, timeoutMs: dmlTimeout };
      } else {
        const readTimeout = args.timeoutMs || 10000; // 10s default for reads
        const [rows] = await withTimeout(database.run({ sql }), readTimeout);
        const plainRows = rows.map((row: any) => row.toJSON ? row.toJSON() : row);
        return { instanceId: args.instanceId, databaseId: args.databaseId, sql, rows: plainRows };
      }
    }
  },

  // ── Describe Single Table (DDL-parsed) ────────────────────────────
  {
    definition: {
      name: "describe_spanner_table",
      description:
        "Get the schema for a SINGLE Spanner table: columns (name, type, nullable), " +
        "primary key, and indexes. ALWAYS call this BEFORE execute_sql to learn the real column names — " +
        "this eliminates hallucinated column references. Far more efficient than get_database_ddl. " +
        "Default: instanceId='clearspace', databaseId='sports-mlb-db'. " +
        "Key tables: SportsGovernanceContracts, SportsGovernanceContractVersions, Entities, OddsSnapshots.",
      schema: z.object({
        instanceId: z.string().min(1, "Instance ID is required"),
        databaseId: z.string().min(1, "Database ID is required"),
        tableName: z.string().min(1, "Table name is required")
      })
    },
    handler: async (args) => {
      const database = spanner.instance(args.instanceId).database(args.databaseId);
      const [ddlStatements] = await withTimeout(database.getSchema());

      const tableName = args.tableName;
      const tableRegex = new RegExp(
        `CREATE TABLE\\s+${tableName}\\s*\\(([\\s\\S]*?)\\)\\s*PRIMARY KEY\\s*\\(([^)]+)\\)`,
        "i"
      );

      let tableDefinition: string | null = null;
      let primaryKey: string | null = null;
      const indexes: { name: string; columns: string; unique: boolean; storing?: string }[] = [];

      for (const stmt of ddlStatements) {
        const tableMatch = stmt.match(tableRegex);
        if (tableMatch) {
          tableDefinition = tableMatch[1];
          primaryKey = tableMatch[2].trim();
        }

        // Collect indexes for this table
        const indexRegex = new RegExp(
          `CREATE\\s+(UNIQUE\\s+)?(?:NULL_FILTERED\\s+)?INDEX\\s+(\\w+)\\s+ON\\s+${tableName}\\s*\\(([^)]+)\\)(?:\\s+STORING\\s*\\(([^)]+)\\))?`,
          "i"
        );
        const indexMatch = stmt.match(indexRegex);
        if (indexMatch) {
          indexes.push({
            name: indexMatch[2],
            columns: indexMatch[3].trim(),
            unique: !!indexMatch[1],
            storing: indexMatch[4]?.trim() || undefined
          });
        }
      }

      if (!tableDefinition) {
        return { error: `Table '${tableName}' not found in database '${args.databaseId}'` };
      }

      // Parse columns
      const columns = tableDefinition
        .split(",\n")
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .map(line => {
          const parts = line.match(/^(\w+)\s+(.+?)(\s+NOT NULL)?$/i);
          if (!parts) return { raw: line };
          return {
            name: parts[1],
            type: parts[2].trim(),
            nullable: !parts[3]
          };
        });

      return {
        table: tableName,
        database: args.databaseId,
        instance: args.instanceId,
        columnCount: columns.length,
        columns,
        primaryKey,
        indexCount: indexes.length,
        indexes
      };
    }
  }
];
