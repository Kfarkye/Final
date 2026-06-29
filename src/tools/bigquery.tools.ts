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
      name: "execute_bq_query",
      description: "Execute a read-only SQL query against BigQuery datasets (e.g. querying audit logs or analytics data). Ensure you use standard SQL dialect.",
      schema: z.object({
        query: z.string().describe("The standard SQL query to execute"),
        projectId: z.string().optional().describe("GCP Project ID (defaults to environment project)"),
      })
    },
    handler: async (args) => {
      try {
        const client = getBqClient(args.projectId);
        
        const options = {
          query: args.query,
          location: 'US',
        };

        const [job] = await client.createQueryJob(options);
        const [rows] = await job.getQueryResults();

        return {
          success: true,
          rowCount: rows.length,
          rows: rows.slice(0, 500) // Cap to avoid huge responses
        };
      } catch (err: any) {
        return { error: `BigQuery execution failed: ${err.message}` };
      }
    }
  },
  {
    definition: {
      name: "list_bq_datasets_tables",
      description: "List datasets and their tables in a BigQuery project to map the data warehouse surface area.",
      schema: z.object({
        projectId: z.string().optional().describe("GCP Project ID (defaults to environment project)"),
      })
    },
    handler: async (args) => {
      try {
        const client = getBqClient(args.projectId);
        const [datasets] = await client.getDatasets();
        
        const result: any[] = [];
        for (const dataset of datasets) {
          const [tables] = await dataset.getTables();
          result.push({
            datasetId: dataset.id,
            tables: tables.map(t => t.id)
          });
        }
        
        return {
          project: args.projectId || env.GCP_PROJECT || 'reverie',
          datasets: result
        };
      } catch (err: any) {
        return { error: `Failed to list BigQuery datasets: ${err.message}` };
      }
    }
  }
];
