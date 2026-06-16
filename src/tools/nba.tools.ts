import { z } from "zod";
import { RegisteredTool } from "./types";
import { logger } from "../utils/logger";

// ============================================================================
// NBA Stats API Tools
// ────────────────────────────────────────────────────────────────────
// Official NBA Stats API (stats.nba.com) — free, no auth required,
// but REQUIRES browser-like headers (Referer, Origin, User-Agent)
// or the server returns 403.
//
// Provides deep stats, boxscores, standings, player career stats.
// This is the "deep stats" layer complementing ESPN (game context)
// and Odds API (betting lines).
//
// NBA API returns tabular (headers + rowSet) for stats.nba.com/stats
// endpoints, and nested JSON for the v3 scoreboard. All handlers
// flatten into LLM-friendly shapes.
// ============================================================================

const NBA_STATS_BASE = "https://stats.nba.com/stats";

/**
 * Required headers for stats.nba.com — without these the server returns 403.
 */
const NBA_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
  Accept: "application/json",
  Referer: "https://www.nba.com/",
  Origin: "https://www.nba.com",
  "x-nba-stats-origin": "stats",
  "x-nba-stats-token": "true",
};

// ── Helpers ─────────────────────────────────────────────────────────

async function nbaFetch<T = any>(
  url: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 10000;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;

  const res = await fetch(url, {
    signal,
    headers: NBA_HEADERS,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `NBA Stats API returned ${res.status}: ${body.slice(0, 500)}`
    );
  }

  return res.json() as Promise<T>;
}

/**
 * Returns the NBA "season string" for a given year, e.g. 2024 → "2024-25".
 * The NBA season straddles two calendar years (Oct → Jun).
 */
function toNbaSeason(year: number): string {
  const next = (year + 1) % 100;
  return `${year}-${String(next).padStart(2, "0")}`;
}

/**
 * Returns the start-year of the current NBA season based on ET.
 * Before October → previous calendar year. Oct onward → current year.
 */
function getCurrentNbaSeasonYear(): number {
  const etParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "numeric",
  }).formatToParts(new Date());
  const year = Number(etParts.find((p) => p.type === "year")!.value);
  const month = Number(etParts.find((p) => p.type === "month")!.value);
  return month >= 10 ? year : year - 1;
}

/**
 * Resolves natural date intents or YYYY-MM-DD strings based on
 * the America/New_York timezone to avoid date misalignment near
 * UTC midnight in Cloud Run.
 */
