import { z } from "zod";
import { RegisteredTool, ToolContext } from "./types";

// ============================================================================
// Sports Betting & Live Odds Tools
// Ported from clearspace-native/lib/remote-mcp.ts (get_live_odds executor)
// 
// ENFORCEMENT: The AI Assistant MUST read live odds directly from this API tool.
// The Spanner odds tables are downstream artifacts for analytics ONLY, 
// NOT a valid live read source due to rapid staleness.
// ============================================================================

const DEFAULT_BOOKMAKERS = 'draftkings,fanduel,betmgm,caesars,circasports,pinnacle,betonlineag,betus,bovada';

const BOOKMAKER_KEY_CORRECTIONS: Record<string, string> = {
  'betonline': 'betonlineag',
  'circa': 'circasports',
  'betus': 'betus',
  'bovada': 'bovada'
};

// ── Helpers ─────────────────────────────────────────────────────────

function getApiKey(): string {
  const key = process.env.ODDS_API_KEY;
  if (!key) throw new Error("ODDS_API_KEY environment variable is not configured.");
  return key;
}

function normalizeRegions(regions?: string): string {
  if (!regions) return 'us,us2,eu';
  const cleaned = regions.split(',')
    .map((r: string) => r.trim().toLowerCase())
    .filter((r: string) => r && !['uk', 'au'].includes(r))
    .join(',');
  return cleaned || 'us,us2,eu';
}

function normalizeBookmakers(bookmakers?: string): string {
  const str = bookmakers || DEFAULT_BOOKMAKERS;
  return str.split(',')
    .map((b: string) => b.trim().toLowerCase())
    .map((b: string) => BOOKMAKER_KEY_CORRECTIONS[b] || b)
    .filter((b: string) => b && b !== 'resortsworld')
    .join(',');
}

function flagPinnacle(bookmakers: any[]) {
  bookmakers?.forEach((book: any) => {
    if (book.key === 'pinnacle') book.is_sharp_anchor = true;
  });
}

/**
 * Wraps the Odds API response with quota headers so the LLM
 * can self-regulate API usage and the user sees remaining calls.
 */
