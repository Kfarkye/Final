import { z } from "zod";
import { RegisteredTool, ToolContext } from "./types";
import { startBackfill, stopBackfill, getBackfillStatus, findMatchingGame } from "../workers/odds-backfill-worker";
import { Spanner } from '@google-cloud/spanner';
import { env } from '../config/env';
import { EdgeEngine, assertLiveEdgeSource, assertNoPlaceholderLeak } from "../services/edge-engine";
import { edgeDb } from "../db/spanner";

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
    },
    entityType: 'odds',
    renderType: 'odds-board',
    promptHint: 'Live odds. Report every price EXACTLY as written — these are American odds, do not round or convert. Pinnacle is flagged as sharp anchor.',
  },

  // ═══════════════════════════════════════════════════════════════════
  //  GET MLB ODDS — Single-game odds, flat book/side/price rows
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "get_mlb_odds",
      description: "Get betting odds for a single MLB game. Returns a flat array of { book, side, price, line } rows ready for the odds-board render contract. Finds the game by team name/abbreviation and date. Supports h2h (moneyline), spreads, and totals markets.",
      schema: z.object({
        team: z.string().describe("Team name or abbreviation to find (e.g., 'CHW', 'White Sox', 'Yankees')"),
        date: z.string().optional().describe("Date in YYYY-MM-DD. Not used for filtering (API returns upcoming), but documents intent."),
        market: z.string().optional().describe("Market type: 'moneyline' (default), 'h2h', 'spreads', or 'totals'"),
        gamePk: z.string().optional().describe("Direct Odds API event ID if known (skips team search)"),
      }),
    },
    handler: async (args) => {
      const apiKey = getApiKey();
      const marketKey = (args.market === 'moneyline' || !args.market) ? 'h2h' : args.market;
      const teamSearch = args.team.toLowerCase().trim();

      // MLB abbreviation → Odds API team name
      const MLB_ABBREVS: Record<string, string> = {
        ari: 'diamondbacks', atl: 'braves', bal: 'orioles', bos: 'red sox',
        chc: 'cubs', chw: 'white sox', cin: 'reds', cle: 'guardians',
        col: 'rockies', det: 'tigers', hou: 'astros', kc: 'royals',
        laa: 'angels', lad: 'dodgers', mia: 'marlins', mil: 'brewers',
        min: 'twins', nym: 'mets', nyy: 'yankees', oak: 'athletics',
        phi: 'phillies', pit: 'pirates', sd: 'padres', sf: 'giants',
        sea: 'mariners', stl: 'cardinals', tb: 'rays', tex: 'rangers',
        tor: 'blue jays', wsh: 'nationals', was: 'nationals',
        // Common alternates
        chi: 'chicago', cws: 'white sox', la: 'los angeles',
      };

      // Resolve abbreviation to a searchable substring
      const resolvedSearch = MLB_ABBREVS[teamSearch] || teamSearch;

      // Step 1: Find the event by team name
      let eventId = args.gamePk || null;
      let awayTeam = '';
      let homeTeam = '';

      if (!eventId) {
        const eventsUrl = `https://api.the-odds-api.com/v4/sports/baseball_mlb/events/?apiKey=${apiKey}`;
        const { data: events } = await oddsApiFetch(eventsUrl);

        const match = (events || []).find((e: any) => {
          const home = (e.home_team || '').toLowerCase();
          const away = (e.away_team || '').toLowerCase();
          return (
            home.includes(resolvedSearch) || away.includes(resolvedSearch) ||
            home.includes(teamSearch) || away.includes(teamSearch)
          );
        });

        if (!match) {
          return { error: `No upcoming MLB event found matching "${args.team}"` };
        }
        eventId = match.id;
        awayTeam = match.away_team;
        homeTeam = match.home_team;
      }

      // Step 2: Fetch odds for this event
      const oddsUrl = `https://api.the-odds-api.com/v4/sports/baseball_mlb/events/${eventId}/odds/?apiKey=${apiKey}&regions=us,us2,eu&markets=${marketKey}&bookmakers=${DEFAULT_BOOKMAKERS}&oddsFormat=american`;
      const { data: eventData, quota } = await oddsApiFetch(oddsUrl);

      if (!awayTeam) awayTeam = eventData?.away_team || '?';
      if (!homeTeam) homeTeam = eventData?.home_team || '?';

      // Step 3: Flatten bookmakers → flat book/side/price rows
      const books: { book: string; sportsbook: string; side: string; price: number; line: number | null; is_sharp: boolean }[] = [];
      let sharpPrice: number | null = null;

      for (const bm of eventData?.bookmakers || []) {
        const bookName = bm.title || bm.key;
        const isSharp = bm.key === 'pinnacle';

        for (const mkt of bm.markets || []) {
          for (const outcome of mkt.outcomes || []) {
            const row = {
              book: bookName,
              sportsbook: bm.key,
              side: outcome.name,
              price: outcome.price,
              line: outcome.point ?? null,
              is_sharp: isSharp,
            };
            books.push(row);

            // Capture Pinnacle h2h as sharp anchor
            if (isSharp && marketKey === 'h2h') {
              sharpPrice = outcome.price;
            }
          }
        }
      }

      return {
        event_id: eventId,
        market: marketKey === 'h2h' ? 'moneyline' : marketKey,
        market_label: marketKey === 'h2h' ? 'Moneyline' : marketKey === 'spreads' ? 'Run Line' : marketKey === 'totals' ? 'Total' : marketKey,
        event_label: `${awayTeam} @ ${homeTeam}`,
        away_team: awayTeam,
        home_team: homeTeam,
        sharp_price: sharpPrice,
        books,
        book_count: books.length,
        _quota: quota,
      };
    },
    entityType: 'odds',
    renderType: 'odds-board',
    promptHint: 'Single-game MLB odds. Report every price EXACTLY as written. Never invent a book or price not in the payload.',
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
    },
    entityType: 'game',
    renderType: 'game-card',
    promptHint: 'Live/recent scores. Report only scores present. Do not predict outcomes of in-progress games.',
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
    },
    entityType: 'odds',
    renderType: 'odds-board',
    promptHint: 'Single-event deep odds. Report prices exactly. Identify best available per side. Pinnacle is sharp anchor.',
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
      let skippedCount = 0;
      const database = edgeDb;

      // Load all games from Spanner for in-memory mapping
      let games: any[] = [];
      try {
        const [rows] = await withTimeout(database.run({
          sql: 'SELECT EventId, HomeTeamName, AwayTeamName, StartTime FROM MlbGames'
        }));
        games = rows.map((r: any) => r.toJSON());
      } catch (err: any) {
        console.error('[BettingTools] Failed to load MlbGames from Spanner:', err.message);
        return {
          status: 'error',
          message: `Failed to load MlbGames from Spanner: ${err.message}`,
          snapshotTimestamp,
          _quota: quota
        };
      }

      for (const event of events) {
        const eventIdHex = event.id;
        if (!eventIdHex) { skippedCount++; continue; }

        // Resolve external hex ID to canonical ESPN EventId
        const resolvedEventId = findMatchingGame(event, games);
        if (!resolvedEventId) {
          skippedCount++;
          continue;
        }

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
              EventId: resolvedEventId,
              SnapshotId: snapshotId,
              Provider: bookmaker.key,
              SnapshotType: snapshotType,
              OverUnder: overUnder,
              Spread: spread,
              HomeMoneyLine: homeMoneyLine,
              AwayMoneyLine: awayMoneyLine,
              FetchedAt: Spanner.COMMIT_TIMESTAMP,
              CreatedAt: Spanner.COMMIT_TIMESTAMP,
              UpdatedAt: Spanner.COMMIT_TIMESTAMP,
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
          skipped: skippedCount,
          sampleRows: rows.slice(0, 5),
          _quota: quota
        };
      }

      // 3. Write to Spanner via direct upsert
      let written = 0;
      let skipped = skippedCount;
      const errors: string[] = [];

      if (rows.length > 0) {
        try {
          const table = database.table('MlbOddsHistory');
          for (let i = 0; i < rows.length; i += 100) {
            const batch = rows.slice(i, i + 100);
            await withTimeout(table.upsert(batch));
            written += batch.length;
          }
        } catch (err: any) {
          skipped += rows.length;
          errors.push(`Direct upsert failed: ${err.message}`);
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
        ...(errors.length > 0 ? { errors } : {}),
        _quota: quota
      };
    }
  },

  // ═══════════════════════════════════════════════════════════════════
  //  START ODDS BACKFILL — Launch background worker
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "start_odds_backfill",
      description: "Start the background historical odds backfill worker. Walks backward through time fetching snapshots from the Odds API and writing to MlbOddsHistory in Spanner. Quota-aware with automatic pause. Configurable sport, date range, step interval, and snapshot type.",
      schema: z.object({
        sport: z.string().optional().describe("Sport key. Default: baseball_mlb"),
        startDate: z.string().optional().describe("ISO 8601 start date (walks backward from here). Default: now"),
        endDate: z.string().optional().describe("ISO 8601 end date (stop here). Default: 2025-03-01T00:00:00Z (MLB season start)"),
        intervalHours: z.number().optional().describe("Hours between snapshots. Default: 12"),
        snapshotType: z.string().optional().describe("Label for snapshots (e.g., 'open', 'close', 'historical_6h'). Default: 'historical'"),
        markets: z.string().optional().describe("Comma-separated markets. Default: h2h,spreads,totals"),
        pauseBetweenMs: z.number().optional().describe("Milliseconds between API calls (rate limiting). Default: 3000"),
        quotaFloor: z.number().optional().describe("Stop if remaining quota drops below this. Default: 200")
      })
    },
    handler: async (args) => {
      return startBackfill(args);
    }
  },

  // ═══════════════════════════════════════════════════════════════════
  //  STOP ODDS BACKFILL — Abort running worker
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "stop_odds_backfill",
      description: "Stop the running historical odds backfill worker. Safe to call if no worker is running.",
      schema: z.object({})
    },
    handler: async () => {
      return stopBackfill();
    }
  },

  // ═══════════════════════════════════════════════════════════════════
  //  GET BACKFILL STATUS — Check worker progress
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "get_backfill_status",
      description: "Check the status and progress of the historical odds backfill worker. Returns current date being processed, rows written/skipped, quota remaining, and any errors.",
      schema: z.object({})
    },
    handler: async () => {
      return getBackfillStatus();
    }
  },
  {
    definition: {
      name: "get_edge_readout",
      description: "Retrieve the narrative and quantitative edge readout for a specific MLB game using its gamePk / eventId. Returns computed indicators (Steam, Cross-Book, Sharp Lead, COBB basis) and a plain-language summary of any observed market discrepancy, stale-price candidate, or lagging value opportunity.",
      schema: z.object({
        gamePk: z.string().describe("The canonical event ID (e.g. ESPN EventId as a string, e.g. '401570774')")
      })
    },
    handler: async (args) => {
      const gamePk = String(args.gamePk);
      const db = edgeDb;

      // Check if the game itself is simulated (e.g. gamePk starts with "test-")
      const isSimulated = gamePk.startsWith("test-");
      const allowFixtures = process.env.NODE_ENV === "test" || process.env.ALLOW_EDGE_FIXTURES === "true";
      if (isSimulated && !allowFixtures) {
        throw new Error("Access Denied: Simulated games are blocked in production/staging environments.");
      }

      // Attempt to fetch computed edge state
      const [rows] = await withTimeout(db.run({
        sql: `
          SELECT StateJson, ComputedAt
          FROM GameEdgeState
          WHERE GamePk = @gamePk
          ORDER BY ComputedAt DESC
          LIMIT 1
        `,
        params: { gamePk }
      }));

      let resultObj: any;
      if (rows.length === 0) {
        // Compute it live if not yet stored
        const computed = await EdgeEngine.computeEdgeState(gamePk);
        if (!computed) {
          return { error: `No odds or edge data available to compute for game ${gamePk}` };
        }
        resultObj = computed;
      } else {
        const edgeState = rows[0].toJSON();
        resultObj = edgeState.StateJson || {};
        resultObj.computedAt = edgeState.ComputedAt;
      }

      // Enforce the critical production rule and quality gates
      if (resultObj.sourceMeta) {
        assertLiveEdgeSource(resultObj.sourceMeta);
      }
      assertNoPlaceholderLeak(resultObj);

      return {
        eventId: gamePk,
        sourceMode: "live",
        computedAt: resultObj.computedAt || new Date().toISOString(),
        compositeEdge: resultObj.compositeEdge || 0,
        edgeSide: resultObj.edgeSide || "none",
        confidence: resultObj.confidence || "low",
        headline: EdgeEngine.generateHeadline(resultObj),
        summary: EdgeEngine.generateSummary(resultObj),
        warnings: resultObj.warnings || [],
        indicators: {
          steam: { score: resultObj.steamScore || 0 },
          crossBook: resultObj.crossBook || { score: 0, status: "insufficient_books", bookCount: 0 },
          sharpLeadLag: { score: resultObj.sharpLeadLag || 0 },
          fairLineGap: resultObj.fairLineResult || {},
          cobb: resultObj.cobbResult || {}
        },
        edges: resultObj.edges || [],
        sourceMeta: resultObj.sourceMeta || []
      };
    },
    entityType: 'stat',
    renderType: 'stat-card',
    promptHint: 'Edge readout. Report composite edge, confidence, and indicators exactly. Do not invent edge signals not in the payload.',
  },

  // ═══════════════════════════════════════════════════════════════════
  //  TRUTH MULTI-LENS EDGE CARDS
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "get_truth_edge_cards",
      description: "Generate Truth multi-lens edge cards for a specific MLB game. Evaluates both sides of every available market (moneyline, runline, totals, pitcher Ks, batter HRs, batter hits) against the devigged Pinnacle sharp anchor. Returns only cards that pass evidence gates: sharpFairGap required, minimum 2/4 lenses passing, no unsupported claims. Cards include receipts, risk flags, and both-side evaluations for transparency.",
      schema: z.object({
        gamePk: z.string().describe("The event ID for the MLB game (e.g. '401815764')"),
      })
    },
    handler: async (args) => {
      const { getEventFullBoard } = await import("../services/event-full-board");
      const { evaluateFullBoard } = await import("../services/two-way-evaluator");
      const { renderTruthEdgeCard, validateCardNarrative } = await import("../services/truth-card-renderer");

      const board = await getEventFullBoard(args.gamePk);
      const computeTimeMs = Date.now();
      const minutesToFirstPitch = (new Date(board.startTime).getTime() - computeTimeMs) / 60000;

      const evaluations = evaluateFullBoard(board.markets, computeTimeMs, minutesToFirstPitch);
      const eventLabel = `${board.awayTeam} @ ${board.homeTeam}`;
      const cards: any[] = [];

      for (const evaluation of evaluations) {
        const card = renderTruthEdgeCard(evaluation, args.gamePk, eventLabel, board.startTime, false);
        if (!card) continue;

        const violations = validateCardNarrative(card);
        if (violations.length > 0) continue;

        cards.push(card);
      }

      return {
        eventId: args.gamePk,
        eventLabel,
        generatedAt: new Date().toISOString(),
        cards,
        diagnostics: {
          marketsAvailable: board.markets.length,
          unavailableMarkets: board.unavailableMarkets,
          evaluationsRun: evaluations.length,
          candidatesFound: evaluations.filter(e => e.bestCandidate !== null).length,
          cardsEmitted: cards.length,
        },
        quota: board.quota,
      };
    },
    entityType: 'odds',
    renderType: 'odds-board',
    promptHint: 'Truth edge cards. Each card passed evidence gates. Report receipts and risk flags exactly. Do not present filtered-out cards.',
  },
  {
    definition: {
      name: "get_event_full_board",
      description: "Fetch and normalize all available event-level MLB markets from the Odds API for a single game. Returns all bookmaker prices for moneyline, runline, totals, and player props. Also identifies which markets are unavailable (F5, team totals, alternates). Does NOT evaluate edges — use get_truth_edge_cards for that.",
      schema: z.object({
        eventId: z.string().describe("The Odds API event ID for the MLB game"),
      })
    },
    handler: async (args) => {
      const { getEventFullBoard } = await import("../services/event-full-board");
      return getEventFullBoard(args.eventId);
    }
  },
  {
    definition: {
      name: "get_market_relevant_news",
      description: "Fetch market-relevant sports news from ESPN, filtered to only articles that map to active sports events or prediction markets (Kalshi/Polymarket). Returns articles with honest 'whyItMatters' explanations — never claims market movement without proof. Uses ESPN structured categories for entity resolution (teamId/athleteId). Generic, viral, and pure-fantasy articles are suppressed. Use this when the user asks about recent news, injury reports, lineup changes, or availability updates that could affect betting lines.",
      schema: z.object({
        league: z.enum(["mlb", "nba", "nfl", "nhl", "mls"]).optional().describe("League to fetch news for. Defaults to mlb."),
        limit: z.number().optional().describe("Max articles to fetch from ESPN. Defaults to 20, max 50."),
      })
    },
    handler: async (args) => {
      const { fetchEspnNews } = await import("../services/news/espn-news-client");
      const { normalizeArticleBatch } = await import("../services/news/news-normalizer");
      const { buildScorerContext, resolveMatchedGames } = await import("../services/news/news-market-mapper");
      const { scoreAndPartitionArticles } = await import("../services/news/news-signal-scorer");

      const league = (args.league || 'mlb') as any;
      const limit = Math.min(args.limit || 20, 50);

      const espnResponse = await fetchEspnNews(league, limit);
      const normalized = normalizeArticleBatch(espnResponse.articles, league, espnResponse.fetchedAt, espnResponse.sourceMeta.url);
      const { scorerContext, activeGames } = await buildScorerContext();
      const scored = scoreAndPartitionArticles(normalized, scorerContext);

      return {
        feature: 'market_relevant_news',
        league: league.toUpperCase(),
        generatedAt: new Date().toISOString(),
        premiumRail: scored.premium.map(({ article, score }) => ({
          headline: article.headline,
          description: article.description,
          label: score.label,
          whyItMatters: score.whyItMatters,
          availabilityAngle: score.availabilityAngle,
          matchedEvents: resolveMatchedGames(score.matchedTeamIds, activeGames),
          publishedAt: article.publishedAt,
          url: article.url,
          sourceMeta: article.sourceMeta,
        })),
        generalNews: scored.general.map(({ article, score }) => ({
          headline: article.headline,
          label: score.label,
          whyItMatters: score.whyItMatters,
          matchedEvents: resolveMatchedGames(score.matchedTeamIds, activeGames),
          publishedAt: article.publishedAt,
        })),
        emptyState: scored.premium.length === 0 ? {
          message: "No availability or prediction-market-linked news right now. This is normal on a quiet news day.",
          showGeneralInstead: scored.general.length > 0,
        } : null,
        diagnostics: scored.diagnostics,
      };
    }
  },
  {
    definition: {
      name: "get_resolved_pm_markets",
      description: "Fetch all available prediction market contracts (Polymarket, Kalshi) resolved to a specific sports event. Use this to see what outcomes are available to trade on prediction exchanges before checking for edges.",
      schema: z.object({
        eventId: z.string().describe("The event ID of the game to check prediction markets for.")
      })
    },
    handler: async (args) => {
      const port = process.env.PORT || env.PORT || 3000;
      const url = `http://localhost:${port}/api/pm/markets/${args.eventId}`;
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Failed to fetch prediction markets: ${res.statusText}`);
      }
      return await res.json();
    }
  }
];
