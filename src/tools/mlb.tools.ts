import { z } from "zod";
import { RegisteredTool } from "./types";

// ============================================================================
// MLB Stats API Tools
// ────────────────────────────────────────────────────────────────────
// Official MLB Stats API (statsapi.mlb.com) — free, no auth required.
// Provides deep stats, play-by-play, boxscores, standings, rosters.
// This is the "deep stats" layer complementing ESPN (game context)
// and Odds API (betting lines).
//
// API responses are deeply nested (100KB+ per game). All handlers
// flatten and simplify the data into LLM-friendly shapes.
// ============================================================================

const MLB_API_BASE = "https://statsapi.mlb.com/api/v1";
const MLB_API_V11 = "https://statsapi.mlb.com/api/v1.1";

// ── Helpers ─────────────────────────────────────────────────────────

async function mlbFetch<T = any>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`MLB Stats API returned ${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

/**
 * In-memory cache for team name → ID resolution.
 * Loaded once per process from /api/v1/teams.
 */
let teamCache: { id: number; name: string; abbreviation: string; teamName: string }[] | null = null;

async function ensureTeamCache(): Promise<typeof teamCache> {
  if (teamCache) return teamCache;
  const data = await mlbFetch<any>(`${MLB_API_BASE}/teams?sportId=1`);
  teamCache = (data.teams || []).map((t: any) => ({
    id: t.id,
    name: t.name,
    abbreviation: t.abbreviation,
    teamName: t.teamName,
  }));
  return teamCache!;
}

/**
 * Resolves a team name/abbreviation to an MLB team ID.
 * Fuzzy matches against full name, nickname, and abbreviation.
 */
async function resolveTeamId(input: string): Promise<number | null> {
  const teams = await ensureTeamCache();
  if (!teams) return null;
  const lower = input.toLowerCase().trim();

  // Exact ID
  const asNum = Number(lower);
  if (Number.isFinite(asNum) && teams.some(t => t.id === asNum)) return asNum;

  // Exact abbreviation
  const byAbbr = teams.find(t => t.abbreviation.toLowerCase() === lower);
  if (byAbbr) return byAbbr.id;

  // Fuzzy name match (nickname or full name)
  const byName = teams.find(t =>
    t.name.toLowerCase().includes(lower) ||
    t.teamName.toLowerCase().includes(lower) ||
    lower.includes(t.teamName.toLowerCase())
  );
  return byName?.id ?? null;
}

// ── Normalization Shapes ────────────────────────────────────────────

interface NormalizedPlay {
  inning: number;
  half: string;
  at_bat_index: number;
  batter: string;
  pitcher: string;
  result: string;
  description: string;
  rbi: number;
  is_scoring_play: boolean;
  count?: string;
}

interface NormalizedLinescore {
  innings: { num: number; away_runs: number; home_runs: number }[];
  totals: {
    away: { runs: number; hits: number; errors: number };
    home: { runs: number; hits: number; errors: number };
  };
  current_inning?: number;
  inning_half?: string;
}

interface NormalizedStanding {
  division: string;
  teams: {
    name: string;
    wins: number;
    losses: number;
    pct: string;
    games_back: string;
    streak: string;
    last_10: string;
  }[];
}

interface NormalizedRosterEntry {
  name: string;
  number: string;
  position: string;
  bats_throws: string;
  status: string;
}

interface NormalizedPlayerStats {
  name: string;
  team: string;
  position: string;
  stats: Record<string, any>;
}

// ── Tools ───────────────────────────────────────────────────────────

export const mlbTools: RegisteredTool<any>[] = [
  // ═══════════════════════════════════════════════════════════════════
  //  GET MLB SCHEDULE — Day's games with gamePk IDs
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "get_mlb_schedule",
      description: "Get the MLB game schedule for a date from the official MLB Stats API. Returns game IDs (gamePk) needed for play-by-play, boxscores, and other deep stats tools. Use this first to find the gamePk, then pass it to get_mlb_play_by_play or get_mlb_boxscore. Optionally filter by team.",
      schema: z.object({
        date: z.string().optional().describe("Date in YYYY-MM-DD format. Default: today"),
        team: z.string().optional().describe("Team name, abbreviation, or ID to filter by (e.g., 'Yankees', 'NYY', '147')"),
      })
    },
    handler: async (args) => {
      const date = args.date || new Date().toISOString().split("T")[0];
      let teamId: number | null = null;
      if (args.team) {
        teamId = await resolveTeamId(args.team);
      }

      const teamParam = teamId ? `&teamId=${teamId}` : "";
      const data = await mlbFetch<any>(`${MLB_API_BASE}/schedule?sportId=1&date=${date}${teamParam}`);

      const games = (data.dates?.[0]?.games || []).map((g: any) => {
        const away = g.teams?.away;
        const home = g.teams?.home;
        return {
          gamePk: g.gamePk,
          matchup: `${away?.team?.name || "?"} @ ${home?.team?.name || "?"}`,
          status: g.status?.detailedState,
          game_time: g.gameDate,
          away_team: { name: away?.team?.name, id: away?.team?.id, record: `${away?.leagueRecord?.wins}-${away?.leagueRecord?.losses}`, score: away?.score },
          home_team: { name: home?.team?.name, id: home?.team?.id, record: `${home?.leagueRecord?.wins}-${home?.leagueRecord?.losses}`, score: home?.score },
          venue: g.venue?.name,
        };
      });

      return {
        date,
        total_games: games.length,
        in_progress: games.filter((g: any) => g.status === "In Progress").length,
        games,
      };
    }
  },

  // ═══════════════════════════════════════════════════════════════════
  //  GET MLB PLAY-BY-PLAY — Live play-by-play feed
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "get_mlb_play_by_play",
      description: "Get play-by-play data for a specific MLB game. Returns individual at-bat results, scoring plays, and current game state. The gamePk can be found using get_mlb_schedule. By default returns the last 15 plays to keep context manageable; use lastN to adjust. Set scoringOnly=true to see only scoring plays.",
      schema: z.object({
        gamePk: z.number().describe("The MLB game ID (gamePk) from get_mlb_schedule"),
        lastN: z.number().optional().describe("Number of most recent plays to return. Default: 15. Use 0 or a large number for all plays."),
        scoringOnly: z.boolean().optional().describe("If true, return only scoring plays. Default: false"),
      })
    },
    handler: async (args) => {
      const data = await mlbFetch<any>(`${MLB_API_V11}/game/${args.gamePk}/feed/live`);
      const plays = data.liveData?.plays;
      const gameData = data.gameData;
      const allPlays: any[] = plays?.allPlays || [];
      const lastN = args.lastN ?? 15;

      // Normalize plays
      let normalized: NormalizedPlay[] = allPlays.map((p: any) => ({
        inning: p.about?.inning,
        half: p.about?.halfInning,
        at_bat_index: p.atBatIndex,
        batter: p.matchup?.batter?.fullName || "Unknown",
        pitcher: p.matchup?.pitcher?.fullName || "Unknown",
        result: p.result?.event || "",
        description: p.result?.description || "",
        rbi: p.result?.rbi || 0,
        is_scoring_play: p.about?.isScoringPlay || false,
        count: p.count ? `${p.count.balls}-${p.count.strikes}` : undefined,
      }));

      // Filter scoring only
      if (args.scoringOnly) {
        normalized = normalized.filter(p => p.is_scoring_play);
      }

      // Truncate to last N
      const total = normalized.length;
      if (lastN > 0 && normalized.length > lastN) {
        normalized = normalized.slice(-lastN);
      }

      // Current game state
      const currentPlay = plays?.currentPlay;
      const status = gameData?.status;

      return {
        gamePk: args.gamePk,
        matchup: `${gameData?.teams?.away?.name || "?"} @ ${gameData?.teams?.home?.name || "?"}`,
        status: status?.detailedState,
        total_plays: allPlays.length,
        showing: normalized.length,
        showing_label: args.scoringOnly ? "scoring plays only" : `last ${normalized.length} of ${total}`,
        current_play: currentPlay ? {
          batter: currentPlay.matchup?.batter?.fullName,
          pitcher: currentPlay.matchup?.pitcher?.fullName,
          count: currentPlay.count ? `${currentPlay.count.balls}-${currentPlay.count.strikes}, ${currentPlay.count.outs} out` : undefined,
          result: currentPlay.result?.description,
        } : null,
        plays: normalized,
      };
    }
  },

  // ═══════════════════════════════════════════════════════════════════
  //  GET MLB BOXSCORE — Linescore + top performers
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "get_mlb_boxscore",
      description: "Get the boxscore and linescore for a specific MLB game. Returns runs/hits/errors by inning, final totals, and top performers. The gamePk can be found using get_mlb_schedule. Use for detailed game summaries and statistical breakdowns.",
      schema: z.object({
        gamePk: z.number().describe("The MLB game ID (gamePk) from get_mlb_schedule"),
      })
    },
    handler: async (args) => {
      const data = await mlbFetch<any>(`${MLB_API_V11}/game/${args.gamePk}/feed/live`);
      const linescore = data.liveData?.linescore;
      const boxscore = data.liveData?.boxscore;
      const gameData = data.gameData;
      const status = gameData?.status;

      // Normalize linescore
      const innings = (linescore?.innings || []).map((inn: any) => ({
        num: inn.num,
        away_runs: inn.away?.runs ?? 0,
        home_runs: inn.home?.runs ?? 0,
      }));

      const normalizedLinescore: NormalizedLinescore = {
        innings,
        totals: {
          away: {
            runs: linescore?.teams?.away?.runs ?? 0,
            hits: linescore?.teams?.away?.hits ?? 0,
            errors: linescore?.teams?.away?.errors ?? 0,
          },
          home: {
            runs: linescore?.teams?.home?.runs ?? 0,
            hits: linescore?.teams?.home?.hits ?? 0,
            errors: linescore?.teams?.home?.errors ?? 0,
          },
        },
        current_inning: linescore?.currentInning,
        inning_half: linescore?.inningHalf,
      };

      // Top performers
      const topPerformers = (boxscore?.topPerformers || []).slice(0, 6).map((tp: any) => ({
        type: tp.type,
        player: tp.player?.person?.fullName || "Unknown",
        team: tp.player?.parentTeamId,
        stats: tp.player?.stats?.batting || tp.player?.stats?.pitching || {},
      }));

      return {
        gamePk: args.gamePk,
        matchup: `${gameData?.teams?.away?.name || "?"} @ ${gameData?.teams?.home?.name || "?"}`,
        status: status?.detailedState,
        linescore: normalizedLinescore,
        top_performers: topPerformers,
        venue: gameData?.venue?.name,
      };
    }
  },

  // ═══════════════════════════════════════════════════════════════════
  //  GET MLB STANDINGS — Division standings
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "get_mlb_standings",
      description: "Get current MLB standings from the official Stats API. Returns all 6 divisions with win-loss records, games back, winning percentage, streak, and last 10. Optionally filter by league (AL or NL).",
      schema: z.object({
        season: z.number().optional().describe("Season year. Default: current year"),
        league: z.enum(["AL", "NL", "all"]).optional().describe("Filter by league: 'AL' (American), 'NL' (National), or 'all'. Default: all"),
      })
    },
    handler: async (args) => {
      const season = args.season || new Date().getFullYear();
      const leagueId = args.league === "AL" ? "103" : args.league === "NL" ? "104" : "103,104";

      const data = await mlbFetch<any>(`${MLB_API_BASE}/standings?leagueId=${leagueId}&season=${season}`);

      const standings: NormalizedStanding[] = (data.records || []).map((div: any) => ({
        division: div.division?.name || "Unknown Division",
        teams: (div.teamRecords || []).map((t: any) => ({
          name: t.team?.name || "Unknown",
          wins: t.wins || 0,
          losses: t.losses || 0,
          pct: t.winningPercentage || ".000",
          games_back: t.gamesBack || "-",
          streak: t.streak?.streakCode || "-",
          last_10: `${t.records?.splitRecords?.find((r: any) => r.type === "lastTen")?.wins ?? "?"}-${t.records?.splitRecords?.find((r: any) => r.type === "lastTen")?.losses ?? "?"}`,
        })),
      }));

      return {
        season,
        divisions: standings.length,
        standings,
      };
    }
  },

  // ═══════════════════════════════════════════════════════════════════
  //  GET MLB ROSTER — Active team roster
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "get_mlb_roster",
      description: "Get the active roster for an MLB team. Returns player names, positions, jersey numbers. Accepts team name, abbreviation, or MLB team ID. Use rosterType to switch between active (26-man), 40-man, or full season roster.",
      schema: z.object({
        team: z.string().describe("Team name, abbreviation, or MLB team ID (e.g., 'Yankees', 'NYY', '147')"),
        rosterType: z.enum(["active", "40Man", "fullSeason"]).optional().describe("Roster type. Default: active (26-man)"),
      })
    },
    handler: async (args) => {
      const teamId = await resolveTeamId(args.team);
      if (!teamId) {
        const teams = await ensureTeamCache();
        return {
          error: `Could not resolve team '${args.team}'.`,
          available_teams: teams?.map(t => `${t.name} (${t.abbreviation}, ID: ${t.id})`).slice(0, 10),
        };
      }

      const rosterType = args.rosterType || "active";
      const data = await mlbFetch<any>(`${MLB_API_BASE}/teams/${teamId}/roster?rosterType=${rosterType}`);

      const roster: NormalizedRosterEntry[] = (data.roster || []).map((p: any) => ({
        name: p.person?.fullName || "Unknown",
        number: p.jerseyNumber || "?",
        position: p.position?.abbreviation || "?",
        bats_throws: `${p.person?.batSide?.code || "?"}/${p.person?.pitchHand?.code || "?"}`,
        status: p.status?.description || "Active",
      }));

      // Group by position type
      const pitchers = roster.filter(p => p.position === "P");
      const catchers = roster.filter(p => p.position === "C");
      const infielders = roster.filter(p => ["1B", "2B", "3B", "SS"].includes(p.position));
      const outfielders = roster.filter(p => ["LF", "CF", "RF", "OF"].includes(p.position));
      const dh = roster.filter(p => ["DH", "TWP", "UTL"].includes(p.position));

      return {
        team_id: teamId,
        roster_type: rosterType,
        total_players: roster.length,
        pitchers: pitchers.length,
        position_players: roster.length - pitchers.length,
        roster: { pitchers, catchers, infielders, outfielders, dh },
      };
    }
  },

  // ═══════════════════════════════════════════════════════════════════
  //  GET MLB PLAYER STATS — Season stats for a player
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "get_mlb_player_stats",
      description: "Get season statistics for a specific MLB player by player ID. Returns batting stats (AVG, HR, RBI, OPS, etc.) or pitching stats (ERA, W-L, SO, WHIP, etc.) depending on the stat group. Use search_mlb_player first to find the player ID.",
      schema: z.object({
        playerId: z.number().describe("The MLB player ID from search_mlb_player"),
        statGroup: z.enum(["hitting", "pitching", "fielding"]).optional().describe("Type of stats to fetch. Default: hitting"),
        season: z.number().optional().describe("Season year. Default: current year"),
      })
    },
    handler: async (args) => {
      const statGroup = args.statGroup || "hitting";
      const season = args.season || new Date().getFullYear();

      // Fetch stats and player info in parallel
      const [statsData, personData] = await Promise.all([
        mlbFetch<any>(`${MLB_API_BASE}/people/${args.playerId}/stats?stats=season&season=${season}&group=${statGroup}`),
        mlbFetch<any>(`${MLB_API_BASE}/people/${args.playerId}`),
      ]);

      const person = personData.people?.[0];
      const splits = statsData.stats?.[0]?.splits || [];

      if (splits.length === 0) {
        return {
          player: person?.fullName || `Player #${args.playerId}`,
          message: `No ${statGroup} stats found for ${season} season.`,
        };
      }

      const stats = splits[0]?.stat || {};
      const team = splits[0]?.team?.name || "Unknown";

      // Build LLM-friendly stat summary based on group
      let statSummary: Record<string, any> = {};

      if (statGroup === "hitting") {
        statSummary = {
          games: stats.gamesPlayed,
          at_bats: stats.atBats,
          avg: stats.avg,
          obp: stats.obp,
          slg: stats.slg,
          ops: stats.ops,
          hits: stats.hits,
          doubles: stats.doubles,
          triples: stats.triples,
          home_runs: stats.homeRuns,
          rbi: stats.rbi,
          runs: stats.runs,
          stolen_bases: stats.stolenBases,
          walks: stats.baseOnBalls,
          strikeouts: stats.strikeOuts,
        };
      } else if (statGroup === "pitching") {
        statSummary = {
          games: stats.gamesPlayed,
          games_started: stats.gamesStarted,
          wins: stats.wins,
          losses: stats.losses,
          era: stats.era,
          whip: stats.whip,
          innings_pitched: stats.inningsPitched,
          strikeouts: stats.strikeOuts,
          walks: stats.baseOnBalls,
          hits_allowed: stats.hits,
          home_runs_allowed: stats.homeRuns,
          saves: stats.saves,
          holds: stats.holds,
        };
      } else {
        statSummary = stats;
      }

      return {
        player: person?.fullName || `Player #${args.playerId}`,
        team,
        position: person?.primaryPosition?.abbreviation || "?",
        season,
        stat_group: statGroup,
        stats: statSummary,
      };
    }
  },

  // ═══════════════════════════════════════════════════════════════════
  //  SEARCH MLB PLAYER — Name-based player search
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "search_mlb_player",
      description: "Search for an MLB player by name. Returns matching player IDs, teams, and positions. Use the returned player ID with get_mlb_player_stats to fetch detailed statistics. Searches active MLB players.",
      schema: z.object({
        name: z.string().describe("Player name to search for (e.g., 'Ohtani', 'Aaron Judge', 'Vlad Guerrero')"),
      })
    },
    handler: async (args) => {
      const data = await mlbFetch<any>(`${MLB_API_BASE}/people/search?names=${encodeURIComponent(args.name)}&sportIds=1`);
      const people = data.people || [];

      if (people.length === 0) {
        return {
          message: `No MLB players found matching '${args.name}'.`,
          suggestion: "Try using just the last name, or check spelling.",
        };
      }

      return {
        results: people.length,
        players: people.slice(0, 10).map((p: any) => ({
          id: p.id,
          name: p.fullName,
          team: p.currentTeam?.name || "Free Agent",
          position: p.primaryPosition?.abbreviation || "?",
          number: p.primaryNumber || "?",
          bats_throws: `${p.batSide?.code || "?"}/${p.pitchHand?.code || "?"}`,
          age: p.currentAge,
          debut_year: p.mlbDebutDate?.split("-")[0],
        })),
      };
    }
  },

  // ═══════════════════════════════════════════════════════════════════
  //  GET MLB TEAMS — All 30 teams with IDs
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "get_mlb_teams",
      description: "Get all 30 MLB teams with their IDs, abbreviations, divisions, and venues. Use this to resolve team names to IDs for other tools, or to browse the full team list.",
      schema: z.object({})
    },
    handler: async () => {
      const data = await mlbFetch<any>(`${MLB_API_BASE}/teams?sportId=1`);

      const teams = (data.teams || []).map((t: any) => ({
        id: t.id,
        name: t.name,
        abbreviation: t.abbreviation,
        nickname: t.teamName,
        league: t.league?.name || "?",
        division: t.division?.name || "?",
        venue: t.venue?.name || "?",
      }));

      // Group by division
      const byDivision: Record<string, typeof teams> = {};
      for (const team of teams) {
        if (!byDivision[team.division]) byDivision[team.division] = [];
        byDivision[team.division].push(team);
      }

      return {
        total_teams: teams.length,
        teams_by_division: byDivision,
      };
    }
  },
];
