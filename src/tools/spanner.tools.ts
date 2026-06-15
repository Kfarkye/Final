import { z } from 'zod';
import { RegisteredTool } from './types';
import { sseManager } from '../../lib/sse/sse-manager';
import { waitForApproval } from '../utils/approval';
import { Spanner } from '@google-cloud/spanner';
import { env } from '../config/env';

// Initialize Spanner client
const spanner = new Spanner({ projectId: env.SPANNER_PROJECT_ID });

export const spannerTools: RegisteredTool<any>[] = [
  {
    definition: {
      name: "list_instances",
      description: "Lists all Cloud Spanner instances in the active project.",
      schema: z.object({})
    },
    handler: async () => {
      const [instances] = await spanner.getInstances();
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
      description: "Lists all databases inside a specific Spanner instance.",
      schema: z.object({
        instanceId: z.string().min(1, "Instance ID is required")
      })
    },
    handler: async (args) => {
      const instance = spanner.instance(args.instanceId);
      const [databases] = await instance.getDatabases();
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
      description: "Retrieves the DDL (Data Definition Language) structure for a database.",
      schema: z.object({
        instanceId: z.string().min(1, "Instance ID is required"),
        databaseId: z.string().min(1, "Database ID is required")
      })
    },
    handler: async (args) => {
      const database = spanner.instance(args.instanceId).database(args.databaseId);
      const [ddlStatements] = await database.getSchema();
      return { instanceId: args.instanceId, databaseId: args.databaseId, ddl: ddlStatements };
    }
  },
  {
    definition: {
      name: "execute_sql",
      description: "Executes a SQL query (SELECT) or a DML statement (INSERT/UPDATE/DELETE). DML statements require human UX approval.",
      schema: z.object({
        instanceId: z.string().min(1, "Instance ID is required"),
        databaseId: z.string().min(1, "Database ID is required"),
        sql: z.string().min(1, "SQL statement is required")
      })
    },
    handler: async (args, context) => {
      const sql = args.sql.trim();
      const isWriteDML = /^\s*(insert|update|delete|merge|drop|create|alter)\b/i.test(sql);

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
        let rowCount = 0;
        await database.runTransactionAsync(async (transaction) => {
          const [count] = await transaction.runUpdate({ sql });
          await transaction.commit();
          rowCount = count;
        });
        return { success: true, statement: "DML Executed successfully", rowCount };
      } else {
        const [rows] = await database.run({ sql });
        const plainRows = rows.map((row: any) => row.toJSON ? row.toJSON() : row);
        return { instanceId: args.instanceId, databaseId: args.databaseId, sql, rows: plainRows };
      }
    }
  }
];
