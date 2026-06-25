// src/tools/spanner-admin.tools.ts
// Closes the Database Admin API gap — create_database, batch_write,
// generate_embeddings, backfill_embeddings, create_vector_index.
//
// execute_ddl lives in forge.tools.ts (already registered).
// These are the remaining tools the agent needs to operate end-to-end.

import { z } from 'zod';
import { RegisteredTool } from './types';
import { sseManager } from '../../lib/sse/sse-manager';
import { waitForApproval } from '../utils/approval';
import { Spanner } from '@google-cloud/spanner';
import { env } from '../config/env';
import { logger } from '../utils/logger';

const spanner = new Spanner({ projectId: env.SPANNER_PROJECT_ID });

export const spannerAdminTools: RegisteredTool<any>[] = [

  // ═══════════════════════════════════════════════════════════════════
  // create_database — Create a new Spanner database on an instance
  // Uses Database Admin API: instance.createDatabase()
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "create_database",
      description: "Create a new Cloud Spanner database on a given instance. Optionally apply initial DDL statements (CREATE TABLE, etc.) at creation time. Returns the database ID when complete. This is a long-running operation that is awaited automatically.",
      schema: z.object({
        instanceId: z.string().min(1).describe("Spanner instance ID (e.g. 'clearspace')"),
        databaseId: z.string().min(1).describe("New database ID to create (e.g. 'sports-entities-db')"),
        ddlStatements: z.array(z.string()).optional().describe("Optional array of DDL statements to apply at creation time (CREATE TABLE, CREATE INDEX, etc.)"),
      })
    },
    handler: async (args, context) => {
      // Gate behind approval — this creates infrastructure
      if (context.connectionId) {
        const approvalId = `approve_${Math.random().toString(36).substring(2, 11)}`;
        sseManager.sendEvent(context.connectionId, 'tool_approval_required', {
          approvalId,
          tool: "create_database",
          args: { instanceId: args.instanceId, databaseId: args.databaseId, ddlCount: args.ddlStatements?.length || 0 }
        });
        const approved = await waitForApproval(approvalId, "create_database", args);
        if (!approved) {
          return { error: "Permission Denied: User did not approve database creation." };
        }
      }

      try {
        const instance = spanner.instance(args.instanceId);
        const [database, operation] = await instance.createDatabase(
          args.databaseId,
          args.ddlStatements || []
        );
        // Await the LRO — don't return until the database is actually ready
        await operation.promise();
        return {
          success: true,
          instanceId: args.instanceId,
          databaseId: args.databaseId,
          formattedName: database.formattedName_,
          ddlApplied: args.ddlStatements?.length || 0,
          message: `Database '${args.databaseId}' created on instance '${args.instanceId}'`,
        };
      } catch (err: any) {
        if (err.code === 6) {
          return { error: `Database '${args.databaseId}' already exists on instance '${args.instanceId}'.` };
        }
        return { error: `create_database failed: ${err.message}` };
      }
    }
  },

  // ═══════════════════════════════════════════════════════════════════
  // batch_write — Bulk-load rows via Spanner mutations (upsert)
  // Much faster than individual DML for large ingestion
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "batch_write",
      description: "Bulk-load rows into a Spanner table via upsert mutations. Much faster than individual INSERT DML for loading data at scale. Each row is a JSON object with column names as keys. Supports up to 500 rows per call (batched internally at 100). Requires human approval.",
      schema: z.object({
        instanceId: z.string().min(1).describe("Spanner instance ID"),
        databaseId: z.string().min(1).describe("Spanner database ID"),
        tableName: z.string().min(1).describe("Table to write to"),
        rows: z.array(z.record(z.any())).min(1).max(500).describe("Array of row objects — keys are column names, values are data. Use Spanner-compatible types."),
        useCommitTimestamp: z.array(z.string()).optional().describe("Column names that should use COMMIT_TIMESTAMP (e.g. ['CreatedAt', 'UpdatedAt'])"),
      })
    },
    handler: async (args, context) => {
      // Gate behind approval
      if (context.connectionId) {
        const approvalId = `approve_${Math.random().toString(36).substring(2, 11)}`;
        sseManager.sendEvent(context.connectionId, 'tool_approval_required', {
          approvalId,
          tool: "batch_write",
          args: { table: args.tableName, rowCount: args.rows.length, db: `${args.instanceId}/${args.databaseId}` }
        });
        const approved = await waitForApproval(approvalId, "batch_write", args);
        if (!approved) {
          return { error: "Permission Denied: User did not approve batch write." };
        }
      }

      const database = spanner.instance(args.instanceId).database(args.databaseId);
      const table = database.table(args.tableName);
      const commitTimestampCols = new Set(args.useCommitTimestamp || []);
      let totalInserted = 0;
      const errors: string[] = [];

      // Process in batches of 100
      const BATCH_SIZE = 100;
      for (let i = 0; i < args.rows.length; i += BATCH_SIZE) {
        const batch = args.rows.slice(i, i + BATCH_SIZE);

        // Apply COMMIT_TIMESTAMP and Spanner.float() wrappers
        const processedRows = batch.map((row: Record<string, any>) => {
          const processed: Record<string, any> = {};
          for (const [key, value] of Object.entries(row)) {
            if (commitTimestampCols.has(key)) {
              processed[key] = Spanner.COMMIT_TIMESTAMP;
            } else if (typeof value === 'number' && !Number.isInteger(value)) {
              processed[key] = Spanner.float(value);
            } else {
              processed[key] = value;
            }
          }
          return processed;
        });

        try {
          await table.upsert(processedRows);
          totalInserted += processedRows.length;
        } catch (err: any) {
          errors.push(`Batch at offset ${i} failed: ${err.message}`);
        }
      }

      return {
        success: errors.length === 0,
        tableName: args.tableName,
        totalInserted,
        totalRows: args.rows.length,
        batchErrors: errors,
        message: `Inserted ${totalInserted}/${args.rows.length} rows into ${args.tableName}`,
      };
    }
  },

  // ═══════════════════════════════════════════════════════════════════
  // generate_embeddings — Generate Vertex AI text embeddings
  // Uses text-embedding-004 (768-dim), returns float array
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "generate_embeddings",
      description: "Generate text embeddings using Vertex AI's text-embedding-004 model (768 dimensions). Input is an array of text strings. Returns an array of float arrays. Use this to generate embeddings for entity aliases before writing them to the AliasEmbedding column in Spanner.",
      schema: z.object({
        texts: z.array(z.string().min(1)).min(1).max(50).describe("Array of text strings to embed (max 50 per call)"),
        model: z.string().default("text-embedding-004").describe("Vertex AI embedding model ID"),
      })
    },
    handler: async (args) => {
      const projectId = env.SPANNER_PROJECT_ID || env.GCP_PROJECT;
      const location = "us-central1";
      const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${args.model}:predict`;

      try {
        const { GoogleAuth } = await import("google-auth-library");
        const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
        const client = await auth.getClient();

        // Batch the embeddings request
        const instances = args.texts.map((text) => ({ content: text }));
        const response = await client.request({
          url,
          method: "POST",
          data: {
            instances,
            parameters: { outputDimensionality: 768 },
          },
        });

        const predictions = (response.data as any).predictions;
        if (!predictions) {
          return { error: "No predictions returned from Vertex AI" };
        }

        const embeddings = predictions.map((p: any) => p.embeddings.values as number[]);

        return {
          success: true,
          model: args.model,
          count: embeddings.length,
          dimensions: embeddings[0]?.length || 0,
          embeddings,
        };
      } catch (err: any) {
        return { error: `Embedding generation failed: ${err.message}` };
      }
    }
  },

  // ═══════════════════════════════════════════════════════════════════
  // backfill_embeddings — Batch-generate and write embeddings for
  // EntityAliases rows that have null AliasEmbedding
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "backfill_embeddings",
      description: "Reads EntityAliases rows with NULL AliasEmbedding, generates embeddings via Vertex AI text-embedding-004, and writes them back. Processes in batches of 20. Specify sport to limit scope, or omit to process all. This is the tool that lights up Tier-3 vector ANN search.",
      schema: z.object({
        instanceId: z.string().default("clearspace").describe("Spanner instance ID"),
        databaseId: z.string().default("sports-entities-db").describe("Spanner database ID"),
        sport: z.string().optional().describe("Filter by sport (e.g. 'mlb', 'nba', 'nfl') — omit to process all"),
        limit: z.number().int().positive().default(100).describe("Max rows to process per call"),
        embeddingInput: z.enum(["alias_only", "alias_and_name"]).default("alias_only")
          .describe("What text to embed: 'alias_only' uses Alias, 'alias_and_name' uses Alias + CanonicalName"),
      })
    },
    handler: async (args) => {
      const projectId = env.SPANNER_PROJECT_ID || env.GCP_PROJECT;
      const location = "us-central1";
      const model = "text-embedding-004";
      const embedUrl = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:predict`;

      const database = spanner.instance(args.instanceId).database(args.databaseId);

      // Step 1: Read rows with null embeddings
      // Only need AliasId (PK for update), Alias and CanonicalName (for embedding text)
      let whereClause = "AliasEmbedding IS NULL";
      const params: Record<string, any> = {};
      if (args.sport) {
        whereClause += " AND Sport = @sport";
        params.sport = args.sport;
      }

      const sql = `SELECT AliasId, Alias, CanonicalName FROM EntityAliases WHERE ${whereClause} LIMIT @limit`;
      params.limit = args.limit;

      const [rows] = await database.run({ sql, params });
      if (rows.length === 0) {
        return { success: true, processed: 0, message: "No rows with null embeddings found." };
      }

      const aliasRows = rows.map((r: any) => r.toJSON());
      logger.info({ msg: "backfill_embeddings: fetched rows", count: aliasRows.length });

      // Step 2: Generate embeddings in batches of 20
      const { GoogleAuth } = await import("google-auth-library");
      const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
      const client = await auth.getClient();

      const EMBED_BATCH = 20;
      let totalProcessed = 0;
      const errors: string[] = [];

      for (let i = 0; i < aliasRows.length; i += EMBED_BATCH) {
        const batch = aliasRows.slice(i, i + EMBED_BATCH);

        // Build embedding input text
        const texts = batch.map((row: any) => {
          if (args.embeddingInput === "alias_and_name") {
            return `${row.Alias} ${row.CanonicalName}`;
          }
          return row.Alias;
        });

        try {
          // Call Vertex AI
          const response = await client.request({
            url: embedUrl,
            method: "POST",
            data: {
              instances: texts.map((t) => ({ content: t })),
              parameters: { outputDimensionality: 768 },
            },
          });

          const predictions = (response.data as any).predictions;
          if (!predictions || predictions.length !== batch.length) {
            errors.push(`Embedding batch at offset ${i}: prediction count mismatch`);
            continue;
          }

          // Step 3: Write embeddings back — use UPDATE (not upsert)
          // These rows already exist (we just SELECTed them), so update
          // only touches the columns we're changing. Avoids requiring
          // every NOT NULL column in the mutation buffer.
          const updateRows = batch.map((row: any, idx: number) => ({
            AliasId: row.AliasId,
            AliasEmbedding: predictions[idx].embeddings.values as number[],
            UpdatedAt: Spanner.COMMIT_TIMESTAMP,
          }));

          await database.table("EntityAliases").update(updateRows);
          totalProcessed += batch.length;
          logger.info({ msg: "backfill_embeddings: wrote batch", offset: i, count: batch.length });
        } catch (err: any) {
          errors.push(`Batch at offset ${i}: ${err.message}`);
        }
      }

      return {
        success: errors.length === 0,
        processed: totalProcessed,
        total: aliasRows.length,
        errors,
        message: `Backfilled ${totalProcessed}/${aliasRows.length} embeddings. Tier-3 vector search ${totalProcessed > 0 ? 'is now partially active' : 'still dark'}.`,
      };
    }
  },

  // ═══════════════════════════════════════════════════════════════════
  // create_vector_index — Apply a VECTOR INDEX via DDL for ANN search
  // Wraps the Database Admin API updateSchema with the specific DDL
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "create_vector_index",
      description: "Create a Spanner VECTOR INDEX on a column for Approximate Nearest Neighbor (ANN) search. This enables Tier-3 vector resolution. The index is created via a DDL operation (Database Admin API). This is a long-running operation.",
      schema: z.object({
        instanceId: z.string().default("clearspace").describe("Spanner instance ID"),
        databaseId: z.string().default("sports-entities-db").describe("Spanner database ID"),
        indexName: z.string().default("EntityAliasEmbeddingIndex").describe("Name for the vector index"),
        tableName: z.string().default("EntityAliases").describe("Table to index"),
        columnName: z.string().default("AliasEmbedding").describe("Vector column to index"),
        distanceType: z.enum(["COSINE", "DOT_PRODUCT", "EUCLIDEAN"]).default("COSINE").describe("Distance metric"),
        treeDepth: z.number().int().positive().default(2).describe("Tree depth for the ScaNN index"),
        numLeaves: z.number().int().positive().default(1000).describe("Number of leaves in the ScaNN tree"),
      })
    },
    handler: async (args, context) => {
      // Gate behind approval — this is a schema change
      if (context.connectionId) {
        const approvalId = `approve_${Math.random().toString(36).substring(2, 11)}`;
        sseManager.sendEvent(context.connectionId, 'tool_approval_required', {
          approvalId,
          tool: "create_vector_index",
          args: { indexName: args.indexName, table: args.tableName, column: args.columnName }
        });
        const approved = await waitForApproval(approvalId, "create_vector_index", args);
        if (!approved) {
          return { error: "Permission Denied: User did not approve vector index creation." };
        }
      }

      const ddl = `CREATE VECTOR INDEX ${args.indexName}
  ON ${args.tableName}(${args.columnName})
  WHERE ${args.columnName} IS NOT NULL
  OPTIONS (
    distance_type = '${args.distanceType}',
    tree_depth = ${args.treeDepth},
    num_leaves = ${args.numLeaves}
  )`;

      try {
        const database = spanner.instance(args.instanceId).database(args.databaseId);
        const [operation] = await database.updateSchema([ddl]);
        await operation.promise();
        return {
          success: true,
          indexName: args.indexName,
          tableName: args.tableName,
          columnName: args.columnName,
          distanceType: args.distanceType,
          ddlApplied: ddl,
          message: `Vector index '${args.indexName}' created. Tier-3 ANN search is now active.`,
        };
      } catch (err: any) {
        if (err.message?.includes('already exists')) {
          return { success: true, message: `Vector index '${args.indexName}' already exists.` };
        }
        return { error: `create_vector_index failed: ${err.message}` };
      }
    }
  },
];
