import { z } from 'zod';
import { RegisteredTool } from './types';
import { Spanner } from '@google-cloud/spanner';
import { env } from '../config/env';

// Initialize Spanner client
const spanner = new Spanner({ projectId: env.SPANNER_PROJECT_ID });
let instance: any = null;
let database: any = null;

if (env.SPANNER_INSTANCE_ID && env.SPANNER_DATABASE_ID) {
  instance = spanner.instance(env.SPANNER_INSTANCE_ID);
  database = instance.database(env.SPANNER_DATABASE_ID);
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

export const profileTools: RegisteredTool<any>[] = [
  {
    definition: {
      name: "query_mlb_players_db",
      description: "Query the MLB player profiles database in Spanner. You can search by player name, team code, or player ID. Returns player metadata and JSON-encoded season stats.",
      schema: z.object({
        name: z.string().optional().describe("Partial or full player name to search for"),
        teamCode: z.string().optional().describe("Team abbreviation code (e.g., 'NYY', 'LAD')"),
        playerId: z.number().optional().describe("Exact MLB player ID"),
        limit: z.number().min(1).max(50).optional().describe("Max number of records to return. Default is 10."),
      })
    },
    handler: async (args) => {
      let sql = `SELECT PlayerId, FullName, TeamCode, Position, Bats, Throws, Height, Weight, Age, SeasonStatsJson FROM MlbPlayerProfile WHERE 1=1`;
      const params: Record<string, any> = {};

      if (args.playerId) {
        sql += ` AND PlayerId = @playerId`;
        params.playerId = args.playerId;
      }
      if (args.teamCode) {
        sql += ` AND TeamCode = @teamCode`;
        params.teamCode = args.teamCode;
      }
      if (args.name) {
        sql += ` AND LOWER(FullName) LIKE LOWER(@name)`;
        params.name = `%${args.name}%`;
      }

      sql += ` LIMIT @limit`;
      params.limit = args.limit || 10;

      const [rows] = (await withTimeout(database.run({ sql, params }))) as any;
      return {
        queryArgs: args,
        count: rows.length,
        players: rows.map((row: any) => row.toJSON()),
      };
    }
  },
  {
    definition: {
      name: "query_mlb_teams_db",
      description: "Query the MLB team profiles database in Spanner. You can search by team code, name, or get all teams.",
      schema: z.object({
        teamCode: z.string().optional().describe("Exact team abbreviation code (e.g., 'NYY', 'LAD')"),
        name: z.string().optional().describe("Partial or full team name to search for"),
        limit: z.number().min(1).max(50).optional().describe("Max number of records to return. Default is 30."),
      })
    },
    handler: async (args) => {
      let sql = `SELECT TeamId, TeamCode, FullName, ShortName, LocationName, DivisionId, LeagueId, VenueName FROM MlbTeamProfile WHERE 1=1`;
      const params: Record<string, any> = {};

      if (args.teamCode) {
        sql += ` AND TeamCode = @teamCode`;
        params.teamCode = args.teamCode;
      }
      if (args.name) {
        sql += ` AND LOWER(FullName) LIKE LOWER(@name)`;
        params.name = `%${args.name}%`;
      }

      sql += ` LIMIT @limit`;
      params.limit = args.limit || 30;

      const [rows] = (await withTimeout(database.run({ sql, params }))) as any;
      return {
        queryArgs: args,
        count: rows.length,
        teams: rows.map((row: any) => row.toJSON()),
      };
    }
  }
];
