import { z } from 'zod';
import { RegisteredTool } from './types';
import { sseManager } from '../../lib/sse/sse-manager';
import { waitForApproval } from '../utils/approval';
import { Spanner } from '@google-cloud/spanner';
import { env } from '../config/env';
import { logger } from '../utils/logger';

// Initialize Spanner client
const spanner = new Spanner({ projectId: env.SPANNER_PROJECT_ID });

// ── Schema Cache ─────────────────────────────────────────────────────────────
// Caches parsed DDL for all tables with a 10-minute TTL.
// Used by: get_full_schema tool (B) and system prompt injection (A).

const SCHEMA_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

interface TableSummary {
  name: string;
  columns: { name: string; type: string; nullable: boolean }[];
  primaryKey: string;
  indexes: { name: string; columns: string; unique: boolean }[];
}

interface CachedSchema {
  tables: TableSummary[];
  fetchedAt: number;
  tableCount: number;
}

const schemaCache = new Map<string, CachedSchema>();

function parseDdlToSummaries(ddlStatements: string[]): TableSummary[] {
  const tables: TableSummary[] = [];
  const tableRegex = /CREATE TABLE\s+(\w+)\s*\(([\s\S]*?)\)\s*PRIMARY KEY\s*\(([^)]+)\)/gi;

  for (const stmt of ddlStatements) {
    const match = /CREATE TABLE\s+(\w+)\s*\(([\s\S]*?)\)\s*PRIMARY KEY\s*\(([^)]+)\)/i.exec(stmt);
    if (match) {
      const [, name, colBlock, pk] = match;
      const columns = colBlock
        .split(',\n')
        .map(l => l.trim())
        .filter(l => l.length > 0 && !l.startsWith(')'))
        .map(line => {
          const parts = line.match(/^(\w+)\s+(.+?)(\s+NOT NULL)?$/i);
          if (!parts) return { name: line.split(' ')[0], type: 'UNKNOWN', nullable: true };
          return { name: parts[1], type: parts[2].replace(/\s+OPTIONS\s*\(.*\)/, '').trim(), nullable: !parts[3] };
        });

      tables.push({ name, columns, primaryKey: pk.trim(), indexes: [] });
    }
  }

  // Parse indexes and attach to tables
  for (const stmt of ddlStatements) {
    const idxMatch = /CREATE\s+(UNIQUE\s+)?(?:NULL_FILTERED\s+)?INDEX\s+(\w+)\s+ON\s+(\w+)\s*\(([^)]+)\)/i.exec(stmt);
    if (idxMatch) {
      const table = tables.find(t => t.name === idxMatch[3]);
      if (table) {
        table.indexes.push({
          name: idxMatch[2],
          columns: idxMatch[4].trim(),
          unique: !!idxMatch[1],
        });
      }
    }
  }

  return tables;
}

async function getOrFetchSchema(instanceId: string, databaseId: string): Promise<CachedSchema> {
  const key = `${instanceId}/${databaseId}`;
  const cached = schemaCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < SCHEMA_CACHE_TTL_MS) {
    return cached;
  }

  const database = spanner.instance(instanceId).database(databaseId);
  const [ddlStatements] = await withTimeout(database.getSchema(), 15000);
  const tables = parseDdlToSummaries(ddlStatements);

  const entry: CachedSchema = { tables, fetchedAt: Date.now(), tableCount: tables.length };
  schemaCache.set(key, entry);
  logger.info({ msg: 'Schema cache refreshed', key, tableCount: tables.length });
  return entry;
}

/**
 * Returns a compact schema snapshot string for system prompt injection.
 * Format: TableName(Col1 TYPE, Col2 TYPE, ...) PK(col1, col2)
 */
export async function getSchemaSnapshot(): Promise<string> {
  try {
    const mlb = await getOrFetchSchema('clearspace', 'sports-mlb-db');
    const entities = await getOrFetchSchema('clearspace', 'sports-entities-db');

    const formatTable = (t: TableSummary) => {
      const cols = t.columns.map(c => `${c.name} ${c.type}`).join(', ');
      return `  ${t.name}(${cols}) PK(${t.primaryKey})`;
    };

    const lines = [
      'DATABASE: clearspace/sports-mlb-db',
      ...mlb.tables.map(formatTable),
      '',
      'DATABASE: clearspace/sports-entities-db',
      ...entities.tables.map(formatTable),
    ];

    return lines.join('\n');
  } catch (err: any) {
    logger.error({ msg: 'Failed to build schema snapshot', err: err.message });
    return '(Schema snapshot unavailable — use describe_spanner_table or get_full_schema)';
  }
}

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
  },

  // ── Full Schema (cached) ──────────────────────────────────────────────
  {
    definition: {
      name: "get_full_schema",
      description:
        "Returns ALL table schemas for a Spanner database in one call. " +
        "Results are cached for 10 minutes. Much more efficient than calling " +
        "describe_spanner_table multiple times. Returns: table name, columns " +
        "(name + type + nullable), primary key, and indexes for every table. " +
        "Default: instanceId='clearspace', databaseId='sports-mlb-db'.",
      schema: z.object({
        instanceId: z.string().default('clearspace').describe("Spanner instance ID"),
        databaseId: z.string().default('sports-mlb-db').describe("Database ID"),
      })
    },
    handler: async (args) => {
      const schema = await getOrFetchSchema(args.instanceId, args.databaseId);
      return {
        instanceId: args.instanceId,
        databaseId: args.databaseId,
        tableCount: schema.tableCount,
        cachedAt: new Date(schema.fetchedAt).toISOString(),
        tables: schema.tables.map(t => ({
          name: t.name,
          columns: t.columns,
          primaryKey: t.primaryKey,
          indexCount: t.indexes.length,
          indexes: t.indexes,
        })),
      };
    }
  }
];
