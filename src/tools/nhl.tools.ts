import { z } from "zod";
import { RegisteredTool } from "./types";
import { logger } from "../utils/logger";

// ============================================================================
// NHL API Tools (api-web.nhle.com)
// ────────────────────────────────────────────────────────────────────
// Official NHL Stats API — free, no auth required, highly structured.
//
// Provides schedules, boxscores, standings, rosters, player stats,
// and critically: starting goalie confirmation (the #1 NHL betting
// signal — backup goalies completely change moneylines and totals).
//
// The API uses team abbreviations (3-letter codes like "BOS", "TOR")
// as primary identifiers for rosters and many endpoints.
// ============================================================================

const NHL_API_BASE = "https://api-web.nhle.com/v1";
const NHL_SEARCH_BASE = "https://search.d3.nhle.com/api/v1";

// ── Helpers ─────────────────────────────────────────────────────────

async function nhlFetch<T = any>(
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
    headers: {
      Accept: "application/json",
      "User-Agent": "TruthPlatform/1.0",
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `NHL API returned ${res.status}: ${body.slice(0, 500)}`
    );
  }

  return res.json() as Promise<T>;
}

/**
 * Resolves natural date intents to YYYY-MM-DD in America/New_York.
 */
function getNhlTargetDate(dateStr?: string): string {
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

  if (/^\d{4}-\d{2}-\d{2}$/.test(lower)) return lower;

  const compact = lower.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;

  const us = lower.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (us) {
    const year = us[3]
      ? us[3].length === 2
        ? `20${us[3]}`
        : us[3]
      : new Intl.DateTimeFormat("en-US", {
          timeZone: "America/New_York",
          year: "numeric",
        }).format(new Date());
    return `${year}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
  }

  return formatET(new Date());
}

/**
 * Returns the NHL season ID (e.g. 20232024) for a given start year.
 */
function toNhlSeasonId(year: number): number {
  return year * 10000 + (year + 1);
}

/**
 * Returns the start-year of the current NHL season.
 * Before October → previous calendar year. Oct onward → current year.
 */
function getCurrentNhlSeasonYear(): number {
  const etParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "numeric",
  }).formatToParts(new Date());
  const year = Number(etParts.find((p) => p.type === "year")!.value);
  const month = Number(etParts.find((p) => p.type === "month")!.value);
  return month >= 10 ? year : year - 1;
}

// ── Team Cache ──────────────────────────────────────────────────────

interface NhlTeamCacheEntry {
  id: number;
  abbrev: string;
  name: string;
  commonName: string;
  conference: string;
  division: string;
}

let teamCache: NhlTeamCacheEntry[] | null = null;
let teamCacheLoadedAt = 0;
const TEAM_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

async function ensureTeamCache(
  signal?: AbortSignal
): Promise<NhlTeamCacheEntry[]> {
  const now = Date.now();
  if (teamCache && now - teamCacheLoadedAt < TEAM_CACHE_TTL_MS) {
    return teamCache;
  }

  const data = await nhlFetch<any>(`${NHL_API_BASE}/standings/now`, {
    signal,
    timeoutMs: 10000,
  });

  teamCache = (data.standings || []).map((t: any) => ({
    id: t.teamAbbrev?.default ? 0 : 0, // ID not exposed in standings
    abbrev: t.teamAbbrev?.default || "",
    name: t.teamName?.default || "",
    commonName: t.teamCommonName?.default || "",
    conference: t.conferenceName || "",
    division: t.divisionName || "",
  }));

  // Deduplicate (standings has one entry per team)
  teamCacheLoadedAt = Date.now();
  return teamCache;
}

/**
 * Resolves a team name/abbreviation to an NHL team abbreviation (3-letter code).
 * NHL uses abbreviations as primary IDs for most endpoints.
 */
async function resolveTeamAbbrev(
  input: string,
  signal?: AbortSignal
): Promise<string | null> {
  const teams = await ensureTeamCache(signal);
  const lower = input.toLowerCase().trim();

  // Exact abbreviation (e.g., "BOS", "TOR")
  const byAbbrev = teams.find(
    (t) => t.abbrev.toLowerCase() === lower
  );
  if (byAbbrev) return byAbbrev.abbrev;

  // Fuzzy name match
  const byName = teams.find(
    (t) =>
      t.name.toLowerCase().includes(lower) ||
      t.commonName.toLowerCase().includes(lower) ||
      lower.includes(t.commonName.toLowerCase())
  );
  return byName?.abbrev ?? null;
}

// ── Tools ───────────────────────────────────────────────────────────

export const nhlTools: RegisteredTool<any>[] = [
  // ═══════════════════════════════════════════════════════════════════
  //  GET NHL SCHEDULE — Day's games with scores & goals
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "get_nhl_schedule",
      description:
        "Get the NHL game schedule for a date from the official NHL API. Returns game IDs, scores, shots on goal, game status (upcoming/live/final), venue, TV broadcasts, and goal scorers for completed games. Use this first to find game IDs, then pass to get_nhl_boxscore or get_nhl_starting_goalies. Optionally filter by team.",
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
            "Team name or abbreviation to filter by (e.g., 'Bruins', 'BOS', 'Toronto')"
          ),
      }),
    },
    handler: async (args, context) => {
      const formattedDate = getNhlTargetDate(args.date);

      let filterAbbrev: string | null = null;
      if (args.team) {
        filterAbbrev = await resolveTeamAbbrev(args.team, context.signal);
      }

      const data = await nhlFetch<any>(
        `${NHL_API_BASE}/score/${formattedDate}`,
        { signal: context.signal, timeoutMs: 10000 }
      );

      let games = (data.games || []).map((g: any) => {
        const home = g.homeTeam;
        const away = g.awayTeam;

        // Map game state to status
        const stateMap: Record<string, string> = {
          FUT: "upcoming",
          PRE: "upcoming",
          LIVE: "live",
          CRIT: "live",
          FINAL: "final",
          OFF: "final",
        };
        const status = stateMap[g.gameState] || g.gameState;

        // Parse goals into scoring summary
        const goals = (g.goals || []).map((goal: any) => ({
          period: goal.period,
          time: goal.timeInPeriod,
          scorer: goal.name?.default || `${goal.firstName?.default} ${goal.lastName?.default}`,
          team: goal.teamAbbrev?.default || "?",
          strength: goal.strength || "ev",
          away_score: goal.awayScore,
          home_score: goal.homeScore,
        }));

        return {
          gameId: g.id,
          matchup: `${away?.abbrev || "?"} @ ${home?.abbrev || "?"}`,
          status,
          game_state: g.gameState,
          game_time_utc: g.startTimeUTC,
          period: g.period,
          clock: g.clock?.timeRemaining || null,
          home_team: {
            abbrev: home?.abbrev,
            name: home?.name?.default || home?.abbrev,
            score: home?.score ?? 0,
            sog: home?.sog ?? 0,
          },
          away_team: {
            abbrev: away?.abbrev,
            name: away?.name?.default || away?.abbrev,
            score: away?.score ?? 0,
            sog: away?.sog ?? 0,
          },
          venue: g.venue?.default || null,
          broadcasts: (g.tvBroadcasts || []).map(
            (b: any) =>
              `${b.network} (${b.market === "H" ? "Home" : b.market === "A" ? "Away" : b.market})`
          ),
          goals: goals.length > 0 ? goals : null,
          game_outcome: g.gameOutcome
            ? {
                type: g.gameOutcome.lastPeriodType || "REG",
              }
            : null,
        };
      });

      // Filter by team
      if (filterAbbrev) {
        games = games.filter(
          (g: any) =>
            g.home_team.abbrev === filterAbbrev ||
            g.away_team.abbrev === filterAbbrev
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
    entityType: 'game',
    renderType: 'game-card',
    promptHint: 'NHL schedule. Respect game status. Never state a score for an upcoming game.',
  },

  // ═══════════════════════════════════════════════════════════════════
  //  GET NHL STARTING GOALIES — Confirmed starters with SV% & GAA
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "get_nhl_starting_goalies",
      description:
        "Get starting goalie information for NHL games on a date. For completed/live games, identifies confirmed starters from boxscore data (starter=true flag). For each starting goalie, fetches their current season Save Percentage (SV%), Goals Against Average (GAA), Wins-Losses-OTL, and shutouts. This is the #1 NHL betting signal — a backup goalie completely changes moneylines and totals.",
      schema: z.object({
        date: z
          .string()
          .optional()
          .describe(
            "Date in YYYY-MM-DD or natural language. Default: today"
          ),
        team: z
          .string()
          .optional()
          .describe(
            "Team name or abbreviation to filter by (e.g., 'Bruins', 'BOS')"
          ),
      }),
    },
    handler: async (args, context) => {
      const formattedDate = getNhlTargetDate(args.date);

      let filterAbbrev: string | null = null;
      if (args.team) {
        filterAbbrev = await resolveTeamAbbrev(args.team, context.signal);
      }

      // Get the day's games
      const scoreData = await nhlFetch<any>(
        `${NHL_API_BASE}/score/${formattedDate}`,
        { signal: context.signal, timeoutMs: 10000 }
      );

      let games = scoreData.games || [];
      if (filterAbbrev) {
        games = games.filter(
          (g: any) =>
            g.homeTeam?.abbrev === filterAbbrev ||
            g.awayTeam?.abbrev === filterAbbrev
        );
      }

      if (games.length === 0) {
        return {
          date: formattedDate,
          message: "No NHL games found on this date.",
        };
      }

      // For completed/live games, fetch boxscores to identify confirmed starters
      const goalieResults: any[] = [];
      const goalieIdsToFetch = new Set<number>();
      const goalieGameMap: Map<
        number,
        { gameId: number; matchup: string; team: string; side: string; confirmation: string }
      > = new Map();

      // Phase 1: Get boxscores to find confirmed starters
      const boxscorePromises = games.map(async (g: any) => {
        const matchup = `${g.awayTeam?.abbrev || "?"} @ ${g.homeTeam?.abbrev || "?"}`;
        const gameState = g.gameState;

        if (
          gameState === "FINAL" ||
          gameState === "OFF" ||
          gameState === "LIVE" ||
          gameState === "CRIT"
        ) {
          // Fetch boxscore — starter flag is confirmed
          try {
            const box = await nhlFetch<any>(
              `${NHL_API_BASE}/gamecenter/${g.id}/boxscore`,
              { signal: context.signal, timeoutMs: 8000 }
            );

            const processTeam = (
              goalies: any[],
              teamAbbrev: string,
              side: string
            ) => {
              const starter = goalies.find((gl: any) => gl.starter);
              if (starter) {
                goalieIdsToFetch.add(starter.playerId);
                goalieGameMap.set(starter.playerId, {
                  gameId: g.id,
                  matchup,
                  team: teamAbbrev,
                  side,
                  confirmation: "Confirmed",
                });
              }
            };

            const homeGoalies =
              box.playerByGameStats?.homeTeam?.goalies || [];
            const awayGoalies =
              box.playerByGameStats?.awayTeam?.goalies || [];

            processTeam(
              homeGoalies,
              g.homeTeam?.abbrev || "?",
              "home"
            );
            processTeam(
              awayGoalies,
              g.awayTeam?.abbrev || "?",
              "away"
            );
          } catch (err) {
            logger.warn({
              msg: `Failed to fetch boxscore for game ${g.id}`,
              err,
            });
          }
        } else {
          // Future / pre-game — no confirmed starters available from API
          // Mark as unconfirmed
          goalieResults.push({
            gameId: g.id,
            matchup,
            game_time_utc: g.startTimeUTC,
            home_goalie: {
              team: g.homeTeam?.abbrev || "?",
              side: "home",
              confirmation: "Unconfirmed",
              name: null,
              season_stats: null,
              note: "Starting goalie not yet confirmed. Check closer to game time.",
            },
            away_goalie: {
              team: g.awayTeam?.abbrev || "?",
              side: "away",
              confirmation: "Unconfirmed",
              name: null,
              season_stats: null,
              note: "Starting goalie not yet confirmed. Check closer to game time.",
            },
          });
        }
      });

      await Promise.all(boxscorePromises);

      // Phase 2: Batch fetch season stats for confirmed starters
      const statsPromises = Array.from(goalieIdsToFetch).map(
        async (playerId) => {
          try {
            const playerData = await nhlFetch<any>(
              `${NHL_API_BASE}/player/${playerId}/landing`,
              { signal: context.signal, timeoutMs: 8000 }
            );

            const featured =
              playerData.featuredStats?.regularSeason?.subSeason;
            const gameInfo = goalieGameMap.get(playerId)!;

            return {
              playerId,
              name: `${playerData.firstName?.default || ""} ${playerData.lastName?.default || ""}`.trim(),
              team: gameInfo.team,
              side: gameInfo.side,
              gameId: gameInfo.gameId,
              matchup: gameInfo.matchup,
              confirmation: gameInfo.confirmation,
              season_stats: featured
                ? {
                    games_played: featured.gamesPlayed,
                    gaa: Number(featured.goalsAgainstAvg?.toFixed(2)),
                    save_pct: Number(
                      (featured.savePctg * 100)?.toFixed(1)
                    ),
                    record: `${featured.wins}-${featured.losses}-${featured.otLosses}`,
                    shutouts: featured.shutouts,
                  }
                : null,
            };
          } catch (err) {
            const gameInfo = goalieGameMap.get(playerId)!;
            return {
              playerId,
              name: `Player #${playerId}`,
              team: gameInfo.team,
              side: gameInfo.side,
              gameId: gameInfo.gameId,
              matchup: gameInfo.matchup,
              confirmation: gameInfo.confirmation,
              season_stats: null,
            };
          }
        }
      );

      const resolvedGoalies = await Promise.all(statsPromises);

      // Phase 3: Group goalies by game
      const gameGoalieMap = new Map<number, any>();
      for (const goalie of resolvedGoalies) {
        if (!gameGoalieMap.has(goalie.gameId)) {
          gameGoalieMap.set(goalie.gameId, {
            gameId: goalie.gameId,
            matchup: goalie.matchup,
            home_goalie: null,
            away_goalie: null,
          });
        }
        const entry = gameGoalieMap.get(goalie.gameId)!;
        const goalieData = {
          team: goalie.team,
          side: goalie.side,
          confirmation: goalie.confirmation,
          name: goalie.name,
          season_stats: goalie.season_stats,
        };
        if (goalie.side === "home") {
          entry.home_goalie = goalieData;
        } else {
          entry.away_goalie = goalieData;
        }
      }

      // Merge confirmed and unconfirmed
      const allGameGoalies = [
        ...Array.from(gameGoalieMap.values()),
        ...goalieResults,
      ];

      return {
        date: formattedDate,
        total_games: allGameGoalies.length,
        confirmed: allGameGoalies.filter(
          (g) =>
            g.home_goalie?.confirmation === "Confirmed" ||
            g.away_goalie?.confirmation === "Confirmed"
        ).length,
        unconfirmed: allGameGoalies.filter(
          (g) =>
            g.home_goalie?.confirmation === "Unconfirmed" &&
            g.away_goalie?.confirmation === "Unconfirmed"
        ).length,
        games: allGameGoalies,
      };
    },
    entityType: 'stat',
    renderType: 'stat-card',
    promptHint: 'NHL starting goalies. Confirmation status is critical — clearly distinguish Confirmed vs Unconfirmed starters. Report SV% and GAA exactly.',
  },

  // ═══════════════════════════════════════════════════════════════════
  //  GET NHL BOXSCORE — Full game stats with goalie & skater lines
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "get_nhl_boxscore",
      description:
        "Get the full boxscore for a specific NHL game. Returns individual player stats for forwards (G, A, +/-, PIM, SOG, TOI, hits, blocks), defensemen, and goalies (saves, shots against, save %, GAA, starter flag). Also includes scoring summary and team game stats. The gameId can be found using get_nhl_schedule.",
      schema: z.object({
        gameId: z
          .number()
          .int()
          .positive()
          .describe(
            "The NHL game ID from get_nhl_schedule (e.g., 2023021057)"
          ),
      }),
    },
    handler: async (args, context) => {
      // Fetch boxscore and landing in parallel
      const [boxData, landingData] = await Promise.all([
        nhlFetch<any>(
          `${NHL_API_BASE}/gamecenter/${args.gameId}/boxscore`,
          { signal: context.signal, timeoutMs: 10000 }
        ),
        nhlFetch<any>(
          `${NHL_API_BASE}/gamecenter/${args.gameId}/landing`,
          { signal: context.signal, timeoutMs: 10000 }
        ),
      ]);

      const mapSkater = (p: any) => ({
        name: p.name?.default || "?",
        number: p.sweaterNumber,
        position: p.position,
        goals: p.goals ?? 0,
        assists: p.assists ?? 0,
        points: p.points ?? 0,
        plus_minus: p.plusMinus ?? 0,
        pim: p.pim ?? 0,
        sog: p.sog ?? 0,
        hits: p.hits ?? 0,
        blocked_shots: p.blockedShots ?? 0,
        toi: p.toi || "0:00",
        faceoff_pct: p.faceoffWinningPctg ?? null,
        powerplay_goals: p.powerPlayGoals ?? 0,
        shifts: p.shifts ?? 0,
      });

      const mapGoalie = (g: any) => ({
        name: g.name?.default || "?",
        number: g.sweaterNumber,
        starter: g.starter || false,
        saves: g.saves ?? 0,
        shots_against: g.shotsAgainst ?? 0,
        save_pct:
          g.shotsAgainst > 0
            ? Number(((g.saves / g.shotsAgainst) * 100).toFixed(1))
            : null,
        goals_against: g.goalsAgainst ?? 0,
        toi: g.toi || "0:00",
        pim: g.pim ?? 0,
        ev_saves: g.evenStrengthShotsAgainst || null,
        pp_saves: g.powerPlayShotsAgainst || null,
        sh_saves: g.shorthandedShotsAgainst || null,
      });

      const mapTeam = (
        teamData: any,
        stats: any
      ) => ({
        abbrev: teamData?.abbrev,
        name: teamData?.commonName?.default || teamData?.abbrev,
        score: teamData?.score ?? 0,
        sog: teamData?.sog ?? 0,
        forwards: (stats?.forwards || []).map(mapSkater),
        defense: (stats?.defense || []).map(mapSkater),
        goalies: (stats?.goalies || []).map(mapGoalie),
      });

      const playerStats = boxData.playerByGameStats;

      // Scoring summary from landing
      const scoring = (landingData.summary?.scoring || []).map(
        (period: any) => ({
          period: period.periodDescriptor?.number,
          period_type: period.periodDescriptor?.periodType,
          goals: (period.goals || []).map((goal: any) => ({
            time: goal.timeInPeriod,
            scorer: goal.name?.default || "?",
            team: goal.teamAbbrev?.default || "?",
            strength: goal.strength || "ev",
            assists: (goal.assists || []).map(
              (a: any) => a.name?.default || "?"
            ),
            away_score: goal.awayScore,
            home_score: goal.homeScore,
          })),
        })
      );

      // Team game stats from landing
      const teamGameStats = (
        landingData.summary?.teamGameStats || []
      ).map((stat: any) => ({
        category: stat.category,
        away: stat.awayValue,
        home: stat.homeValue,
      }));

      return {
        gameId: args.gameId,
        matchup: `${boxData.awayTeam?.abbrev || "?"} @ ${boxData.homeTeam?.abbrev || "?"}`,
        game_state: boxData.gameState,
        venue: boxData.venue?.default || null,
        period: boxData.periodDescriptor?.number,
        clock: boxData.clock?.timeRemaining || null,
        home_team: mapTeam(
          boxData.homeTeam,
          playerStats?.homeTeam
        ),
        away_team: mapTeam(
          boxData.awayTeam,
          playerStats?.awayTeam
        ),
        scoring_summary: scoring,
        team_game_stats: teamGameStats,
        game_outcome: boxData.gameOutcome
          ? { type: boxData.gameOutcome.lastPeriodType }
          : null,
      };
    },
    entityType: 'game',
    renderType: 'game-card',
    promptHint: 'NHL boxscore. Report only stats present. Do not invent player statlines or scoring plays.',
  },

  // ═══════════════════════════════════════════════════════════════════
  //  GET NHL LINES — Roster by position (F / D / G)
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "get_nhl_lines",
      description:
        "Get the current roster for an NHL team, grouped by position (forwards, defensemen, goalies). Returns player names, jersey numbers, position codes (C/LW/RW/D/G), shooting hand, height, weight, and birth info. Use this to understand line combinations and defensive pairings. Accepts team name or abbreviation.",
      schema: z.object({
        team: z
          .string()
          .min(1)
          .describe(
            "Team name or abbreviation (e.g., 'Bruins', 'BOS', 'Toronto')"
          ),
      }),
    },
    handler: async (args, context) => {
      const abbrev = await resolveTeamAbbrev(args.team, context.signal);
      if (!abbrev) {
        const teams = await ensureTeamCache(context.signal);
        return {
          error: `Could not resolve team '${args.team}'.`,
          available_teams: teams?.map(
            (t) => `${t.name} (${t.abbrev})`
          ),
        };
      }

      const data = await nhlFetch<any>(
        `${NHL_API_BASE}/roster/${abbrev}/current`,
        { signal: context.signal, timeoutMs: 10000 }
      );

      const mapPlayer = (p: any) => ({
        id: p.id,
        name: `${p.firstName?.default || ""} ${p.lastName?.default || ""}`.trim(),
        number: p.sweaterNumber,
        position: p.positionCode,
        shoots_catches: p.shootsCatches,
        height: `${Math.floor((p.heightInInches || 0) / 12)}'${(p.heightInInches || 0) % 12}"`,
        weight: p.weightInPounds,
        birth_date: p.birthDate,
        birth_country: p.birthCountry,
      });

      const forwards = (data.forwards || []).map(mapPlayer);
      const defensemen = (data.defensemen || []).map(mapPlayer);
      const goalies = (data.goalies || []).map(mapPlayer);

      // Group forwards by position for line estimation
      const centers = forwards.filter((f: any) => f.position === "C");
      const leftWings = forwards.filter((f: any) => f.position === "L");
      const rightWings = forwards.filter((f: any) => f.position === "R");

      return {
        team: abbrev,
        total_players: forwards.length + defensemen.length + goalies.length,
        forwards: {
          total: forwards.length,
          centers: centers.length,
          left_wings: leftWings.length,
          right_wings: rightWings.length,
          players: forwards,
        },
        defensemen: {
          total: defensemen.length,
          players: defensemen,
        },
        goalies: {
          total: goalies.length,
          players: goalies,
        },
      };
    },
    entityType: 'team',
    renderType: 'team-card',
    promptHint: 'NHL roster/lines. Report position codes and player info as listed. Do not fabricate line combinations.',
  },

  // ═══════════════════════════════════════════════════════════════════
  //  GET NHL STANDINGS — Conference / Division standings
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "get_nhl_standings",
      description:
        "Get current NHL standings from the official NHL API. Returns all 32 teams with wins, losses, OT losses, points, point percentage, goal differential, home/road splits, last 10, and current streak. Grouped by division and conference. Optionally filter by conference (Eastern/Western).",
      schema: z.object({
        date: z
          .string()
          .optional()
          .describe(
            "Date for standings snapshot (YYYY-MM-DD). Default: current"
          ),
        conference: z
          .enum(["Eastern", "Western", "all"])
          .optional()
          .describe(
            "Filter by conference: 'Eastern', 'Western', or 'all'. Default: all"
          ),
      }),
    },
    handler: async (args, context) => {
      const datePart = args.date
        ? getNhlTargetDate(args.date)
        : "now";

      const data = await nhlFetch<any>(
        `${NHL_API_BASE}/standings/${datePart}`,
        { signal: context.signal, timeoutMs: 10000 }
      );

      let teams = (data.standings || []).map((t: any) => ({
        abbrev: t.teamAbbrev?.default || "?",
        name: t.teamName?.default || "?",
        common_name: t.teamCommonName?.default || "?",
        conference: t.conferenceName || "?",
        division: t.divisionName || "?",
        games_played: t.gamesPlayed,
        wins: t.wins,
        losses: t.losses,
        ot_losses: t.otLosses,
        points: t.points,
        point_pct: Number((t.pointPctg || 0).toFixed(3)),
        regulation_wins: t.regulationWins,
        goal_for: t.goalFor,
        goal_against: t.goalAgainst,
        goal_diff: t.goalDifferential,
        home: `${t.homeWins}-${t.homeLosses}-${t.homeOtLosses}`,
        road: `${t.roadWins}-${t.roadLosses}-${t.roadOtLosses}`,
        last_10: `${t.l10Wins}-${t.l10Losses}-${t.l10OtLosses}`,
        streak: `${t.streakCode}${t.streakCount}`,
        conference_rank: t.conferenceSequence,
        division_rank: t.divisionSequence,
        wildcard_rank: t.wildcardSequence,
      }));

      // Filter by conference
      if (args.conference && args.conference !== "all") {
        teams = teams.filter(
          (t: any) => t.conference === args.conference
        );
      }

      // Group by division
      const byDivision: Record<string, any[]> = {};
      for (const t of teams) {
        if (!byDivision[t.division]) byDivision[t.division] = [];
        byDivision[t.division].push(t);
      }

      // Sort each division by points
      for (const div of Object.values(byDivision)) {
        div.sort(
          (a: any, b: any) =>
            b.points - a.points ||
            b.regulation_wins - a.regulation_wins
        );
      }

      return {
        date: datePart,
        total_teams: teams.length,
        standings_by_division: byDivision,
      };
    },
    entityType: 'standings',
    renderType: 'standings-table',
    promptHint: 'NHL standings. Report records, points, and streaks exactly. Do not compute playoff probabilities not in the data.',
  },

  // ═══════════════════════════════════════════════════════════════════
  //  SEARCH NHL PLAYER — Name-based player search
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "search_nhl_player",
      description:
        "Search for an NHL player by name. Returns matching player IDs, teams, positions, height, weight, and nationality. Use the returned player ID with get_nhl_player_stats. Searches active NHL players.",
      schema: z.object({
        name: z
          .string()
          .min(1)
          .describe(
            "Player name to search for (e.g., 'McDavid', 'Auston Matthews')"
          ),
      }),
    },
    handler: async (args, context) => {
      const data = await nhlFetch<any[]>(
        `${NHL_SEARCH_BASE}/search/player?culture=en-us&limit=10&q=${encodeURIComponent(args.name)}&active=true`,
        { signal: context.signal, timeoutMs: 10000 }
      );

      if (!Array.isArray(data) || data.length === 0) {
        return {
          message: `No active NHL players found matching '${args.name}'.`,
          suggestion:
            "Try using just the last name, or check spelling.",
        };
      }

      return {
        results: data.length,
        players: data.map((p: any) => ({
          id: Number(p.playerId),
          name: p.name,
          team: p.teamAbbrev || "?",
          position: p.positionCode,
          number: p.sweaterNumber,
          height: p.height || `${Math.floor((p.heightInInches || 0) / 12)}'${(p.heightInInches || 0) % 12}"`,
          weight: p.weightInPounds,
          birth_country: p.birthCountry,
          active: p.active,
        })),
      };
    },
    entityType: 'player',
    renderType: 'player-card',
    promptHint: 'NHL player search results. Use returned player IDs for follow-up stat queries.',
  },

  // ═══════════════════════════════════════════════════════════════════
  //  GET NHL PLAYER STATS — Season stats for a player
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "get_nhl_player_stats",
      description:
        "Get season and career statistics for a specific NHL player. For skaters: goals, assists, points, +/-, PIM, PPG, SHG, GWG, SOG, shooting %, TOI. For goalies: GAA, SV%, wins, losses, OTL, shutouts. Also includes last 5 games and career totals. Use search_nhl_player first to find the player ID.",
      schema: z.object({
        playerId: z
          .number()
          .int()
          .positive()
          .describe(
            "The NHL player ID from search_nhl_player (e.g., 8478402)"
          ),
      }),
    },
    handler: async (args, context) => {
      const data = await nhlFetch<any>(
        `${NHL_API_BASE}/player/${args.playerId}/landing`,
        { signal: context.signal, timeoutMs: 10000 }
      );

      const isGoalie = data.position === "G";

      // Featured stats (current season)
      const featured = data.featuredStats?.regularSeason?.subSeason;
      const careerReg = data.careerTotals?.regularSeason;

      // Last 5 games
      const last5 = (data.last5Games || []).map((g: any) => {
        if (isGoalie) {
          return {
            date: g.gameDate,
            opponent: g.opponentAbbrev,
            decision: g.decision,
            goals_against: g.goalsAgainst,
            saves: g.savePctg
              ? Number((g.savePctg * 100).toFixed(1))
              : null,
            shots_against: g.shotsAgainst,
            toi: g.toi,
          };
        }
        return {
          date: g.gameDate,
          opponent: g.opponentAbbrev,
          goals: g.goals,
          assists: g.assists,
          points: g.points,
          plus_minus: g.plusMinus,
          pim: g.pim,
          sog: g.shots,
          toi: g.toi,
        };
      });

      const result: Record<string, any> = {
        player_id: args.playerId,
        name: `${data.firstName?.default || ""} ${data.lastName?.default || ""}`.trim(),
        team: data.currentTeamAbbrev || "?",
        position: data.position || "?",
        number: data.sweaterNumber,
        shoots_catches: data.shootsCatches,
        is_goalie: isGoalie,
      };

      if (isGoalie) {
        result.current_season = featured
          ? {
              games_played: featured.gamesPlayed,
              gaa: Number(featured.goalsAgainstAvg?.toFixed(2)),
              save_pct: Number(
                (featured.savePctg * 100)?.toFixed(1)
              ),
              record: `${featured.wins}-${featured.losses}-${featured.otLosses}`,
              shutouts: featured.shutouts,
            }
          : null;
        result.career = careerReg
          ? {
              games_played: careerReg.gamesPlayed,
              gaa: Number(careerReg.goalsAgainstAvg?.toFixed(2)),
              save_pct: Number(
                (careerReg.savePctg * 100)?.toFixed(1)
              ),
              record: `${careerReg.wins}-${careerReg.losses}-${careerReg.otLosses}`,
              shutouts: careerReg.shutouts,
            }
          : null;
      } else {
        result.current_season = featured
          ? {
              games_played: featured.gamesPlayed,
              goals: featured.goals,
              assists: featured.assists,
              points: featured.points,
              plus_minus: featured.plusMinus,
              pim: featured.pim,
              ppg: featured.powerPlayGoals,
              gwg: featured.gameWinningGoals,
              sog: featured.shots,
              shooting_pct: Number(
                (featured.shootingPctg * 100)?.toFixed(1)
              ),
            }
          : null;
        result.career = careerReg
          ? {
              games_played: careerReg.gamesPlayed,
              goals: careerReg.goals,
              assists: careerReg.assists,
              points: careerReg.points,
              plus_minus: careerReg.plusMinus,
              ppg: careerReg.powerPlayGoals,
            }
          : null;
      }

      result.last_5_games = last5;

      return result;
    },
    entityType: 'player',
    renderType: 'player-card',
    promptHint: 'NHL player stats. Report only stats present. For goalies report GAA and SV% exactly. For skaters report points, +/-, and TOI exactly.',
  },

  // ═══════════════════════════════════════════════════════════════════
  //  GET NHL TEAMS — All 32 teams with abbreviations
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "get_nhl_teams",
      description:
        "Get all 32 NHL teams with their abbreviations, names, conferences, and divisions. Use this to resolve team names to abbreviations for other tools.",
      schema: z.object({}),
    },
    handler: async (_args, context) => {
      const teams = await ensureTeamCache(context.signal);

      // Group by conference → division
      const grouped: Record<
        string,
        Record<string, NhlTeamCacheEntry[]>
      > = {};
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
            abbrev: t.abbrev,
            name: t.name,
            common_name: t.commonName,
          }));
        }
      }

      return {
        total_teams: teams.length,
        teams_by_conference: formatted,
      };
    },
    entityType: 'team',
    renderType: 'team-card',
    promptHint: 'NHL team directory. Report team info as listed.',
  },
];