function getNbaTargetDate(dateStr?: string): string {
  const formatET = (d: Date) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);

  if (!dateStr) return formatET(new Date());

  const lower = dateStr.toLowerCase().trim();
  if (lower === "today" || lower === "tonight") return formatET(new Date());

  if (lower === "tomorrow") {
    const d = new Date();
    d.setHours(d.getHours() + 24);
    return formatET(d);
  }

  if (lower === "yesterday") {
    const d = new Date();
    d.setHours(d.getHours() - 24);
    return formatET(d);
  }

  // ISO: 2024-03-15
  if (/^\d{4}-\d{2}-\d{2}$/.test(lower)) return lower;

  // Compact: 20240315
  const compact = lower.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;

  // US: 3/15 or 3/15/24
  const us = lower.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (us) {
    const currentYear = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
    }).format(new Date());
    const year = us[3]
      ? us[3].length === 2
        ? `20${us[3]}`
        : us[3]
      : currentYear;
    return `${year}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
  }

  // Fallback: today in ET
  return formatET(new Date());
}

// ── Team Cache ──────────────────────────────────────────────────────

interface NbaTeamCacheEntry {
  teamId: number;
  city: string;
  name: string;
  tricode: string;
  slug: string;
  conference: string;
  division: string;
}

let teamCache: NbaTeamCacheEntry[] | null = null;
let teamCacheLoadedAt = 0;
const TEAM_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

async function ensureTeamCache(
  signal?: AbortSignal
): Promise<NbaTeamCacheEntry[]> {
  const now = Date.now();
  if (teamCache && now - teamCacheLoadedAt < TEAM_CACHE_TTL_MS) {
    return teamCache;
  }

  const season = toNbaSeason(getCurrentNbaSeasonYear());
  const data = await nbaFetch<any>(
    `${NBA_STATS_BASE}/leaguestandingsv3?LeagueID=00&Season=${season}&SeasonType=Regular+Season`,
    { signal, timeoutMs: 10000 }
  );

  const headers: string[] = data.resultSets?.[0]?.headers || [];
  const rows: any[][] = data.resultSets?.[0]?.rowSet || [];

  const idx = (name: string) => headers.indexOf(name);
  const iTeamId = idx("TeamID");
  const iCity = idx("TeamCity");
  const iName = idx("TeamName");
  const iSlug = idx("TeamSlug");
  const iConf = idx("Conference");
  const iDiv = idx("Division");

  teamCache = rows.map((row) => ({
    teamId: row[iTeamId],
    city: row[iCity],
    name: row[iName],
    tricode: "", // will resolve below
    slug: row[iSlug],
    conference: row[iConf],
    division: row[iDiv],
  }));

  // Tricode map — NBA doesn't expose it in standings, so we hardcode the 30
  const tricodeMap: Record<number, string> = {
    1610612737: "ATL", 1610612738: "BOS", 1610612751: "BKN", 1610612766: "CHA",
    1610612741: "CHI", 1610612739: "CLE", 1610612742: "DAL", 1610612743: "DEN",
    1610612765: "DET", 1610612744: "GSW", 1610612745: "HOU", 1610612754: "IND",
    1610612746: "LAC", 1610612747: "LAL", 1610612763: "MEM", 1610612748: "MIA",
    1610612749: "MIL", 1610612750: "MIN", 1610612740: "NOP", 1610612752: "NYK",
    1610612760: "OKC", 1610612753: "ORL", 1610612755: "PHI", 1610612756: "PHX",
    1610612757: "POR", 1610612758: "SAC", 1610612759: "SAS", 1610612761: "TOR",
    1610612762: "UTA", 1610612764: "WAS",
  };

  for (const t of teamCache) {
    t.tricode = tricodeMap[t.teamId] || "";
  }

  teamCacheLoadedAt = Date.now();
  return teamCache;
}

/**
 * Resolves a team name/abbreviation/city to an NBA team ID.
 * Fuzzy matches against city, name, tricode, and slug.
 */
async function resolveTeamId(
  input: string,
  signal?: AbortSignal
): Promise<number | null> {
  const teams = await ensureTeamCache(signal);
  const lower = input.toLowerCase().trim();

  // Exact numeric ID
  const asNum = Number(lower);
  if (Number.isFinite(asNum) && teams.some((t) => t.teamId === asNum))
    return asNum;

  // Exact tricode (e.g. "LAL", "BOS")
  const byTricode = teams.find(
    (t) => t.tricode.toLowerCase() === lower
  );
  if (byTricode) return byTricode.teamId;

  // Exact slug
  const bySlug = teams.find((t) => t.slug === lower);
  if (bySlug) return bySlug.teamId;

  // Fuzzy: city, name, or "city name"
  const byName = teams.find(
    (t) =>
      t.name.toLowerCase() === lower ||
      t.city.toLowerCase() === lower ||
      `${t.city} ${t.name}`.toLowerCase() === lower ||
      lower.includes(t.name.toLowerCase()) ||
      lower.includes(t.slug)
  );
  return byName?.teamId ?? null;
}

// ── Tabular Result Parser ───────────────────────────────────────────

/**
 * Converts NBA stats.nba.com tabular format (headers + rowSet) to
 * an array of keyed objects for LLM readability.
 */
function parseResultSet(
  resultSet: { headers: string[]; rowSet: any[][] },
  limit?: number
): Record<string, any>[] {
  const { headers, rowSet } = resultSet;
  const rows = limit ? rowSet.slice(0, limit) : rowSet;
  return rows.map((row) => {
    const obj: Record<string, any> = {};
    headers.forEach((h, i) => {
      obj[h] = row[i];
    });
    return obj;
  });
}

// ── Tools ───────────────────────────────────────────────────────────

export const nbaTools: RegisteredTool<any>[] = [
  // ═══════════════════════════════════════════════════════════════════
  //  GET NBA SCHEDULE — Day's games with scores & leaders
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "get_nba_schedule",
      description:
        "Get the NBA game schedule for a date from the official NBA Stats API. Returns game IDs, scores, game status (upcoming/live/final), quarter scores, game leaders (points/rebounds/assists), and broadcasters. Use this first to find gameIds, then pass to get_nba_boxscore for full player-level stats. Optionally filter by team.",
      schema: z.object({
        date: z
          .string()
          .optional()
          .describe(
            "Date in YYYY-MM-DD or natural language like 'today', 'tomorrow', 'yesterday'. Default: today"
          ),
        team: z
          .string()
          .optional()
          .describe(
            "Team name, abbreviation, or ID to filter by (e.g., 'Lakers', 'LAL', 'Boston')"
          ),
      }),
    },
    handler: async (args, context) => {
      const formattedDate = getNbaTargetDate(args.date);

      let filterTeamId: number | null = null;
      if (args.team) {
        filterTeamId = await resolveTeamId(args.team, context.signal);
      }

      const url = `${NBA_STATS_BASE}/scoreboardv3?GameDate=${formattedDate}&LeagueID=00`;
      const data = await nbaFetch<any>(url, {
        signal: context.signal,
        timeoutMs: 10000,
      });

      let games = (data.scoreboard?.games || []).map((g: any) => {
        const home = g.homeTeam;
        const away = g.awayTeam;

        return {
          gameId: g.gameId,
          matchup: `${away?.teamCity || ""} ${away?.teamName || "?"} @ ${home?.teamCity || ""} ${home?.teamName || "?"}`,
          status: g.gameStatus === 1 ? "upcoming" : g.gameStatus === 2 ? "live" : "final",
          status_text: g.gameStatusText,
          game_time_utc: g.gameTimeUTC,
          game_time_et: g.gameEt,
          period: g.period,
          game_clock: g.gameClock || null,
          series_text: g.seriesText || null,
          home_team: {
            id: home?.teamId,
            name: `${home?.teamCity || ""} ${home?.teamName || ""}`.trim(),
            tricode: home?.teamTricode,
            record: `${home?.wins}-${home?.losses}`,
            score: home?.score ?? 0,
            seed: home?.seed || null,
            quarters: (home?.periods || []).map((p: any) => ({
              period: p.period,
              score: p.score,
            })),
          },
          away_team: {
            id: away?.teamId,
            name: `${away?.teamCity || ""} ${away?.teamName || ""}`.trim(),
            tricode: away?.teamTricode,
            record: `${away?.wins}-${away?.losses}`,
            score: away?.score ?? 0,
            seed: away?.seed || null,
            quarters: (away?.periods || []).map((p: any) => ({
              period: p.period,
              score: p.score,
            })),
          },
          game_leaders: g.gameLeaders
            ? {
                home: g.gameLeaders.homeLeaders
                  ? {
                      name: g.gameLeaders.homeLeaders.name,
                      position: g.gameLeaders.homeLeaders.position,
                      points: g.gameLeaders.homeLeaders.points,
                      rebounds: g.gameLeaders.homeLeaders.rebounds,
                      assists: g.gameLeaders.homeLeaders.assists,
                    }
                  : null,
                away: g.gameLeaders.awayLeaders
                  ? {
                      name: g.gameLeaders.awayLeaders.name,
                      position: g.gameLeaders.awayLeaders.position,
                      points: g.gameLeaders.awayLeaders.points,
                      rebounds: g.gameLeaders.awayLeaders.rebounds,
                      assists: g.gameLeaders.awayLeaders.assists,
                    }
                  : null,
              }
            : null,
        };
      });

      // Apply team filter
      if (filterTeamId) {
        games = games.filter(
          (g: any) =>
            g.home_team.id === filterTeamId ||
            g.away_team.id === filterTeamId
        );
      }

      return {
        date: formattedDate,
        total_games: games.length,
        live: games.filter((g: any) => g.status === "live").length,
        final: games.filter((g: any) => g.status === "final").length,
        upcoming: games.filter((g: any) => g.status === "upcoming").length,
        games,
      };
    },
  },

  // ═══════════════════════════════════════════════════════════════════
  //  GET NBA BOXSCORE — Full player-level boxscore
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "get_nba_boxscore",
      description:
        "Get the full boxscore for a specific NBA game. Returns every player's minutes, points, rebounds, assists, steals, blocks, turnovers, FG/3PT/FT shooting splits, and plus-minus. Includes team totals. The gameId can be found using get_nba_schedule.",
      schema: z.object({
        gameId: z
          .string()
          .regex(/^\d{10}$/, "Must be a 10-digit NBA game ID")
          .describe(
            "The 10-digit NBA game ID from get_nba_schedule (e.g., '0022300944')"
          ),
      }),
    },
    handler: async (args, context) => {
      const data = await nbaFetch<any>(
        `${NBA_STATS_BASE}/boxscoretraditionalv3?GameID=${args.gameId}&LeagueID=00`,
        { signal: context.signal, timeoutMs: 10000 }
      );

      const bs = data.boxScoreTraditional;
      if (!bs) {
        return { error: `No boxscore data found for game ${args.gameId}.` };
      }

      const mapPlayer = (p: any) => {
        const s = p.statistics || {};
        return {
          name: `${p.firstName} ${p.familyName}`,
          position: p.position || "?",
          minutes: s.minutes || "0:00",
          points: s.points ?? 0,
          rebounds: s.reboundsTotal ?? 0,
          assists: s.assists ?? 0,
          steals: s.steals ?? 0,
          blocks: s.blocks ?? 0,
          turnovers: s.turnovers ?? 0,
          fg: `${s.fieldGoalsMade ?? 0}-${s.fieldGoalsAttempted ?? 0}`,
          fg_pct: s.fieldGoalsPercentage ?? 0,
          three_pt: `${s.threePointersMade ?? 0}-${s.threePointersAttempted ?? 0}`,
          three_pct: s.threePointersPercentage ?? 0,
          ft: `${s.freeThrowsMade ?? 0}-${s.freeThrowsAttempted ?? 0}`,
          ft_pct: s.freeThrowsPercentage ?? 0,
          plus_minus: s.plusMinusPoints ?? 0,
          fouls: s.foulsPersonal ?? 0,
        };
      };

      const mapAggStats = (agg: any) => {
        if (!agg || typeof agg !== "object") return null;
        return {
          points: agg.points ?? 0,
          rebounds: agg.reboundsTotal ?? 0,
          assists: agg.assists ?? 0,
          fg_pct: agg.fieldGoalsPercentage ?? 0,
          three_pct: agg.threePointersPercentage ?? 0,
          ft_pct: agg.freeThrowsPercentage ?? 0,
        };
      };

      const mapTeam = (team: any) => {
        const allPlayers = (team.players || []).map(mapPlayer);
        // NBA boxscore lists starters first (first 5), rest are bench
        const starters = allPlayers.slice(0, 5);
        const bench = allPlayers.slice(5);

        return {
          name: `${team.teamCity || ""} ${team.teamName || ""}`.trim(),
          tricode: team.teamTricode,
          team_totals: mapAggStats(team.statistics),
          starter_totals: mapAggStats(team.starters),
          bench_totals: mapAggStats(team.bench),
          starters,
          bench,
        };
      };

      return {
        gameId: args.gameId,
        matchup: `${bs.awayTeam?.teamCity || ""} ${bs.awayTeam?.teamName || "?"} @ ${bs.homeTeam?.teamCity || ""} ${bs.homeTeam?.teamName || "?"}`,
        home_team: mapTeam(bs.homeTeam),
        away_team: mapTeam(bs.awayTeam),
      };
    },
  },

  // ═══════════════════════════════════════════════════════════════════
  //  GET NBA STANDINGS — Conference / Division standings
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "get_nba_standings",
      description:
        "Get current NBA standings from the official Stats API. Returns all 30 teams with win-loss records, winning percentage, conference rank, home/road records, last 10, current streak, and points per game. Optionally filter by conference (East/West).",
      schema: z.object({
        season: z
          .number()
          .int()
          .min(1946)
          .max(new Date().getFullYear() + 1)
          .optional()
          .describe(
            "Season start year (e.g. 2024 for the 2024-25 season). Default: current season"
          ),
        conference: z
          .enum(["East", "West", "all"])
          .optional()
          .describe(
            "Filter by conference: 'East', 'West', or 'all'. Default: all"
          ),
      }),
    },
    handler: async (args, context) => {
      const seasonYear = args.season || getCurrentNbaSeasonYear();
      const season = toNbaSeason(seasonYear);

      const data = await nbaFetch<any>(
        `${NBA_STATS_BASE}/leaguestandingsv3?LeagueID=00&Season=${season}&SeasonType=Regular+Season`,
        { signal: context.signal, timeoutMs: 10000 }
      );

      const headers: string[] = data.resultSets?.[0]?.headers || [];
      const rows: any[][] = data.resultSets?.[0]?.rowSet || [];

      const idx = (name: string) => headers.indexOf(name);

      let teams = rows.map((row) => ({
        team_id: row[idx("TeamID")],
        team: `${row[idx("TeamCity")]} ${row[idx("TeamName")]}`,
        tricode: "", // resolved below
        conference: row[idx("Conference")] as string,
        division: row[idx("Division")] as string,
        wins: row[idx("WINS")] as number,
        losses: row[idx("LOSSES")] as number,
        win_pct: row[idx("WinPCT")],
        conference_rank: row[idx("PlayoffRank")],
        clinch: (row[idx("ClinchIndicator")] || "").trim(),
        home: row[idx("HOME")],
        road: row[idx("ROAD")],
        last_10: row[idx("L10")],
        streak: row[idx("strCurrentStreak")],
        ppg: row[idx("PointsPG")],
        opp_ppg: row[idx("OppPointsPG")],
        diff: row[idx("DiffPointsPG")],
      }));

      // Resolve tricodes
      const cache = await ensureTeamCache(context.signal);
      for (const t of teams) {
        const cached = cache.find((c) => c.teamId === t.team_id);
        if (cached) t.tricode = cached.tricode;
      }

      // Filter by conference
      if (args.conference && args.conference !== "all") {
        teams = teams.filter((t) => t.conference === args.conference);
      }

      // Group by conference
      const east = teams
        .filter((t) => t.conference === "East")
        .sort((a, b) => a.conference_rank - b.conference_rank);
      const west = teams
        .filter((t) => t.conference === "West")
        .sort((a, b) => a.conference_rank - b.conference_rank);

      return {
        season,
        total_teams: teams.length,
        standings:
          args.conference === "East"
            ? { East: east }
            : args.conference === "West"
              ? { West: west }
              : { East: east, West: west },
      };
    },
  },

  // ═══════════════════════════════════════════════════════════════════
  //  GET NBA PLAYER STATS — Season/career stats for a player
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "get_nba_player_stats",
      description:
        "Get season or career statistics for a specific NBA player by player ID. Returns per-game averages including points, rebounds, assists, steals, blocks, shooting splits (FG%, 3P%, FT%), and games played. Use search_nba_player first to find the player ID.",
      schema: z.object({
        playerId: z
          .number()
          .int()
          .positive()
          .describe("The NBA player ID from search_nba_player"),
        season: z
          .number()
          .int()
          .min(1946)
          .max(new Date().getFullYear() + 1)
          .optional()
          .describe(
            "Season start year (e.g. 2024 for 2024-25). Default: latest available season"
          ),
      }),
    },
    handler: async (args, context) => {
      const data = await nbaFetch<any>(
        `${NBA_STATS_BASE}/playercareerstats?PerMode=PerGame&PlayerID=${args.playerId}&LeagueID=00`,
        { signal: context.signal, timeoutMs: 10000 }
      );

      const rs = data.resultSets?.[0];
      if (!rs || !rs.rowSet?.length) {
        return {
          error: `No stats found for player ID ${args.playerId}.`,
        };
      }

      const headers: string[] = rs.headers;
      const idx = (name: string) => headers.indexOf(name);

      // Parse all seasons
      const allSeasons = rs.rowSet.map((row: any[]) => ({
        season: row[idx("SEASON_ID")],
        team: row[idx("TEAM_ABBREVIATION")],
        age: row[idx("PLAYER_AGE")],
        games: row[idx("GP")],
        starts: row[idx("GS")],
        mpg: row[idx("MIN")],
        ppg: row[idx("PTS")],
        rpg: row[idx("REB")],
        apg: row[idx("AST")],
        spg: row[idx("STL")],
        bpg: row[idx("BLK")],
        topg: row[idx("TOV")],
        fg_pct: row[idx("FG_PCT")],
        three_pct: row[idx("FG3_PCT")],
        ft_pct: row[idx("FT_PCT")],
      }));

      // Find requested season or default to latest
      let targetSeason = allSeasons[allSeasons.length - 1];
      if (args.season) {
        const seasonStr = toNbaSeason(args.season);
        const found = allSeasons.find(
          (s: any) => s.season === seasonStr
        );
        if (found) targetSeason = found;
      }

      // Career averages (last resultSet)
      const careerRs = data.resultSets?.find(
        (r: any) => r.name === "CareerTotalsRegularSeason"
      );
      let career = null;
      if (careerRs?.rowSet?.[0]) {
        const cHeaders: string[] = careerRs.headers;
        const cIdx = (name: string) => cHeaders.indexOf(name);
        const row = careerRs.rowSet[0];
        career = {
          games: row[cIdx("GP")],
          ppg: row[cIdx("PTS")],
          rpg: row[cIdx("REB")],
          apg: row[cIdx("AST")],
          fg_pct: row[cIdx("FG_PCT")],
        };
      }

      return {
        player_id: args.playerId,
        current_season: targetSeason,
        career_averages: career,
        all_seasons: allSeasons,
      };
    },
  },

  // ═══════════════════════════════════════════════════════════════════
  //  SEARCH NBA PLAYER — Name-based player search
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "search_nba_player",
      description:
        "Search for an NBA player by name. Returns matching player IDs, teams, positions, height, weight, and season averages (PTS, REB, AST). Use the returned player ID with get_nba_player_stats to fetch detailed statistics.",
      schema: z.object({
        name: z
          .string()
          .min(1)
          .describe(
            "Player name to search for (e.g., 'LeBron', 'Jokic', 'Luka Doncic')"
          ),
        season: z
          .number()
          .int()
          .min(1946)
          .max(new Date().getFullYear() + 1)
          .optional()
          .describe(
            "Season start year for the player index. Default: current season"
          ),
      }),
    },
    handler: async (args, context) => {
      const seasonYear = args.season || getCurrentNbaSeasonYear();
      const season = toNbaSeason(seasonYear);

      const data = await nbaFetch<any>(
        `${NBA_STATS_BASE}/playerindex?LeagueID=00&Season=${season}&Active=1`,
        { signal: context.signal, timeoutMs: 10000 }
      );

      const rs = data.resultSets?.[0];
      if (!rs) {
        return { error: "Failed to fetch player index." };
      }

      const headers: string[] = rs.headers;
      const idx = (name: string) => headers.indexOf(name);

      const queryLower = args.name.toLowerCase().trim();
      const queryParts = queryLower.split(/\s+/);

      // Filter matching players
      const matches = (rs.rowSet || [])
        .filter((row: any[]) => {
          const first = (row[idx("PLAYER_FIRST_NAME")] || "").toLowerCase();
          const last = (row[idx("PLAYER_LAST_NAME")] || "").toLowerCase();
          const full = `${first} ${last}`;
          const slug = (row[idx("PLAYER_SLUG")] || "").toLowerCase();

          // Match if query is substring of full name, or all query parts match
          return (
            full.includes(queryLower) ||
            slug.includes(queryLower.replace(/\s+/g, "-")) ||
            queryParts.every(
              (part) => first.includes(part) || last.includes(part)
            )
          );
        })
        .slice(0, 10)
        .map((row: any[]) => ({
          id: row[idx("PERSON_ID")],
          name: `${row[idx("PLAYER_FIRST_NAME")]} ${row[idx("PLAYER_LAST_NAME")]}`,
          team: `${row[idx("TEAM_CITY")] || ""} ${row[idx("TEAM_NAME")] || ""}`.trim() || "Unknown",
          tricode: row[idx("TEAM_ABBREVIATION")] || "?",
          position: row[idx("POSITION")] || "?",
          number: row[idx("JERSEY_NUMBER")] || "?",
          height: row[idx("HEIGHT")] || "?",
          weight: row[idx("WEIGHT")] || "?",
          season_avg: {
            ppg: row[idx("PTS")],
            rpg: row[idx("REB")],
            apg: row[idx("AST")],
          },
        }));

      if (matches.length === 0) {
        return {
          message: `No active NBA players found matching '${args.name}' in ${season}.`,
          suggestion:
            "Try using just the last name, check spelling, or adjust the season year.",
        };
      }

      return {
        results: matches.length,
        season,
        players: matches,
      };
    },
  },

  // ═══════════════════════════════════════════════════════════════════
  //  GET NBA TEAMS — All 30 teams with IDs
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "get_nba_teams",
      description:
        "Get all 30 NBA teams with their IDs, abbreviations, conferences, divisions, and current season records. Use this to resolve team names to IDs for other tools, or to browse the full team list.",
      schema: z.object({}),
    },
    handler: async (_args, context) => {
      const teams = await ensureTeamCache(context.signal);

      // Group by conference → division
      const grouped: Record<string, Record<string, NbaTeamCacheEntry[]>> = {};
      for (const t of teams) {
        if (!grouped[t.conference]) grouped[t.conference] = {};
        if (!grouped[t.conference][t.division])
          grouped[t.conference][t.division] = [];
        grouped[t.conference][t.division].push(t);
      }

      const formatted: Record<string, Record<string, any[]>> = {};
      for (const [conf, divs] of Object.entries(grouped)) {
        formatted[conf] = {};
        for (const [div, teamList] of Object.entries(divs)) {
          formatted[conf][div] = teamList.map((t) => ({
            id: t.teamId,
            name: `${t.city} ${t.name}`,
            tricode: t.tricode,
            slug: t.slug,
          }));
        }
      }

      return {
        total_teams: teams.length,
        teams_by_conference: formatted,
      };
    },
  },

  // ═══════════════════════════════════════════════════════════════════
  //  GET NBA GAME LEADERS — Top performers for a date
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "get_nba_game_leaders",
      description:
        "Get the top statistical performers across all NBA games on a given date. Returns game leaders (points, rebounds, assists) for each game. Useful for 'who had the best game tonight', 'top scorers today', or daily stat recaps.",
      schema: z.object({
        date: z
          .string()
          .optional()
          .describe("Date in YYYY-MM-DD or natural language. Default: today"),
      }),
    },
    handler: async (args, context) => {
      const formattedDate = getNbaTargetDate(args.date);

      const data = await nbaFetch<any>(
        `${NBA_STATS_BASE}/scoreboardv3?GameDate=${formattedDate}&LeagueID=00`,
        { signal: context.signal, timeoutMs: 10000 }
      );

      const games = data.scoreboard?.games || [];

      if (games.length === 0) {
        return {
          date: formattedDate,
          message: "No NBA games found on this date.",
        };
      }

      // Collect all game leaders
      const leaders: any[] = [];

      for (const g of games) {
        const matchup = `${g.awayTeam?.teamCity || ""} ${g.awayTeam?.teamName || "?"} @ ${g.homeTeam?.teamCity || ""} ${g.homeTeam?.teamName || "?"}`;
        const statusText = g.gameStatusText;

        if (g.gameLeaders?.homeLeaders) {
          const l = g.gameLeaders.homeLeaders;
          leaders.push({
            name: l.name,
            team: l.teamTricode,
            position: l.position,
            points: l.points,
            rebounds: l.rebounds,
            assists: l.assists,
            game: matchup,
            game_status: statusText,
          });
        }
        if (g.gameLeaders?.awayLeaders) {
          const l = g.gameLeaders.awayLeaders;
          leaders.push({
            name: l.name,
            team: l.teamTricode,
            position: l.position,
            points: l.points,
            rebounds: l.rebounds,
            assists: l.assists,
            game: matchup,
            game_status: statusText,
          });
        }
      }

      // Sort by points descending
      leaders.sort((a, b) => b.points - a.points);

      return {
        date: formattedDate,
        total_games: games.length,
        total_leaders: leaders.length,
        top_scorer: leaders[0] || null,
        leaders,
      };
    },
  },

  // ═══════════════════════════════════════════════════════════════════
  //  GET NBA PLAYOFF BRACKET — Full playoff tree with series scores
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "get_nba_playoff_bracket",
      description:
        "Get the full NBA playoff bracket for a season. Returns every playoff series organized by round (First Round, Conference Semis, Conference Finals, NBA Finals) with matchups, series scores (e.g., 'NY wins series 4-1'), and per-team wins. Use this to see the complete playoff picture instantly instead of checking individual game schedules.",
      schema: z.object({
        season: z
          .number()
          .int()
          .min(2000)
          .max(new Date().getFullYear() + 1)
          .optional()
          .describe(
            "Season start year (e.g. 2025 for the 2025-26 season). Default: current season"
          ),
      }),
    },
    handler: async (args, context) => {
      const seasonYear = args.season || getCurrentNbaSeasonYear();
      const season = toNbaSeason(seasonYear);

      // NBA playoffs run Apr-Jun of the season's second year
      const playoffYear = seasonYear + 1;
      const dateFrom = `${playoffYear}0401`;
      const dateTo = `${playoffYear}0630`;

      // Single ESPN call — fetches ALL playoff games in the date range
      const espnUrl =
        `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard` +
        `?dates=${dateFrom}-${dateTo}&limit=200`;

      const timeoutMs = 10000;
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = context.signal
        ? AbortSignal.any([context.signal, timeoutSignal])
        : timeoutSignal;

      const res = await fetch(espnUrl, {
        signal,
        headers: { Accept: "application/json" },
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `ESPN API returned ${res.status}: ${body.slice(0, 500)}`
        );
      }

      const data = await res.json() as any;
      const events = data.events || [];

      if (events.length === 0) {
        return {
          season,
          message: `No playoff games found for the ${season} season.`,
        };
      }

      // Group by series: use sorted team IDs + round as key
      // Keep only the latest (most recent) game per series for current status
      const seriesMap = new Map<string, any>();

      for (const event of events) {
        const comp = event.competitions?.[0];
        const seriesSummary = comp?.series?.summary;
        const noteHeadline = comp?.notes?.[0]?.headline;

        if (!seriesSummary || !noteHeadline) continue;

        // Extract round from note: "NBA Finals - Game 4" → "NBA Finals"
        const roundMatch = noteHeadline.match(
          /^(.+?)\s*-\s*Game\s+\d+$/
        );
        const round = roundMatch ? roundMatch[1].trim() : noteHeadline;

        // Build team info from competitors
        const competitors = comp.competitors || [];
        const teams = competitors.map((c: any) => ({
          id: c.id,
          name: c.team?.displayName || c.team?.name || "?",
          abbrev: c.team?.abbreviation || "?",
          score: parseInt(c.score) || 0,
          winner: c.winner || false,
          homeAway: c.homeAway,
        }));

        // Stable key: sorted team IDs + round
        const teamIds = teams
          .map((t: any) => t.id)
          .sort()
          .join("-");
        const key = `${round}_${teamIds}`;

        // Series competitor wins
        const seriesCompetitors = (comp.series?.competitors || []).map(
          (sc: any) => ({
            espn_id: sc.id,
            wins: sc.wins ?? 0,
          })
        );

        // Always overwrite — events are chronological, so latest wins
        seriesMap.set(key, {
          round,
          matchup: event.shortName,
          series_status: seriesSummary,
          game_note: noteHeadline,
          completed: comp.series?.completed || false,
          teams,
          series_competitors: seriesCompetitors,
        });
      }

      if (seriesMap.size === 0) {
        return {
          season,
          message: `No playoff series data found for the ${season} season.`,
        };
      }

      // Define round ordering
      const roundOrder: Record<string, number> = {
        "East 1st Round": 1,
        "West 1st Round": 1,
        "East Semifinals": 2,
        "West Semifinals": 2,
        "Eastern Conf Semifinals": 2,
        "Western Conf Semifinals": 2,
        "East Finals": 3,
        "West Finals": 3,
        "Eastern Conf Finals": 3,
        "Western Conf Finals": 3,
        "NBA Finals": 4,
      };

      // Build bracket grouped by round
      const allSeries = Array.from(seriesMap.values());
      allSeries.sort(
        (a, b) =>
          (roundOrder[a.round] ?? 5) - (roundOrder[b.round] ?? 5)
      );

      const bracket: Record<string, any[]> = {};
      for (const s of allSeries) {
        if (!bracket[s.round]) bracket[s.round] = [];

        // Map team data
        const teamA = s.teams[0];
        const teamB = s.teams[1];

        // Find wins from series competitors
        const winsA =
          s.series_competitors.find(
            (sc: any) => sc.espn_id === teamA?.id
          )?.wins ?? null;
        const winsB =
          s.series_competitors.find(
            (sc: any) => sc.espn_id === teamB?.id
          )?.wins ?? null;

        bracket[s.round].push({
          matchup: s.matchup,
          series_status: s.series_status,
          completed: s.completed,
          team_a: {
            name: teamA?.name || "?",
            abbrev: teamA?.abbrev || "?",
            wins: winsA,
          },
          team_b: {
            name: teamB?.name || "?",
            abbrev: teamB?.abbrev || "?",
            wins: winsB,
          },
        });
      }

      return {
        season,
        total_series: seriesMap.size,
        total_playoff_games: events.filter(
          (e: any) => e.competitions?.[0]?.series?.summary
        ).length,
        bracket,
      };
    },
  },
];
