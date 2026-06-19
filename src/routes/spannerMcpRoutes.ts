// src/routes/spannerMcpRoutes.ts
import { Router, Request, Response } from "express";
import { Spanner } from "@google-cloud/spanner";
import { env } from "../config/env";
import { z } from "zod";
import { sseManager } from "../../lib/sse/sse-manager";
import { waitForApproval } from "../utils/approval";

const router = Router();
const spanner = new Spanner({ projectId: env.SPANNER_PROJECT_ID });

const baseMcpCallSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.union([z.literal("tools/list"), z.literal("tools/call")]),
  params: z.object({
    name: z.string().optional(),
    arguments: z.any().optional(),
  }).optional(),
  id: z.union([z.string(), z.number()]),
});

router.post("/", async (req: Request, res: Response) => {
  try {
    const mcpBody = baseMcpCallSchema.parse(req.body);
    const { method, params, id } = mcpBody;

    if (method === "tools/list") {
      return res.json({
        jsonrpc: "2.0",
        id,
        result: {
          tools: [
            {
              name: "list_instances",
              description: "Lists all Cloud Spanner instances in the active project.",
              inputSchema: { type: "object", properties: {} }
            },
            {
              name: "list_databases",
              description: "Lists all databases inside a specific Spanner instance.",
              inputSchema: {
                type: "object",
                properties: {
                  instanceId: { type: "string" }
                },
                required: ["instanceId"]
              }
            },
            {
              name: "get_database_ddl",
              description: "Retrieves the DDL (Data Definition Language) structure for a database.",
              inputSchema: {
                type: "object",
                properties: {
                  instanceId: { type: "string" },
                  databaseId: { type: "string" }
                },
                required: ["instanceId", "databaseId"]
              }
            },
            {
              name: "execute_sql",
              description: "Executes a SQL query (SELECT) or a DML statement (INSERT/UPDATE/DELETE). DML statements require human UX approval. CANNOT run DDL (CREATE/ALTER/DROP TABLE) — use update_database_ddl for that.",
              inputSchema: {
                type: "object",
                properties: {
                  instanceId: { type: "string" },
                  databaseId: { type: "string" },
                  sql: { type: "string" }
                },
                required: ["instanceId", "databaseId", "sql"]
              }
            },
            {
              name: "update_database_ddl",
              description: "Executes DDL statements (CREATE TABLE, ALTER TABLE, DROP TABLE, CREATE INDEX, etc.) on a Spanner database. Uses the Database Admin API (UpdateDatabaseDdl). This is the ONLY tool that can run DDL — execute_sql cannot. DDL is a long-running operation; this tool awaits completion before returning.",
              inputSchema: {
                type: "object",
                properties: {
                  instanceId: { type: "string", description: "Spanner instance ID" },
                  databaseId: { type: "string", description: "Spanner database ID" },
                  statements: {
                    type: "array",
                    items: { type: "string" },
                    description: "Array of DDL statements to apply (e.g. ['CREATE TABLE Foo (id INT64 NOT NULL) PRIMARY KEY (id)'])"
                  }
                },
                required: ["instanceId", "databaseId", "statements"]
              }
            },
            {
              name: "create_database",
              description: "Creates a new Spanner database in a given instance, optionally with initial DDL statements.",
              inputSchema: {
                type: "object",
                properties: {
                  instanceId: { type: "string", description: "Spanner instance ID" },
                  databaseId: { type: "string", description: "New database name" },
                  initialDdl: {
                    type: "array",
                    items: { type: "string" },
                    description: "Optional initial DDL statements to apply on creation"
                  }
                },
                required: ["instanceId", "databaseId"]
              }
            }
          ]
        }
      });
    }

    if (method === "tools/call") {
      const toolName = params?.name;
      const args = params?.arguments || {};
      const connectionId = req.headers["x-connection-id"] as string | undefined;

      if (toolName === "list_instances") {
        const [instances] = await spanner.getInstances();
        const plainInstances = instances.map((inst: any) => ({
          id: inst.id,
          formattedName: inst.formattedName,
          nodeCount: inst.nodeCount,
          state: inst.state
        }));
        
        return res.json({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: JSON.stringify({ instances: plainInstances }) }] }
        });
      }

      if (toolName === "list_databases") {
        if (!args.instanceId) {
          return res.status(400).json({ error: "Missing instanceId parameter" });
        }
        const instance = spanner.instance(args.instanceId);
        const [databases] = await instance.getDatabases();
        const plainDatabases = databases.map((db: any) => ({
          id: db.id,
          formattedName: db.formattedName,
          state: db.state
        }));
        
        return res.json({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: JSON.stringify({ instanceId: args.instanceId, databases: plainDatabases }) }] }
        });
      }

      if (toolName === "get_database_ddl") {
        if (!args.instanceId || !args.databaseId) {
          return res.status(400).json({ error: "Missing instanceId or databaseId parameter" });
        }
        const database = spanner.instance(args.instanceId).database(args.databaseId);
        const [ddlStatements] = await database.getSchema();
        
        return res.json({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: JSON.stringify({ instanceId: args.instanceId, databaseId: args.databaseId, ddl: ddlStatements }) }] }
        });
      }

      if (toolName === "execute_sql") {
        if (!args.instanceId || !args.databaseId || !args.sql) {
          return res.status(400).json({ error: "Missing required parameter: instanceId, databaseId, or sql" });
        }
        
        const sql = args.sql.trim();
        const isDDL = /^\s*(create|alter|drop)\s+(table|index|view|database|change\s+stream)\b/i.test(sql);
        const isWriteDML = /^\s*(insert|update|delete|merge)\b/i.test(sql);

        // ── DDL rejection: fail loud, not silent ──────────────────────
        if (isDDL) {
          return res.json({
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [{ type: "text", text: "ERROR: DDL statements (CREATE/ALTER/DROP TABLE) cannot be executed through execute_sql. " +
                "The Spanner Query/DML API does not support DDL. Use the 'update_database_ddl' tool instead, which calls the Database Admin API (UpdateDatabaseDdl RPC)." }]
            }
          });
        }

        if (isWriteDML && connectionId) {
          const approvalId = `approve_${Math.random().toString(36).substring(2, 11)}`;
          sseManager.sendEvent(connectionId, 'tool_approval_required', { approvalId, tool: "execute_sql", args });
          const approved = await waitForApproval(approvalId, "execute_sql", args);
          if (!approved) {
            return res.json({
              jsonrpc: "2.0",
              id,
              result: { isError: true, content: [{ type: "text", text: "Permission Denied: User did not approve execution of execute_sql write operation." }] }
            });
          }
        }

        const database = spanner.instance(args.instanceId).database(args.databaseId);

        if (isWriteDML) {
          let rowCount = 0;
          await database.runTransactionAsync(async (transaction) => {
            const [count] = await transaction.runUpdate({ sql });
            await transaction.commit();
            rowCount = count;
          });
          return res.json({
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: JSON.stringify({ success: true, statement: "DML Executed successfully", rowCount }) }] }
          });
        } else {
          const [rows] = await database.run({ sql });
          const plainRows = rows.map((row: any) => row.toJSON ? row.toJSON() : row);
          return res.json({
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: JSON.stringify({ instanceId: args.instanceId, databaseId: args.databaseId, sql, rows: plainRows }) }] }
          });
        }
      }

      // ── update_database_ddl — Database Admin API (UpdateDatabaseDdl LRO) ──
      if (toolName === "update_database_ddl") {
        if (!args.instanceId || !args.databaseId || !args.statements?.length) {
          return res.status(400).json({ error: "Missing required parameter: instanceId, databaseId, or statements[]" });
        }

        // DDL is always destructive-capable — require approval
        if (connectionId) {
          const approvalId = `approve_${Math.random().toString(36).substring(2, 11)}`;
          sseManager.sendEvent(connectionId, 'tool_approval_required', {
            approvalId,
            tool: "update_database_ddl",
            args: { ...args, statements: args.statements.map((s: string) => s.substring(0, 200) + (s.length > 200 ? '...' : '')) }
          });
          const approved = await waitForApproval(approvalId, "update_database_ddl", args);
          if (!approved) {
            return res.json({
              jsonrpc: "2.0",
              id,
              result: { isError: true, content: [{ type: "text", text: "Permission Denied: User did not approve DDL execution." }] }
            });
          }
        }

        const database = spanner.instance(args.instanceId).database(args.databaseId);
        try {
          const [operation] = await database.updateSchema(args.statements);
          // Await the LRO to completion — DDL routinely takes 20-60s
          await operation.promise();
          return res.json({
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: JSON.stringify({
                success: true,
                done: true,
                appliedStatements: args.statements,
                message: `Successfully applied ${args.statements.length} DDL statement(s) to ${args.instanceId}/${args.databaseId}`
              }) }]
            }
          });
        } catch (ddlErr: any) {
          return res.json({
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [{ type: "text", text: `DDL execution failed: ${ddlErr.message || ddlErr}` }]
            }
          });
        }
      }

      // ── create_database ──
      if (toolName === "create_database") {
        if (!args.instanceId || !args.databaseId) {
          return res.status(400).json({ error: "Missing required parameter: instanceId or databaseId" });
        }

        if (connectionId) {
          const approvalId = `approve_${Math.random().toString(36).substring(2, 11)}`;
          sseManager.sendEvent(connectionId, 'tool_approval_required', { approvalId, tool: "create_database", args });
          const approved = await waitForApproval(approvalId, "create_database", args);
          if (!approved) {
            return res.json({
              jsonrpc: "2.0",
              id,
              result: { isError: true, content: [{ type: "text", text: "Permission Denied: User did not approve database creation." }] }
            });
          }
        }

        const instance = spanner.instance(args.instanceId);
        try {
          const [database, operation] = await instance.createDatabase(args.databaseId, {
            schema: args.initialDdl || []
          });
          await operation.promise();
          return res.json({
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: JSON.stringify({
                success: true,
                databaseId: args.databaseId,
                instanceId: args.instanceId,
                initialDdlApplied: (args.initialDdl || []).length,
                message: `Database '${args.databaseId}' created in instance '${args.instanceId}'`
              }) }]
            }
          });
        } catch (createErr: any) {
          return res.json({
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [{ type: "text", text: `Database creation failed: ${createErr.message || createErr}` }]
            }
          });
        }
      }

      return res.status(404).json({ error: `MCP Tool ${toolName} not found.` });
    }
  } catch (err: any) {
    console.error("[Spanner Routing Fatal Error]:", err);
    return res.status(500).json({ error: err.message });
  }
});

export default router;
