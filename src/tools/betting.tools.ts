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

export const bettingTools: RegisteredTool<any>[] = [
  // ═══════════════════════════════════════════════════════════════════
  //  GET LIVE ODDS — Premium Odds API
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "get_live_odds",
      description: "Fetch live, structured betting odds from the premium Odds API. Returns current moneyline, spreads, totals, or player props. Supported markets: h2h, spreads, totals, pitcher_strikeouts, batter_home_runs, batter_hits, pitcher_earned_runs. Player prop markets require the eventId parameter. Pinnacle lines are flagged as sharp anchors.",
      schema: z.object({
        sport: z.string().describe("The sport key (e.g., baseball_mlb, basketball_nba, americanfootball_nfl, soccer_epl)"),
        markets: z.string().optional().describe("Comma-separated list of markets to fetch (e.g., h2h, spreads, totals, pitcher_strikeouts). Default: h2h"),
        regions: z.string().optional().describe("Comma-separated regions to fetch odds for (e.g., us, us2, eu). Default: us,us2,eu"),
        bookmakers: z.string().optional().describe("Comma-separated bookmaker keys (e.g., draftkings,fanduel). Default: all major US books"),
        eventId: z.string().optional().describe("Specific event ID. Required when fetching player prop markets like pitcher_strikeouts.")
      })
    },
    handler: async (args) => {
      const oddsApiKey = process.env.ODDS_API_KEY;
      if (!oddsApiKey) {
        throw new Error("ODDS_API_KEY environment variable is not configured.");
      }

      const sport = args.sport ? String(args.sport) : 'upcoming';
      const markets = args.markets ? String(args.markets) : 'h2h';
      
      // Normalize regions — exclude UK/AU markets
      let regions = args.regions ? String(args.regions) : 'us,us2,eu';
      regions = regions.split(',')
        .map((r: string) => r.trim().toLowerCase())
        .filter((r: string) => r && !['uk', 'au'].includes(r))
        .join(',');
      if (!regions) regions = 'us,us2,eu';

      // Normalize bookmakers with key corrections
      const bookmakersStr = args.bookmakers ? String(args.bookmakers) : DEFAULT_BOOKMAKERS;
      const bookmakers = bookmakersStr.split(',')
        .map((b: string) => b.trim().toLowerCase())
        .map((b: string) => BOOKMAKER_KEY_CORRECTIONS[b] || b)
        .filter((b: string) => b && b !== 'resortsworld')
        .join(',');

      const eventId = args.eventId ? String(args.eventId) : null;

      const url = eventId
        ? `https://api.the-odds-api.com/v4/sports/${sport}/events/${eventId}/odds/?apiKey=${oddsApiKey}&regions=${regions}&markets=${markets}&bookmakers=${bookmakers}&oddsFormat=american`
        : `https://api.the-odds-api.com/v4/sports/${sport}/odds/?apiKey=${oddsApiKey}&regions=${regions}&markets=${markets}&bookmakers=${bookmakers}&oddsFormat=american`;

      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Odds API returned ${res.status}: ${await res.text()}`);
      }

      const data = await res.json();

      // Flag Pinnacle as sharp anchor for EV calculation context
      if (Array.isArray(data)) {
        data.forEach((game: any) => {
          if (Array.isArray(game.bookmakers)) {
            game.bookmakers.forEach((book: any) => {
              if (book.key === 'pinnacle') {
                book.is_sharp_anchor = true;
              }
            });
          }
        });
      }

      return data;
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
      const oddsApiKey = process.env.ODDS_API_KEY;
      if (!oddsApiKey) {
        throw new Error("ODDS_API_KEY environment variable is not configured.");
      }

      const allParam = args.all ? '&all=true' : '';
      const url = `https://api.the-odds-api.com/v4/sports/?apiKey=${oddsApiKey}${allParam}`;

      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Odds API returned ${res.status}: ${await res.text()}`);
      }

      return res.json();
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
      const oddsApiKey = process.env.ODDS_API_KEY;
      if (!oddsApiKey) {
        throw new Error("ODDS_API_KEY environment variable is not configured.");
      }

      const sport = String(args.sport);
      const url = `https://api.the-odds-api.com/v4/sports/${sport}/events/?apiKey=${oddsApiKey}`;

      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Odds API returned ${res.status}: ${await res.text()}`);
      }

      return res.json();
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
      const oddsApiKey = process.env.ODDS_API_KEY;
      if (!oddsApiKey) {
        throw new Error("ODDS_API_KEY environment variable is not configured.");
      }

      const sport = String(args.sport);
      const eventId = String(args.eventId);
      const markets = args.markets ? String(args.markets) : 'h2h,spreads,totals';
      let regions = args.regions ? String(args.regions) : 'us,us2,eu';
      regions = regions.split(',')
        .map((r: string) => r.trim().toLowerCase())
        .filter((r: string) => r && !['uk', 'au'].includes(r))
        .join(',');

      const url = `https://api.the-odds-api.com/v4/sports/${sport}/events/${eventId}/odds/?apiKey=${oddsApiKey}&regions=${regions}&markets=${markets}&bookmakers=${DEFAULT_BOOKMAKERS}&oddsFormat=american`;

      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Odds API returned ${res.status}: ${await res.text()}`);
      }

      const data = await res.json();

      // Flag Pinnacle as sharp anchor
      if (data && Array.isArray(data.bookmakers)) {
        data.bookmakers.forEach((book: any) => {
          if (book.key === 'pinnacle') {
            book.is_sharp_anchor = true;
          }
        });
      }

      return data;
    }
  }
];
