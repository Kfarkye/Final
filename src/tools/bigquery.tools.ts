import { z } from 'zod';
import { RegisteredTool } from './types.js';
import { BigQuery } from '@google-cloud/bigquery';
import { env } from '../config/env.js';

let bqClient: BigQuery | null = null;
function getBqClient(projectId?: string) {
  if (!bqClient) {
    bqClient = new BigQuery({ projectId: projectId || env.GCP_PROJECT || 'reverie' });
  }
  return bqClient;
}

export const bigqueryTools: RegisteredTool<any>[] = [
  {
    definition: {
      name: "list_bq_datasets_tables",
      description: "Lists BigQuery datasets and tables.",
      schema: z.object({
        projectId: z.string().optional(),
        datasetId: z.string().optional(),
        includeSchemas: z.boolean().optional(),
        maxTables: z.number().optional()
      })
    },
    handler: async (args) => {
      try {
        const client = getBqClient(args.projectId);
        let datasetsToProcess = [];
        
        if (args.datasetId) {
          datasetsToProcess.push(client.dataset(args.datasetId));
        } else {
          const [datasets] = await client.getDatasets();
          datasetsToProcess = datasets;
        }

        const resultDatasets = [];
        for (const dataset of datasetsToProcess) {
          const [tables] = await dataset.getTables();
          const limit = args.maxTables || tables.length;
          
          const resultTables = [];
          for (const table of tables.slice(0, limit)) {
            let schema;
            if (args.includeSchemas) {
              const [metadata] = await table.getMetadata();
              schema = metadata.schema?.fields?.map((f: any) => ({
                name: f.name,
                type: f.type,
                mode: f.mode
              }));
            }
            resultTables.push({
              tableId: table.id,
              type: table.metadata?.type,
              schema
            });
          }
          
          resultDatasets.push({
            datasetId: dataset.id,
            tables: resultTables
          });
        }
        
        return {
          projectId: args.projectId || env.GCP_PROJECT || 'reverie',
          datasets: resultDatasets
        };
      } catch (err: any) {
        return { error: `Failed to list BigQuery datasets/tables: ${err.message}` };
      }
    }
  },
  {
    definition: {
      name: "execute_bq_query",
      description: "Runs a BigQuery query and returns rows.",
      schema: z.object({
        projectId: z.string().optional(),
        location: z.string().optional(),
        sql: z.string(),
        maxRows: z.number().optional(),
        jobConfig: z.record(z.unknown()).optional()
      })
    },
    handler: async (args) => {
      try {
        const client = getBqClient(args.projectId);
        const options: any = {
          query: args.sql,
          location: args.location || 'US',
          maxResults: args.maxRows,
          ...args.jobConfig
        };

        const [job] = await client.createQueryJob(options);
        const [rows, , metadata] = await job.getQueryResults() as any;

        return {
          ok: true,
          projectId: args.projectId || env.GCP_PROJECT || 'reverie',
          location: args.location || 'US',
          jobId: job.id,
          rowCount: rows.length,
          bytesProcessed: job.metadata?.statistics?.query?.totalBytesProcessed,
          schema: metadata?.schema?.fields?.map((f: any) => ({
            name: f.name,
            type: f.type,
            mode: f.mode
          })),
          rows: rows,
          metadata: metadata
        };
      } catch (err: any) {
        return { ok: false, error: err.message };
      }
    }
  },
  {
    definition: {
      name: "execute_bq_sql",
      description: "Runs a BigQuery SQL job.",
      schema: z.object({
        projectId: z.string().optional(),
        location: z.string().optional(),
        sql: z.string(),
        jobConfig: z.record(z.unknown()).optional()
      })
    },
    handler: async (args) => {
      try {
        const client = getBqClient(args.projectId);
        const options: any = {
          query: args.sql,
          location: args.location || 'US',
          ...args.jobConfig
        };

        const [job] = await client.createQueryJob(options);
        // Depending on the job, getQueryResults might not return rows for DDL/DML, 
        // but it waits for the job to complete.
        const [rows, , metadata] = await job.getQueryResults() as any;
        
        return {
          ok: true,
          projectId: args.projectId || env.GCP_PROJECT || 'reverie',
          location: args.location || 'US',
          jobId: job.id,
          bytesProcessed: job.metadata?.statistics?.query?.totalBytesProcessed,
          affectedRows: job.metadata?.statistics?.query?.numDmlAffectedRows,
          schema: metadata?.schema?.fields?.map((f: any) => ({
            name: f.name,
            type: f.type,
            mode: f.mode
          })),
          rows: rows,
          metadata: metadata
        };
      } catch (err: any) {
        return { ok: false, error: err.message };
      }
    }
  },
  {
    definition: {
      name: "insert_bq_rows",
      description: "Inserts rows into a BigQuery table.",
      schema: z.object({
        projectId: z.string().optional(),
        datasetId: z.string(),
        tableId: z.string(),
        rows: z.array(z.record(z.unknown())),
        insertOptions: z.record(z.unknown()).optional()
      })
    },
    handler: async (args) => {
      try {
        const client = getBqClient(args.projectId);
        const table = client.dataset(args.datasetId).table(args.tableId);
        
        await table.insert(args.rows, args.insertOptions);
        
        return {
          ok: true,
          projectId: args.projectId || env.GCP_PROJECT || 'reverie',
          datasetId: args.datasetId,
          tableId: args.tableId,
          insertedRows: args.rows.length
        };
      } catch (err: any) {
        // If there are partial failures, bigquery library throws an error with `errors` array
        if (err.name === 'PartialFailureError' && err.errors) {
           return {
             ok: false,
             projectId: args.projectId || env.GCP_PROJECT || 'reverie',
             datasetId: args.datasetId,
             tableId: args.tableId,
             insertedRows: args.rows.length - err.errors.length,
             failedRows: err.errors.map((e: any) => ({
               index: e.row?.index ?? -1,
               errors: e.errors
             }))
           };
        }
        return { ok: false, error: err.message };
      }
    }
  }
];
