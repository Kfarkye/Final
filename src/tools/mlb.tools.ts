import { z } from "zod";
import { RegisteredTool } from "./types";
import { parseDateIntent } from "../lib/espn-grounding";
import { logger } from "../utils/logger";

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

async function mlbFetch<T = any>(
  url: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 30000;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;

  const res = await fetch(url, {
    signal,
    headers: {
      "Accept": "application/json",
      "User-Agent": "TruthPlatform/1.0",
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`MLB Stats API returned ${res.status}: ${body.slice(0, 500)}`);
  }

  return res.json() as Promise<T>;
}

/**
 * In-memory cache for team name → ID resolution.
 * Loaded once per process from /api/v1/teams, with a 24h TTL.
 */
let teamCache: { id: number; name: string; abbreviation: string; teamName: string }[] | null = null;
let teamCacheLoadedAt = 0;
const TEAM_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

async function ensureTeamCache(signal?: AbortSignal): Promise<typeof teamCache> {
  const now = Date.now();
  if (teamCache && (now - teamCacheLoadedAt < TEAM_CACHE_TTL_MS)) {
    return teamCache;
  }
  const data = await mlbFetch<any>(`${MLB_API_BASE}/teams?sportId=1`, { signal, timeoutMs: 30000 });
  teamCache = (data.teams || []).map((t: any) => ({
    id: t.id,
    name: t.name,
    abbreviation: t.abbreviation,
    teamName: t.teamName,
  }));
  teamCacheLoadedAt = Date.now();
  return teamCache!;
}

/**
 * Resolves a team name/abbreviation to an MLB team ID.
 * Fuzzy matches against full name, nickname, and abbreviation.
 */
async function resolveTeamId(input: string, signal?: AbortSignal): Promise<number | null> {
  const teams = await ensureTeamCache(signal);
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

/**
 * Resolves natural date intents or YYYY-MM-DD strings based on the America/New_York timezone
 * to avoid date misalignment near UTC midnight in Cloud Run.
 */
function getMlbTargetDate(dateStr?: string): string {
  if (!dateStr) {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  }

  const lower = dateStr.toLowerCase().trim();
  if (lower === "today" || lower === "tonight") {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  }

  if (lower === "tomorrow") {
    const d = new Date();
    d.setHours(d.getHours() + 24);
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  }

  if (lower === "yesterday") {
    const d = new Date();
    d.setHours(d.getHours() - 24);
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  }

  const isoMatch = lower.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) return lower;

  const yyyymmddMatch = lower.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (yyyymmddMatch) return `${yyyymmddMatch[1]}-${yyyymmddMatch[2]}-${yyyymmddMatch[3]}`;

  const usDate = lower.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (usDate) {
    const currentNY = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
    }).format(new Date());
    const year = usDate[3] ? (usDate[3].length === 2 ? `20${usDate[3]}` : usDate[3]) : currentNY;
    const mm = usDate[1].padStart(2, "0");
    const dd = usDate[2].padStart(2, "0");
    return `${year}-${mm}-${dd}`;
  }

  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/**
 * Fetches season pitching statistics for a single player ID.
 */