async function oddsApiFetch(url: string): Promise<{ data: any; quota: { remaining: number | null; used: number | null; cost: number | null } }> {
  const res = await fetch(url);
  
  const quota = {
    remaining: res.headers.get('x-requests-remaining') ? parseInt(res.headers.get('x-requests-remaining')!, 10) : null,
    used: res.headers.get('x-requests-used') ? parseInt(res.headers.get('x-requests-used')!, 10) : null,
    cost: res.headers.get('x-requests-last') ? parseInt(res.headers.get('x-requests-last')!, 10) : null,
  };

  if (!res.ok) {
    throw new Error(`Odds API returned ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  return { data, quota };
}

// ── Tools ───────────────────────────────────────────────────────────

export const bettingTools: RegisteredTool<any>[] = [
  // ═══════════════════════════════════════════════════════════════════
  //  GET LIVE ODDS — Premium Odds API
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "get_live_odds",
      description: "Fetch live, structured betting odds from the premium Odds API. Returns current moneyline, spreads, totals, or player props. Supported markets: h2h, spreads, totals, pitcher_strikeouts, batter_home_runs, batter_hits, pitcher_earned_runs. Player prop markets require the eventId parameter. Pinnacle lines are flagged as sharp anchors. Returns API quota info.",
      schema: z.object({
        sport: z.string().describe("The sport key (e.g., baseball_mlb, basketball_nba, americanfootball_nfl, soccer_epl)"),
        markets: z.string().optional().describe("Comma-separated list of markets to fetch (e.g., h2h, spreads, totals, pitcher_strikeouts). Default: h2h"),
        regions: z.string().optional().describe("Comma-separated regions to fetch odds for (e.g., us, us2, eu). Default: us,us2,eu"),
        bookmakers: z.string().optional().describe("Comma-separated bookmaker keys (e.g., draftkings,fanduel). Default: all major US books"),
        eventId: z.string().optional().describe("Specific event ID. Required when fetching player prop markets like pitcher_strikeouts.")
      })
    },
    handler: async (args) => {
      const apiKey = getApiKey();
      const sport = args.sport || 'upcoming';
      const markets = args.markets || 'h2h';
      const regions = normalizeRegions(args.regions);
      const bookmakers = normalizeBookmakers(args.bookmakers);
      const eventId = args.eventId || null;

      const url = eventId
        ? `https://api.the-odds-api.com/v4/sports/${sport}/events/${eventId}/odds/?apiKey=${apiKey}&regions=${regions}&markets=${markets}&bookmakers=${bookmakers}&oddsFormat=american`
        : `https://api.the-odds-api.com/v4/sports/${sport}/odds/?apiKey=${apiKey}&regions=${regions}&markets=${markets}&bookmakers=${bookmakers}&oddsFormat=american`;

      const { data, quota } = await oddsApiFetch(url);

      // Flag Pinnacle as sharp anchor for EV calculation context
      if (Array.isArray(data)) {
        data.forEach((game: any) => flagPinnacle(game.bookmakers));
      }

      return { odds: data, _quota: quota };
    }
  },

  // ═══════════════════════════════════════════════════════════════════
  //  GET SCORES — Live scores and results
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "get_scores",
      description: "Fetch live and recently completed game scores. Returns scores for in-progress and recently finished games (within the daysFrom window). Use this for live score updates and game results.",
      schema: z.object({
        sport: z.string().describe("The sport key (e.g., baseball_mlb, basketball_nba)"),
        daysFrom: z.number().optional().describe("Number of days in the past to include completed games (1-3). Default: 1")
      })
    },
    handler: async (args) => {
      const apiKey = getApiKey();
      const sport = String(args.sport);
      const daysFrom = Math.min(Math.max(args.daysFrom || 1, 1), 3);

      const url = `https://api.the-odds-api.com/v4/sports/${sport}/scores/?apiKey=${apiKey}&daysFrom=${daysFrom}`;
      const { data, quota } = await oddsApiFetch(url);
      return { scores: data, _quota: quota };
    }
  },

  // ═══════════════════════════════════════════════════════════════════
  //  LIST SPORTS — Available sport keys
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "list_sports",
      description: "List all available sports keys from the Odds API. Returns active sport leagues with their keys (e.g., baseball_mlb, basketball_nba) which can be used with get_live_odds.",
      schema: z.object({
        all: z.boolean().optional().describe("If true, include out-of-season sports. Default: false (only in-season)")
      })
    },
    handler: async (args) => {
      const apiKey = getApiKey();
      const allParam = args.all ? '&all=true' : '';
      const url = `https://api.the-odds-api.com/v4/sports/?apiKey=${apiKey}${allParam}`;
      const { data, quota } = await oddsApiFetch(url);
      return { sports: data, _quota: quota };
    }
  },

  // ═══════════════════════════════════════════════════════════════════
  //  LIST EVENTS — Upcoming events for a sport
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "list_events",
      description: "List upcoming events/games for a specific sport. Returns event IDs, team names, and commence times. Use the event IDs with get_live_odds for player prop markets.",
      schema: z.object({
        sport: z.string().describe("The sport key (e.g., baseball_mlb, basketball_nba)")
      })
    },
    handler: async (args) => {
      const apiKey = getApiKey();
      const sport = String(args.sport);
      const url = `https://api.the-odds-api.com/v4/sports/${sport}/events/?apiKey=${apiKey}`;
      const { data, quota } = await oddsApiFetch(url);
      return { events: data, _quota: quota };
    }
  },

  // ═══════════════════════════════════════════════════════════════════
  //  GET EVENT ODDS — Detailed odds for a single event
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "get_event_odds",
      description: "Get detailed odds for a single event including all available markets and bookmakers. Useful for deep-dive analysis on a specific game. Returns full market data with Pinnacle flagged as sharp anchor.",
      schema: z.object({
        sport: z.string().describe("The sport key (e.g., baseball_mlb)"),
        eventId: z.string().describe("The specific event ID from list_events"),
        markets: z.string().optional().describe("Comma-separated markets (e.g., h2h,spreads,totals). Default: h2h,spreads,totals"),
        regions: z.string().optional().describe("Comma-separated regions. Default: us,us2,eu")
      })
    },
    handler: async (args) => {
      const apiKey = getApiKey();
      const sport = String(args.sport);
      const eventId = String(args.eventId);
      const markets = args.markets || 'h2h,spreads,totals';
      const regions = normalizeRegions(args.regions);

      const url = `https://api.the-odds-api.com/v4/sports/${sport}/events/${eventId}/odds/?apiKey=${apiKey}&regions=${regions}&markets=${markets}&bookmakers=${DEFAULT_BOOKMAKERS}&oddsFormat=american`;

      const { data, quota } = await oddsApiFetch(url);
      if (data && Array.isArray(data.bookmakers)) flagPinnacle(data.bookmakers);
      return { event: data, _quota: quota };
    }
  },

  // ═══════════════════════════════════════════════════════════════════
  //  CHECK ODDS QUOTA — API usage tracking
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "check_odds_quota",
      description: "Check remaining Odds API quota without consuming a request. Makes a lightweight sports list call and returns only the quota headers (remaining requests, used, last request cost).",
      schema: z.object({})
    },
    handler: async () => {
      const apiKey = getApiKey();
      const url = `https://api.the-odds-api.com/v4/sports/?apiKey=${apiKey}`;
      const { quota } = await oddsApiFetch(url);
      return { quota };
    }
  },

  // ═══════════════════════════════════════════════════════════════════
  //  GET HISTORICAL ODDS — Past odds snapshots (read-only)
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "get_historical_odds",
      description: "Fetch historical odds snapshots from the Odds API. Returns the state of odds at a specific point in time. Costs 10 credits per region per market. Use ISO 8601 date format. Available from June 2020 for featured markets.",
      schema: z.object({
        sport: z.string().describe("The sport key (e.g., baseball_mlb, basketball_nba)"),
        date: z.string().describe("ISO 8601 timestamp to query (e.g., 2025-06-10T12:00:00Z). Returns closest snapshot at or before this time."),
        markets: z.string().optional().describe("Comma-separated markets (e.g., h2h,spreads,totals). Default: h2h"),
        regions: z.string().optional().describe("Comma-separated regions. Default: us"),
        bookmakers: z.string().optional().describe("Comma-separated bookmaker keys. Default: all major US books")
      })
    },
    handler: async (args) => {
      const apiKey = getApiKey();
      const sport = String(args.sport);
      const date = String(args.date);
      const markets = args.markets || 'h2h';
      const regions = args.regions || 'us';
      const bookmakers = normalizeBookmakers(args.bookmakers);

      const url = `https://api.the-odds-api.com/v4/historical/sports/${sport}/odds/?apiKey=${apiKey}&regions=${regions}&markets=${markets}&bookmakers=${bookmakers}&oddsFormat=american&date=${encodeURIComponent(date)}`;
      const { data, quota } = await oddsApiFetch(url);

      // Flag Pinnacle on historical data too
      if (data?.data && Array.isArray(data.data)) {
        data.data.forEach((game: any) => flagPinnacle(game.bookmakers));
      }

      return { historical: data, _quota: quota };
    }
  },

  // ═══════════════════════════════════════════════════════════════════
  //  INGEST HISTORICAL ODDS — Fetch + write to Spanner MlbOddsHistory
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "ingest_historical_odds",
      description: "Fetch historical odds from the Odds API and ingest them into the MlbOddsHistory Spanner table. Extracts moneyline, spreads, and totals per bookmaker and writes snapshots. The MlbOddsHistory table is interleaved under MlbGames, so only events with matching EventIds in MlbGames will succeed. Returns ingestion stats.",
      schema: z.object({
        sport: z.string().describe("The sport key (e.g., baseball_mlb)"),
        date: z.string().describe("ISO 8601 timestamp to query (e.g., 2025-06-10T12:00:00Z)"),
        snapshotType: z.string().optional().describe("Label for this snapshot (e.g., 'open', 'close', 'pregame_1h'). Default: 'historical'"),
        markets: z.string().optional().describe("Comma-separated markets. Default: h2h,spreads,totals"),
        regions: z.string().optional().describe("Comma-separated regions. Default: us"),
        dryRun: z.boolean().optional().describe("If true, fetches and transforms but does NOT write to Spanner. Default: false")
      })
    },
    handler: async (args, context?: ToolContext) => {
      const apiKey = getApiKey();
      const sport = String(args.sport);
      const date = String(args.date);
      const markets = args.markets || 'h2h,spreads,totals';
      const regions = args.regions || 'us';
      const snapshotType = args.snapshotType || 'historical';
      const isDryRun = args.dryRun === true;
      const bookmakers = DEFAULT_BOOKMAKERS;

      // 1. Fetch historical odds
      const url = `https://api.the-odds-api.com/v4/historical/sports/${sport}/odds/?apiKey=${apiKey}&regions=${regions}&markets=${markets}&bookmakers=${bookmakers}&oddsFormat=american&date=${encodeURIComponent(date)}`;
      const { data: response, quota } = await oddsApiFetch(url);

      const snapshotTimestamp = response?.timestamp || date;
      const events = response?.data || [];
      
      if (!Array.isArray(events) || events.length === 0) {
        return { 
          status: 'empty', 
          message: 'No historical data returned for this date/sport',
          snapshotTimestamp,
          _quota: quota 
        };
      }

      // 2. Transform to MlbOddsHistory rows
      const rows: any[] = [];

      for (const event of events) {
        const eventId = event.id;
        if (!eventId) continue;

        for (const bookmaker of event.bookmakers || []) {
          let homeMoneyLine: number | null = null;
          let awayMoneyLine: number | null = null;
          let overUnder: number | null = null;
          let spread: number | null = null;

          for (const market of bookmaker.markets || []) {
            if (market.key === 'h2h') {
              for (const outcome of market.outcomes || []) {
                if (outcome.name === event.home_team) homeMoneyLine = outcome.price;
                if (outcome.name === event.away_team) awayMoneyLine = outcome.price;
              }
            }
            if (market.key === 'totals') {
              const over = (market.outcomes || []).find((o: any) => o.name === 'Over');
              if (over?.point != null) overUnder = over.point;
            }
            if (market.key === 'spreads') {
              const home = (market.outcomes || []).find((o: any) => o.name === event.home_team);
              if (home?.point != null) spread = home.point;
            }
          }

          // Only write if we got at least one meaningful value
          if (homeMoneyLine !== null || overUnder !== null || spread !== null) {
            const snapshotId = `${bookmaker.key}_${snapshotType}_${snapshotTimestamp}`;
            rows.push({
              EventId: eventId,
              SnapshotId: snapshotId,
              Provider: bookmaker.key,
              SnapshotType: snapshotType,
              OverUnder: overUnder,
              Spread: spread,
              HomeMoneyLine: homeMoneyLine,
              AwayMoneyLine: awayMoneyLine,
            });
          }
        }
      }

      if (isDryRun) {
        return {
          status: 'dry_run',
          snapshotTimestamp,
          eventsProcessed: events.length,
          rowsPrepared: rows.length,
          sampleRows: rows.slice(0, 5),
          _quota: quota
        };
      }

      // 3. Write to Spanner via the MCP endpoint (execute_sql with DML)
      // Using individual INSERT OR UPDATE statements via the Spanner MCP
      let written = 0;
      let skipped = 0;
      const errors: string[] = [];

      for (const row of rows) {
        try {
          const sql = `INSERT OR UPDATE INTO MlbOddsHistory 
            (EventId, SnapshotId, Provider, SnapshotType, OverUnder, Spread, HomeMoneyLine, AwayMoneyLine, FetchedAt, CreatedAt, UpdatedAt)
            VALUES ('${row.EventId}', '${row.SnapshotId}', '${row.Provider}', '${row.SnapshotType}', 
                    ${row.OverUnder ?? 'NULL'}, ${row.Spread ?? 'NULL'}, 
                    ${row.HomeMoneyLine ?? 'NULL'}, ${row.AwayMoneyLine ?? 'NULL'},
                    PENDING_COMMIT_TIMESTAMP(), PENDING_COMMIT_TIMESTAMP(), PENDING_COMMIT_TIMESTAMP())`;
          
          // Execute via the Spanner MCP tool using the registry
          const spannerResult = await fetch(`http://localhost:${process.env.PORT || 3000}/api/mcp/spanner`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: Date.now(),
              method: 'tools/call',
              params: {
                name: 'execute_sql',
                arguments: {
                  instanceId: 'clearspace',
                  databaseId: 'sports-mlb-db',
                  sql
                }
              }
            })
          });
          
          const result = await spannerResult.json();
          if (result.error) {
            // Likely a foreign key / interleave issue (EventId not in MlbGames)
            skipped++;
            if (errors.length < 3) errors.push(`${row.EventId}: ${JSON.stringify(result.error).substring(0, 100)}`);
          } else {
            written++;
          }
        } catch (err: any) {
          skipped++;
          if (errors.length < 3) errors.push(`${row.EventId}: ${err.message?.substring(0, 100)}`);
        }
      }

      return {
        status: 'completed',
        snapshotTimestamp,
        snapshotType,
        eventsProcessed: events.length,
        rowsPrepared: rows.length,
        written,
        skipped,
        ...(errors.length > 0 ? { sampleErrors: errors } : {}),
        _quota: quota
      };
    }
  }
];