async function getPitchingSeasonStats(
  playerId: number,
  season: number,
  signal?: AbortSignal
) {
  try {
    const data = await mlbFetch<any>(
      `${MLB_API_BASE}/people/${playerId}/stats?stats=season&season=${season}&group=pitching`,
      { signal, timeoutMs: 8000 }
    );
    const stat = data.stats?.[0]?.splits?.[0]?.stat || {};
    return {
      era: stat.era ?? null,
      whip: stat.whip ?? null,
      wins: stat.wins ?? null,
      losses: stat.losses ?? null,
      innings_pitched: stat.inningsPitched ?? null,
      strikeouts: stat.strikeOuts ?? null,
      walks: stat.baseOnBalls ?? null,
    };
  } catch (err) {
    logger.warn({ msg: `Failed to fetch stats for pitcher ${playerId}`, err });
    return null;
  }
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
      description: "Get the MLB game schedule for a date from the official MLB Stats API. Returns game IDs (gamePk) needed for play-by-play, boxscores, and other deep stats tools. Hydrates starting pitcher match-ups and their current season stats (ERA, WHIP, W-L) by default. Use this first to find the gamePk, then pass it to get_mlb_play_by_play or get_mlb_boxscore. Optionally filter by team.",
      schema: z.object({
        date: z.string().optional().describe("Date in YYYY-MM-DD or natural language like 'today', 'tomorrow', 'yesterday'. Default: today"),
        team: z.string().optional().describe("Team name, abbreviation, or ID to filter by (e.g., 'Yankees', 'NYY', '147')"),
        includeProbablePitchers: z.boolean().optional().describe("Whether to include starting pitcher info. Default: true"),
        includePitcherStats: z.boolean().optional().describe("Whether to fetch and enrich with season stats for probable starting pitchers. Default: true"),
      })
    },
    handler: async (args, context) => {
      const formattedDate = getMlbTargetDate(args.date);
      const yyyy = Number(formattedDate.split("-")[0]);

      let teamId: number | null = null;
      if (args.team) {
        teamId = await resolveTeamId(args.team, context.signal);
      }

      const teamParam = teamId ? `&teamId=${teamId}` : "";
      const hydrateParam = args.includeProbablePitchers !== false ? "&hydrate=probablePitcher,linescore,decisions" : "&hydrate=linescore,decisions";
      const url = `${MLB_API_BASE}/schedule?sportId=1&date=${formattedDate}${teamParam}${hydrateParam}`;
      const data = await mlbFetch<any>(url, { signal: context.signal, timeoutMs: 10000 });

      const games = (data.dates?.[0]?.games || []).map((g: any) => {
        const away = g.teams?.away;
        const home = g.teams?.home;
        return {
          gamePk: g.gamePk,
          matchup: `${away?.team?.name || "?"} @ ${home?.team?.name || "?"}`,
          status: g.status?.detailedState || "Unknown",
          abstract_status: g.status?.abstractGameState || "Unknown",
          game_time: g.gameDate,
          away_team: { name: away?.team?.name, id: away?.team?.id, record: `${away?.leagueRecord?.wins}-${away?.leagueRecord?.losses}`, score: away?.score },
          home_team: { name: home?.team?.name, id: home?.team?.id, record: `${home?.leagueRecord?.wins}-${home?.leagueRecord?.losses}`, score: home?.score },
          venue: g.venue?.name,
          probable_pitchers: args.includeProbablePitchers !== false ? {
            away: away?.probablePitcher ? { id: away.probablePitcher.id, name: away.probablePitcher.fullName } : null,
            home: home?.probablePitcher ? { id: home.probablePitcher.id, name: home.probablePitcher.fullName } : null,
          } : null,
        };
      });

      if (args.includeProbablePitchers !== false && args.includePitcherStats !== false && games.length > 0) {
        const pitcherIds = new Set<number>();
        for (const g of games) {
          if (g.probable_pitchers?.away?.id) pitcherIds.add(g.probable_pitchers.away.id);
          if (g.probable_pitchers?.home?.id) pitcherIds.add(g.probable_pitchers.home.id);
        }

        if (pitcherIds.size > 0) {
          try {
            const statsData = await mlbFetch<any>(
              `${MLB_API_BASE}/people?personIds=${Array.from(pitcherIds).join(",")}&hydrate=stats(group=pitching,type=season,season=${yyyy})`,
              { signal: context.signal, timeoutMs: 8000 }
            );

            const statsMap = new Map<number, any>();
            for (const person of statsData.people || []) {
              const stat = person.stats?.[0]?.splits?.[0]?.stat || {};
              statsMap.set(person.id, {
                era: stat.era ?? null,
                whip: stat.whip ?? null,
                wins: stat.wins ?? null,
                losses: stat.losses ?? null,
                innings_pitched: stat.inningsPitched ?? null,
                strikeouts: stat.strikeOuts ?? null,
                walks: stat.baseOnBalls ?? null,
              });
            }

            for (const g of games) {
              if (g.probable_pitchers?.away) {
                const s = statsMap.get(g.probable_pitchers.away.id);
                g.probable_pitchers.away = {
                  ...g.probable_pitchers.away,
                  era: s?.era ?? null,
                  whip: s?.whip ?? null,
                  wins: s?.wins ?? null,
                  losses: s?.losses ?? null,
                  innings_pitched: s?.innings_pitched ?? null,
                  strikeouts: s?.strikeouts ?? null,
                  walks: s?.walks ?? null,
                };
              }
              if (g.probable_pitchers?.home) {
                const s = statsMap.get(g.probable_pitchers.home.id);
                g.probable_pitchers.home = {
                  ...g.probable_pitchers.home,
                  era: s?.era ?? null,
                  whip: s?.whip ?? null,
                  wins: s?.wins ?? null,
                  losses: s?.losses ?? null,
                  innings_pitched: s?.innings_pitched ?? null,
                  strikeouts: s?.strikeouts ?? null,
                  walks: s?.walks ?? null,
                };
              }
            }
          } catch (err) {
            logger.warn({ msg: "Failed to batch fetch pitching stats for schedule", err });
          }
        }
      }

      return {
        date: formattedDate,
        total_games: games.length,
        in_progress: games.filter((g: any) => g.abstract_status === "Live").length,
        games,
      };
    },
    entityType: 'game',
    renderType: 'game-card',
    promptHint: 'Respect game status — never state a score for a SCHEDULED game.',
  },

  // ═══════════════════════════════════════════════════════════════════
  //  GET MLB GAME — Single game with flat envelope-ready fields
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "get_mlb_game",
      description: "Get a single MLB game by gamePk ID, or find a team's game on a given date. Returns a flat game object with team names, logos, status, venue, and probable pitchers — ready for the render contract. Use when you need one specific game, not a full schedule.",
      schema: z.object({
        gamePk: z.number().optional().describe("MLB game primary key ID. If provided, fetches this specific game."),
        team: z.string().optional().describe("Team name or abbreviation (e.g., 'CHW', 'White Sox'). Used with date to find a specific game."),
        date: z.string().optional().describe("Date in YYYY-MM-DD or natural language ('today', 'tomorrow'). Default: today"),
      }).refine(data => data.gamePk || data.team, {
        message: "Either gamePk or team must be provided",
      }),
    },
    handler: async (args, context) => {
      const formattedDate = getMlbTargetDate(args.date);
      const yyyy = Number(formattedDate.split("-")[0]);

      let game: any;

      if (args.gamePk) {
        // Direct gamePk lookup via the live feed (single game, full data)
        const url = `${MLB_API_V11}/game/${args.gamePk}/feed/live`;
        const data = await mlbFetch<any>(url, { signal: context.signal, timeoutMs: 30000 });
        const gd = data.gameData || {};
        const ld = data.liveData || {};
        const linescore = ld.linescore || {};

        const away = gd.teams?.away || {};
        const home = gd.teams?.home || {};
        const status = gd.status?.detailedState || "Unknown";
        const abstractStatus = gd.status?.abstractGameState || "Unknown";

        game = {
          gamePk: args.gamePk,
          status,
          abstract_status: abstractStatus,
          start_time: gd.datetime?.dateTime || null,
          away_team: away.name || "?",
          home_team: home.name || "?",
          away_abbrev: away.abbreviation || away.name?.slice(0, 3).toUpperCase() || "?",
          home_abbrev: home.abbreviation || home.name?.slice(0, 3).toUpperCase() || "?",
          away_logo: `https://a.espncdn.com/i/teamlogos/mlb/500/${away.id}.png`,
          home_logo: `https://a.espncdn.com/i/teamlogos/mlb/500/${home.id}.png`,
          venue: gd.venue?.name || null,
          league_label: "MLB",
          away_record: away.record ? `${away.record.wins}-${away.record.losses}` : null,
          home_record: home.record ? `${home.record.wins}-${home.record.losses}` : null,
        };

        // Scores only when game is live or final
        const isLive = abstractStatus === "Live";
        const isFinal = abstractStatus === "Final";
        if (isLive || isFinal) {
          game.away_score = linescore.teams?.away?.runs ?? null;
          game.home_score = linescore.teams?.home?.runs ?? null;
          game.inning = linescore.currentInning ?? null;
          game.inning_half = linescore.inningHalf ?? null;
          const decisions = ld.decisions || {};
          game.live = {
            away_score: away?.score ?? null,
            home_score: home?.score ?? null,
            period: linescore?.currentInning ?? null,
            line: {
              away: { r: linescore?.teams?.away?.runs, h: linescore?.teams?.away?.hits, e: linescore?.teams?.away?.errors },
              home: { r: linescore?.teams?.home?.runs, h: linescore?.teams?.home?.hits, e: linescore?.teams?.home?.errors },
            },
            balls: linescore?.balls,
            strikes: linescore?.strikes,
            outs: linescore?.outs,
            bases: {
              on1: !!linescore?.offense?.first,
              on2: !!linescore?.offense?.second,
              on3: !!linescore?.offense?.third,
            },
            pit: linescore?.defense?.pitcher ? { id: linescore.defense.pitcher.id, name: linescore.defense.pitcher.fullName } : null,
            bat: linescore?.offense?.batter ? { id: linescore.offense.batter.id, name: linescore.offense.batter.fullName } : null,
            win: decisions?.winner ? { id: decisions.winner.id, name: decisions.winner.fullName, elite: false } : null,
            loss: decisions?.loser ? { id: decisions.loser.id, name: decisions.loser.fullName } : null,
            save: decisions?.save ? { id: decisions.save.id, name: decisions.save.fullName } : null,
          };
        }

        // Probable pitchers
        const probables = gd.probablePitchers || {};
        if (probables.away || probables.home) {
          game.probable_pitchers = {
            away: probables.away ? { id: probables.away.id, name: probables.away.fullName } : null,
            home: probables.home ? { id: probables.home.id, name: probables.home.fullName } : null,
          };
        }
      } else {
        // Team + date lookup — use schedule API, return the matching game
        let teamId: number | null = null;
        if (args.team) {
          teamId = await resolveTeamId(args.team, context.signal);
        }

        const teamParam = teamId ? `&teamId=${teamId}` : "";
        const url = `${MLB_API_BASE}/schedule?sportId=1&date=${formattedDate}${teamParam}&hydrate=probablePitcher,linescore,decisions`;
        const data = await mlbFetch<any>(url, { signal: context.signal, timeoutMs: 30000 });

        const rawGame = data.dates?.[0]?.games?.[0];
        if (!rawGame) {
          return { error: `No game found for ${args.team || 'unknown'} on ${formattedDate}` };
        }

        const away = rawGame.teams?.away;
        const home = rawGame.teams?.home;
        const status = rawGame.status?.detailedState || "Unknown";
        const abstractStatus = rawGame.status?.abstractGameState || "Unknown";

        game = {
          gamePk: rawGame.gamePk,
          status,
          abstract_status: abstractStatus,
          start_time: rawGame.gameDate || null,
          away_team: away?.team?.name || "?",
          home_team: home?.team?.name || "?",
          away_abbrev: away?.team?.abbreviation || away?.team?.name?.slice(0, 3).toUpperCase() || "?",
          home_abbrev: home?.team?.abbreviation || home?.team?.name?.slice(0, 3).toUpperCase() || "?",
          away_logo: `https://a.espncdn.com/i/teamlogos/mlb/500/${away?.team?.id}.png`,
          home_logo: `https://a.espncdn.com/i/teamlogos/mlb/500/${home?.team?.id}.png`,
          venue: rawGame.venue?.name || null,
          league_label: "MLB",
          away_record: `${away?.leagueRecord?.wins}-${away?.leagueRecord?.losses}`,
          home_record: `${home?.leagueRecord?.wins}-${home?.leagueRecord?.losses}`,
        };

        // Scores only when game is live or final
        const isLive = abstractStatus === "Live";
        const isFinal = abstractStatus === "Final";
        if (isLive || isFinal) {
          game.away_score = away?.score ?? null;
          game.home_score = home?.score ?? null;
          const linescore = rawGame.linescore || {};
          const decisions = rawGame.decisions || {};
          game.live = {
            away_score: away?.score ?? null,
            home_score: home?.score ?? null,
            period: linescore?.currentInning ?? null,
            line: {
              away: { r: linescore?.teams?.away?.runs, h: linescore?.teams?.away?.hits, e: linescore?.teams?.away?.errors },
              home: { r: linescore?.teams?.home?.runs, h: linescore?.teams?.home?.hits, e: linescore?.teams?.home?.errors },
            },
            balls: linescore?.balls,
            strikes: linescore?.strikes,
            outs: linescore?.outs,
            bases: {
              on1: !!linescore?.offense?.first,
              on2: !!linescore?.offense?.second,
              on3: !!linescore?.offense?.third,
            },
            pit: linescore?.defense?.pitcher ? { id: linescore.defense.pitcher.id, name: linescore.defense.pitcher.fullName } : null,
            bat: linescore?.offense?.batter ? { id: linescore.offense.batter.id, name: linescore.offense.batter.fullName } : null,
            win: decisions?.winner ? { id: decisions.winner.id, name: decisions.winner.fullName, elite: false } : null,
            loss: decisions?.loser ? { id: decisions.loser.id, name: decisions.loser.fullName } : null,
            save: decisions?.save ? { id: decisions.save.id, name: decisions.save.fullName } : null,
          };
        }

        // Probable pitchers
        if (away?.probablePitcher || home?.probablePitcher) {
          game.probable_pitchers = {
            away: away?.probablePitcher ? { id: away.probablePitcher.id, name: away.probablePitcher.fullName } : null,
            home: home?.probablePitcher ? { id: home.probablePitcher.id, name: home.probablePitcher.fullName } : null,
          };

          // Enrich with season stats
          const pitcherIds = [
            game.probable_pitchers.away?.id,
            game.probable_pitchers.home?.id,
          ].filter(Boolean);

          if (pitcherIds.length > 0) {
            try {
              const statsData = await mlbFetch<any>(
                `${MLB_API_BASE}/people?personIds=${pitcherIds.join(",")}&hydrate=stats(group=pitching,type=season,season=${yyyy})`,
                { signal: context.signal, timeoutMs: 30000 }
              );
              const statsMap = new Map<number, any>();
              for (const person of statsData.people || []) {
                const stat = person.stats?.[0]?.splits?.[0]?.stat || {};
                statsMap.set(person.id, {
                  era: stat.era ?? null,
                  whip: stat.whip ?? null,
                  record: `${stat.wins ?? 0}-${stat.losses ?? 0}`,
                  innings_pitched: stat.inningsPitched ?? null,
                  strikeouts: stat.strikeOuts ?? null,
                });
              }
              if (game.probable_pitchers.away?.id) {
                Object.assign(game.probable_pitchers.away, statsMap.get(game.probable_pitchers.away.id) || {});
              }
              if (game.probable_pitchers.home?.id) {
                Object.assign(game.probable_pitchers.home, statsMap.get(game.probable_pitchers.home.id) || {});
              }
            } catch (err) {
              logger.warn({ msg: "Failed to fetch pitcher stats for get_mlb_game", err });
            }
          }
        }
      }

      return game;
    },
    entityType: 'game',
    renderType: 'game-card',
    promptHint: 'Single MLB game. Respect game status — never state a score for a game that has not started.',
  },

  // ═══════════════════════════════════════════════════════════════════
  //  GET MLB PLAY-BY-PLAY — Live play-by-play feed
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "get_mlb_play_by_play",
      description: "Get play-by-play data for a specific MLB game. Returns individual at-bat results, scoring plays, and current game state. The gamePk can be found using get_mlb_schedule. By default returns the last 15 plays to keep context manageable; use lastN to adjust. Set scoringOnly=true to see only scoring plays.",
      schema: z.object({
        gamePk: z.number().int().positive().describe("The MLB game ID (gamePk) from get_mlb_schedule"),
        lastN: z.number().int().min(0).max(100).optional().describe("Number of most recent plays to return. Default: 15. Max: 100."),
        scoringOnly: z.boolean().optional().describe("If true, return only scoring plays. Default: false"),
      })
    },
    handler: async (args, context) => {
      const data = await mlbFetch<any>(`${MLB_API_V11}/game/${args.gamePk}/feed/live`, { signal: context.signal, timeoutMs: 10000 });
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
        gamePk: z.number().int().positive().describe("The MLB game ID (gamePk) from get_mlb_schedule"),
      })
    },
    handler: async (args, context) => {
      const data = await mlbFetch<any>(`${MLB_API_V11}/game/${args.gamePk}/feed/live`, { signal: context.signal, timeoutMs: 10000 });
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

      // Top performers (safely mapped)
      const topPerformers = (boxscore?.topPerformers || []).slice(0, 6).map((tp: any) => {
        if (!tp) return null;
        return {
          type: tp.type,
          player: tp.player?.person?.fullName || "Unknown",
          team: tp.player?.parentTeamId || null,
          stats: tp.player?.stats?.batting || tp.player?.stats?.pitching || {},
        };
      }).filter(Boolean);

      return {
        gamePk: args.gamePk,
        matchup: `${gameData?.teams?.away?.name || "?"} @ ${gameData?.teams?.home?.name || "?"}`,
        status: status?.detailedState,
        linescore: normalizedLinescore,
        top_performers: topPerformers,
        venue: gameData?.venue?.name,
      };
    },
    entityType: 'game',
    renderType: 'game-card',
    promptHint: 'Boxscore data — report only stats present in the payload. Do not invent pitcher lines or batting stats.',
  },

  // ═══════════════════════════════════════════════════════════════════
  //  GET MLB STANDINGS — Division standings
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "get_mlb_standings",
      description: "Get current MLB standings from the official Stats API. Returns all 6 divisions with win-loss records, games back, winning percentage, streak, and last 10. Optionally filter by league (AL or NL).",
      schema: z.object({
        season: z.number().int().min(1876).max(new Date().getFullYear() + 1).optional().describe("Season year. Default: current year"),
        league: z.enum(["AL", "NL", "all"]).optional().describe("Filter by league: 'AL' (American), 'NL' (National), or 'all'. Default: all"),
      })
    },
    handler: async (args, context) => {
      const season = args.season || new Date().getFullYear();
      const leagueId = args.league === "AL" ? "103" : args.league === "NL" ? "104" : "103,104";

      const data = await mlbFetch<any>(`${MLB_API_BASE}/standings?leagueId=${leagueId}&season=${season}`, { signal: context.signal, timeoutMs: 10000 });

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
    },
    entityType: 'standings',
    renderType: 'standings-table',
    promptHint: 'MLB division standings — report records exactly as shown. Do not compute clinch numbers or projected records.',
  },

  // ═══════════════════════════════════════════════════════════════════
  //  GET MLB ROSTER — Active team roster
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "get_mlb_roster",
      description: "Get the active roster for an MLB team. Returns player names, positions, jersey numbers, and bats/throws hands. Accepts team name, abbreviation, or MLB team ID. Use rosterType to switch between active (26-man), 40-man, or full season roster.",
      schema: z.object({
        team: z.string().describe("Team name, abbreviation, or MLB team ID (e.g., 'Yankees', 'NYY', '147')"),
        rosterType: z.enum(["active", "40Man", "fullSeason"]).optional().describe("Roster type. Default: active (26-man)"),
      })
    },
    handler: async (args, context) => {
      const teamId = await resolveTeamId(args.team, context.signal);
      if (!teamId) {
        const teams = await ensureTeamCache(context.signal);
        return {
          error: `Could not resolve team '${args.team}'.`,
          available_teams: teams?.map(t => `${t.name} (${t.abbreviation}, ID: ${t.id})`).slice(0, 10),
        };
      }

      const rosterType = args.rosterType || "active";
      // Hydrate with person to ensure bats/throws value is populated
      const data = await mlbFetch<any>(`${MLB_API_BASE}/teams/${teamId}/roster?rosterType=${rosterType}&hydrate=person`, { signal: context.signal, timeoutMs: 10000 });

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
        playerId: z.number().int().positive().describe("The MLB player ID from search_mlb_player"),
        statGroup: z.enum(["hitting", "pitching", "fielding"]).optional().describe("Type of stats to fetch. Default: hitting"),
        season: z.number().int().min(1876).max(new Date().getFullYear() + 1).optional().describe("Season year. Default: current year"),
      })
    },
    handler: async (args, context) => {
      const statGroup = args.statGroup || "hitting";
      const season = args.season || new Date().getFullYear();

      // Fetch stats and player info in parallel
      const [statsData, personData] = await Promise.all([
        mlbFetch<any>(`${MLB_API_BASE}/people/${args.playerId}/stats?stats=season&season=${season}&group=${statGroup}`, { signal: context.signal, timeoutMs: 10000 }),
        mlbFetch<any>(`${MLB_API_BASE}/people/${args.playerId}`, { signal: context.signal, timeoutMs: 10000 }),
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
    },
    entityType: 'player',
    renderType: 'player-card',
    promptHint: 'Player season stats. Cite only the stat numbers in this payload. Do not compute rate stats or projections not present.',
  },

  // ═══════════════════════════════════════════════════════════════════
  //  SEARCH MLB PLAYER — Name-based player search
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "search_mlb_player",
      description: "Search for an MLB player by name. Returns matching player IDs, teams, and positions. Use the returned player ID with get_mlb_player_stats to fetch detailed statistics. Searches active MLB players.",
      schema: z.object({
        name: z.string().min(1).describe("Player name to search for (e.g., 'Ohtani', 'Aaron Judge', 'Vlad Guerrero')"),
      })
    },
    handler: async (args, context) => {
      const data = await mlbFetch<any>(`${MLB_API_BASE}/people/search?names=${encodeURIComponent(args.name)}&sportIds=1`, { signal: context.signal, timeoutMs: 10000 });
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
          team: p.currentTeam?.name || "Unknown",
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
    handler: async (args, context) => {
      const data = await mlbFetch<any>(`${MLB_API_BASE}/teams?sportId=1`, { signal: context.signal, timeoutMs: 10000 });

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
