import { z } from "zod";
import { RegisteredTool } from "./types";
import { logger } from "../utils/logger";

// ============================================================================
// NFL ESPN & Core API Tools
// ────────────────────────────────────────────────────────────────────
// NFL game data from ESPN's unofficial APIs (site.api.espn.com +
// sports.core.api.espn.com). No API key required.
//
// Provides schedules with embedded odds/weather/venue, full game
// summaries with drive-by-drive data, depth charts (via roster),
// standings, and team info.
//
// The NFL calendar is week-based (Week 1-18 regular, plus playoffs).
// All date/week resolution uses the America/New_York timezone.
// ============================================================================

const ESPN_NFL_BASE =
  "https://site.api.espn.com/apis/site/v2/sports/football/nfl";

// ── Helpers ─────────────────────────────────────────────────────────

async function nflFetch<T = any>(
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
      `ESPN NFL API returned ${res.status}: ${body.slice(0, 500)}`
    );
  }

  return res.json() as Promise<T>;
}

/**
 * Resolves a date string to YYYYMMDD format in America/New_York.
 */
function getNflTargetDate(dateStr?: string): string {
  const formatET = (d: Date) => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
    return parts.replace(/-/g, "");
  };

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

  // ISO: 2024-09-08
  const iso = lower.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[1]}${iso[2]}${iso[3]}`;

  // Compact: 20240908
  if (/^\d{8}$/.test(lower)) return lower;

  // US: 9/8 or 9/8/24
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
    return `${year}${us[1].padStart(2, "0")}${us[2].padStart(2, "0")}`;
  }

  return formatET(new Date());
}

/**
 * Returns the current NFL season year (e.g. 2024 for the 2024-25 season).
 * NFL season runs Sep → Feb. Before September → previous year.
 */
function getCurrentNflSeasonYear(): number {
  const etParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "numeric",
  }).formatToParts(new Date());
  const year = Number(etParts.find((p) => p.type === "year")!.value);
  const month = Number(etParts.find((p) => p.type === "month")!.value);
  return month >= 9 ? year : year - 1;
}

// ── Team Cache ──────────────────────────────────────────────────────

interface NflTeamCacheEntry {
  id: string;
  abbreviation: string;
  displayName: string;
  shortName: string;
  slug: string;
}

let teamCache: NflTeamCacheEntry[] | null = null;
let teamCacheLoadedAt = 0;
const TEAM_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

async function ensureTeamCache(
  signal?: AbortSignal
): Promise<NflTeamCacheEntry[]> {
  const now = Date.now();
  if (teamCache && now - teamCacheLoadedAt < TEAM_CACHE_TTL_MS) {
    return teamCache;
  }

  const data = await nflFetch<any>(`${ESPN_NFL_BASE}/teams`, {
    signal,
    timeoutMs: 10000,
  });

  const rawTeams =
    data.sports?.[0]?.leagues?.[0]?.teams || [];

  teamCache = rawTeams.map((t: any) => ({
    id: t.team?.id || "",
    abbreviation: t.team?.abbreviation || "",
    displayName: t.team?.displayName || "",
    shortName: t.team?.shortDisplayName || t.team?.name || "",
    slug: t.team?.slug || "",
  }));

  teamCacheLoadedAt = Date.now();
  return teamCache;
}

/**
 * Resolves team name/abbreviation/city to ESPN team ID.
 */
async function resolveTeamId(
  input: string,
  signal?: AbortSignal
): Promise<string | null> {
  const teams = await ensureTeamCache(signal);
  const lower = input.toLowerCase().trim();

  // Exact ID
  const byId = teams.find((t) => t.id === lower);
  if (byId) return byId.id;

  // Exact abbreviation
  const byAbbr = teams.find(
    (t) => t.abbreviation.toLowerCase() === lower
  );
  if (byAbbr) return byAbbr.id;

  // Slug
  const bySlug = teams.find((t) => t.slug === lower);
  if (bySlug) return bySlug.id;

  // Fuzzy name
  const byName = teams.find(
    (t) =>
      t.displayName.toLowerCase().includes(lower) ||
      t.shortName.toLowerCase().includes(lower) ||
      lower.includes(t.shortName.toLowerCase()) ||
      lower.includes(t.slug)
  );
  return byName?.id ?? null;
}

// ── Helper: Extract team stat from ESPN boxscore ────────────────────

function getTeamStat(
  stats: any[],
  name: string
): { displayValue: string; value: any } {
  const found = (stats || []).find((s: any) => s.name === name);
  return found || { displayValue: "-", value: null };
}

// ── Tools ───────────────────────────────────────────────────────────

export const nflTools: RegisteredTool<any>[] = [
  // ═══════════════════════════════════════════════════════════════════
  //  GET NFL SCHEDULE — Week's games with odds, weather, venue
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "get_nfl_schedule",
      description:
        "Get the NFL game schedule for a specific week or date from ESPN. Returns game IDs, scores, game status (upcoming/live/final), venue info (dome vs outdoor), weather forecasts for outdoor games, embedded point spreads and over/unders, team records, and broadcast info. Supports week-based queries (week 1-18 regular season, plus playoffs) or date-based queries.",
      schema: z.object({
        week: z
          .number()
          .int()
          .min(1)
          .max(22)
          .optional()
          .describe(
            "NFL week number (1-18 regular season, 19-22 playoffs). If omitted, uses the date parameter or defaults to current week."
          ),
        season: z
          .number()
          .int()
          .min(2000)
          .max(new Date().getFullYear() + 1)
          .optional()
          .describe("NFL season year. Default: current season"),
        seasonType: z
          .enum(["preseason", "regular", "postseason"])
          .optional()
          .describe(
            "Season type. 'preseason' = 1, 'regular' = 2, 'postseason' = 3. Default: regular"
          ),
        date: z
          .string()
          .optional()
          .describe(
            "Specific date (YYYY-MM-DD, YYYYMMDD, or natural language). Overrides week if provided."
          ),
        team: z
          .string()
          .optional()
          .describe(
            "Team name, abbreviation, or ESPN ID to filter by (e.g., 'Chiefs', 'KC', '12')"
          ),
      }),
    },
    handler: async (args, context) => {
      let url: string;
      let dateLabel: string;

      if (args.date) {
        // Date-based query — gets odds + weather inline
        const yyyymmdd = getNflTargetDate(args.date);
        url = `${ESPN_NFL_BASE}/scoreboard?dates=${yyyymmdd}&limit=50`;
        dateLabel = `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
      } else {
        // Week-based query
        const season = args.season || getCurrentNflSeasonYear();
        const seasonTypeMap = { preseason: 1, regular: 2, postseason: 3 };
        const seasonType = seasonTypeMap[args.seasonType || "regular"];
        const week = args.week || "";
        url = `${ESPN_NFL_BASE}/scoreboard?season=${season}&seasontype=${seasonType}${week ? `&week=${week}` : ""}&limit=50`;
        dateLabel = `${season} ${args.seasonType || "regular"} season${week ? `, week ${week}` : ""}`;
      }

      const data = await nflFetch<any>(url, {
        signal: context.signal,
        timeoutMs: 10000,
      });

      let filterTeamId: string | null = null;
      if (args.team) {
        filterTeamId = await resolveTeamId(args.team, context.signal);
      }

      let games = (data.events || []).map((ev: any) => {
        const comp = ev.competitions?.[0];
        const home = comp?.competitors?.find(
          (c: any) => c.homeAway === "home"
        );
        const away = comp?.competitors?.find(
          (c: any) => c.homeAway === "away"
        );
        const status = comp?.status || ev.status;

        // Parse odds
        const oddsData = comp?.odds?.[0];
        const odds = oddsData
          ? {
              provider: oddsData.provider?.name || "Unknown",
              spread: oddsData.details || null,
              over_under: oddsData.overUnder ?? null,
              spread_winner: oddsData.spread
                ? `${
                    oddsData.spread > 0
                      ? away?.team?.abbreviation
                      : home?.team?.abbreviation
                  } ${Math.abs(oddsData.spread)}`
                : null,
            }
          : null;

        // Parse weather
        const weather = comp?.weather
          ? {
              temperature: comp.weather.temperature,
              condition: comp.weather.displayValue || comp.weather.conditionId,
              humidity: comp.weather.humidity,
              wind_speed: comp.weather.windSpeed,
              wind_gust: comp.weather.windGust,
            }
          : null;

        // Parse venue
        const venue = comp?.venue
          ? {
              name: comp.venue.fullName,
              city: comp.venue.address?.city,
              state: comp.venue.address?.state,
              indoor: comp.venue.indoor ?? false,
            }
          : null;

        // Status
        const gameStatus =
          status?.type?.state === "pre"
            ? "upcoming"
            : status?.type?.state === "in"
              ? "live"
              : "final";

        return {
          event_id: ev.id,
          matchup: ev.shortName || `${away?.team?.abbreviation || "?"} @ ${home?.team?.abbreviation || "?"}`,
          status: gameStatus,
          status_text: status?.type?.detail || status?.type?.description || "",
          game_time: ev.date,
          home_team: {
            id: home?.team?.id,
            name: home?.team?.displayName,
            abbreviation: home?.team?.abbreviation,
            record: home?.records?.[0]?.summary || "",
            score: Number(home?.score) || 0,
          },
          away_team: {
            id: away?.team?.id,
            name: away?.team?.displayName,
            abbreviation: away?.team?.abbreviation,
            record: away?.records?.[0]?.summary || "",
            score: Number(away?.score) || 0,
          },
          venue,
          weather,
          odds,
          broadcast: comp?.broadcasts?.[0]?.names?.[0] || comp?.broadcast || null,
        };
      });

      // Filter by team
      if (filterTeamId) {
        games = games.filter(
          (g: any) =>
            g.home_team.id === filterTeamId ||
            g.away_team.id === filterTeamId
        );
      }

      return {
        label: dateLabel,
        total_games: games.length,
        live: games.filter((g: any) => g.status === "live").length,
        final: games.filter((g: any) => g.status === "final").length,
        upcoming: games.filter((g: any) => g.status === "upcoming").length,
        games,
      };
    },
  },

  // ═══════════════════════════════════════════════════════════════════
  //  GET NFL BOXSCORE — Full game summary with drives & red zone
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "get_nfl_boxscore",
      description:
        "Get the full boxscore and game summary for a specific NFL game. Returns team stats (1st downs, 3rd/4th down efficiency, total yards, passing/rushing splits, turnovers, time of possession), individual player stats (passing, rushing, receiving, defense), drive-by-drive data (plays, yards, result, time), and scoring plays. The event_id can be found using get_nfl_schedule.",
      schema: z.object({
        event_id: z
          .string()
          .min(1)
          .describe("The ESPN event ID from get_nfl_schedule"),
        includeDrives: z
          .boolean()
          .optional()
          .describe(
            "Whether to include drive-by-drive data. Default: true"
          ),
      }),
    },
    handler: async (args, context) => {
      const data = await nflFetch<any>(
        `${ESPN_NFL_BASE}/summary?event=${args.event_id}`,
        { signal: context.signal, timeoutMs: 12000 }
      );

      const bs = data.boxscore;
      const header = data.header;
      const gameInfo = data.gameInfo;

      if (!bs) {
        return {
          error: `No boxscore data found for event ${args.event_id}.`,
        };
      }

      // Team stats
      const teamStats = (bs.teams || []).map((t: any) => {
        const stats = t.statistics || [];
        return {
          team: t.team?.abbreviation || "?",
          team_name: t.team?.displayName || "?",
          side: t.homeAway,
          first_downs: getTeamStat(stats, "firstDowns").displayValue,
          third_down_eff: getTeamStat(stats, "thirdDownEff").displayValue,
          fourth_down_eff: getTeamStat(stats, "fourthDownEff").displayValue,
          total_yards: getTeamStat(stats, "totalYards").displayValue,
          total_plays: getTeamStat(stats, "totalOffensivePlays").displayValue,
          yards_per_play: getTeamStat(stats, "yardsPerPlay").displayValue,
          passing_yards: getTeamStat(stats, "netPassingYards").displayValue,
          comp_att: getTeamStat(stats, "completionAttempts").displayValue,
          yards_per_pass: getTeamStat(stats, "yardsPerPass").displayValue,
          interceptions: getTeamStat(stats, "interceptions").displayValue,
          sacks: getTeamStat(stats, "sacksYardsLost").displayValue,
          rushing_yards: getTeamStat(stats, "rushingYards").displayValue,
          rushing_attempts: getTeamStat(stats, "rushingAttempts").displayValue,
          yards_per_rush: getTeamStat(stats, "yardsPerRushAttempt").displayValue,
          red_zone: getTeamStat(stats, "redZoneAttempts").displayValue,
          penalties: getTeamStat(stats, "totalPenaltiesYards").displayValue,
          turnovers: getTeamStat(stats, "turnovers").displayValue,
          fumbles_lost: getTeamStat(stats, "fumblesLost").displayValue,
          possession_time: getTeamStat(stats, "possessionTime").displayValue,
        };
      });

      // Player stats (passing, rushing, receiving, defense)
      const playerStats = (bs.players || []).map((teamPlayers: any) => {
        const categories = (teamPlayers.statistics || []).map(
          (cat: any) => ({
            category: cat.name,
            labels: cat.labels,
            players: (cat.athletes || []).map((a: any) => ({
              name: a.athlete?.displayName || "?",
              stats: a.stats,
            })),
          })
        );

        return {
          team: teamPlayers.team?.abbreviation || "?",
          categories,
        };
      });

      // Scoring plays
      const scoringPlays = (data.scoringPlays || []).map((sp: any) => ({
        quarter: sp.period?.number || 0,
        clock: sp.clock?.displayValue || "",
        team: sp.team?.abbreviation || "?",
        type: sp.type?.text || "",
        description: sp.text || "",
        away_score: sp.awayScore,
        home_score: sp.homeScore,
      }));

      // Drives
      let drives = null;
      if (args.includeDrives !== false && data.drives?.previous) {
        drives = (data.drives.previous || []).map((d: any) => ({
          team: d.team?.abbreviation || "?",
          description: d.description || "",
          result: d.displayResult || d.result || "",
          plays: d.offensivePlays ?? null,
          yards: d.yards ?? null,
          time_of_possession: d.timeOfPossession?.displayValue || null,
          start_position: d.start?.text || null,
          is_score: d.isScore || false,
        }));
      }

      // Game info
      const venue = gameInfo?.venue;
      const attendance = gameInfo?.attendance;

      return {
        event_id: args.event_id,
        venue: venue
          ? {
              name: venue.fullName,
              city: venue.address?.city,
              state: venue.address?.state,
              grass: venue.grass,
            }
          : null,
        attendance,
        team_stats: teamStats,
        player_stats: playerStats,
        scoring_plays: scoringPlays,
        drives,
        total_drives: drives?.length || 0,
      };
    },
  },

  // ═══════════════════════════════════════════════════════════════════
  //  GET NFL DEPTH CHART — Roster grouped by position
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "get_nfl_depth_chart",
      description:
        "Get the full roster for an NFL team, grouped by position (offense, defense, special teams). Returns player names, jersey numbers, positions, height, weight, and experience. Essential for knowing who gets targets/carries if a starter is out. Accepts team name, abbreviation, or ESPN team ID.",
      schema: z.object({
        team: z
          .string()
          .min(1)
          .describe(
            "Team name, abbreviation, or ESPN ID (e.g., 'Chiefs', 'KC', '12')"
          ),
        positionGroup: z
          .enum(["offense", "defense", "specialTeams", "all"])
          .optional()
          .describe("Filter by position group. Default: all"),
      }),
    },
    handler: async (args, context) => {
      const teamId = await resolveTeamId(args.team, context.signal);
      if (!teamId) {
        const teams = await ensureTeamCache(context.signal);
        return {
          error: `Could not resolve team '${args.team}'.`,
          available_teams: teams
            ?.map((t) => `${t.displayName} (${t.abbreviation}, ID: ${t.id})`)
            .slice(0, 10),
        };
      }

      const data = await nflFetch<any>(
        `${ESPN_NFL_BASE}/teams/${teamId}/roster`,
        { signal: context.signal, timeoutMs: 10000 }
      );

      const positionGroups = (data.athletes || []).map((group: any) => {
        const players = (group.items || []).map((p: any) => ({
          id: p.id,
          name: p.displayName || p.fullName || "?",
          number: p.jersey || "?",
          position: p.position?.abbreviation || "?",
          height: p.displayHeight || "?",
          weight: p.displayWeight || "?",
          experience: p.experience?.years ?? 0,
          age: p.age ?? null,
          college: p.college?.name || null,
          status: p.injuries?.[0]?.status || p.status?.type || "active",
          injury_detail: p.injuries?.[0]
            ? {
                type: p.injuries[0].type,
                detail: p.injuries[0].detail?.fantasyStatus?.description || p.injuries[0].detail?.type || null,
                body_part: p.injuries[0].detail?.location || null,
              }
            : null,
        }));

        return {
          group: group.position || "unknown",
          count: players.length,
          players,
        };
      });

      // Filter by group if requested
      let filtered = positionGroups;
      if (args.positionGroup && args.positionGroup !== "all") {
        filtered = positionGroups.filter(
          (g: any) => g.group === args.positionGroup
        );
      }

      const teamInfo = data.team;

      return {
        team_id: teamId,
        team: teamInfo?.displayName || "?",
        abbreviation: teamInfo?.abbreviation || "?",
        coach: data.coach?.[0]?.displayName || null,
        total_players: filtered.reduce(
          (sum: number, g: any) => sum + g.count,
          0
        ),
        position_groups: filtered,
      };
    },
  },

  // ═══════════════════════════════════════════════════════════════════
  //  GET NFL PRACTICE REPORT — Injury / availability status
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "get_nfl_practice_report",
      description:
        "Get the injury and practice participation report for an NFL team. Returns players with injury designations (Out, Doubtful, Questionable, Probable), injury types, and affected body parts. Critical for betting — late scratches of key players (WR1, starting QB) dramatically shift lines. Data sourced from ESPN injury reports.",
      schema: z.object({
        team: z
          .string()
          .min(1)
          .describe(
            "Team name, abbreviation, or ESPN ID (e.g., 'Chiefs', 'KC')"
          ),
      }),
    },
    handler: async (args, context) => {
      const teamId = await resolveTeamId(args.team, context.signal);
      if (!teamId) {
        const teams = await ensureTeamCache(context.signal);
        return {
          error: `Could not resolve team '${args.team}'.`,
          available_teams: teams
            ?.map((t) => `${t.displayName} (${t.abbreviation}, ID: ${t.id})`)
            .slice(0, 10),
        };
      }

      // Pull roster which includes injury status inline
      const data = await nflFetch<any>(
        `${ESPN_NFL_BASE}/teams/${teamId}/roster`,
        { signal: context.signal, timeoutMs: 10000 }
      );

      const injuries: any[] = [];

      for (const group of data.athletes || []) {
        for (const player of group.items || []) {
          if (
            player.injuries?.length > 0 ||
            (player.status?.type && player.status.type !== "active")
          ) {
            const injury = player.injuries?.[0];
            injuries.push({
              name: player.displayName || player.fullName || "?",
              position: player.position?.abbreviation || "?",
              number: player.jersey || "?",
              status:
                injury?.status ||
                player.status?.type ||
                "Unknown",
              designation:
                injury?.detail?.fantasyStatus?.description ||
                injury?.detail?.type ||
                player.status?.type ||
                null,
              body_part: injury?.detail?.location || null,
              injury_type: injury?.type || null,
              return_date: injury?.detail?.returnDate || null,
            });
          }
        }
      }

      // Sort by severity: Out > Doubtful > Questionable > Probable > other
      const severityOrder: Record<string, number> = {
        out: 0,
        "injured reserve": 1,
        doubtful: 2,
        questionable: 3,
        probable: 4,
      };

      injuries.sort((a, b) => {
        const aOrder =
          severityOrder[
            (a.status || "").toLowerCase()
          ] ?? 5;
        const bOrder =
          severityOrder[
            (b.status || "").toLowerCase()
          ] ?? 5;
        return aOrder - bOrder;
      });

      const teamInfo = data.team;

      return {
        team: teamInfo?.displayName || "?",
        abbreviation: teamInfo?.abbreviation || "?",
        total_injured: injuries.length,
        out: injuries.filter(
          (i) =>
            (i.status || "").toLowerCase() === "out" ||
            (i.status || "").toLowerCase() === "injured reserve"
        ).length,
        questionable: injuries.filter(
          (i) => (i.status || "").toLowerCase() === "questionable"
        ).length,
        doubtful: injuries.filter(
          (i) => (i.status || "").toLowerCase() === "doubtful"
        ).length,
        injuries,
      };
    },
  },

  // ═══════════════════════════════════════════════════════════════════
  //  GET NFL STANDINGS — Conference / Division standings
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "get_nfl_standings",
      description:
        "Get current NFL standings from ESPN. Returns all 32 teams grouped by conference with win-loss records, winning percentage, point differential, home/road records, division records, conference records, playoff seed, and current streak.",
      schema: z.object({
        season: z
          .number()
          .int()
          .min(2000)
          .max(new Date().getFullYear() + 1)
          .optional()
          .describe("NFL season year. Default: current season"),
        conference: z
          .enum(["AFC", "NFC", "all"])
          .optional()
          .describe(
            "Filter by conference: 'AFC', 'NFC', or 'all'. Default: all"
          ),
      }),
    },
    handler: async (args, context) => {
      const season = args.season || getCurrentNflSeasonYear();

      const data = await nflFetch<any>(
        `https://site.api.espn.com/apis/v2/sports/football/nfl/standings?season=${season}`,
        { signal: context.signal, timeoutMs: 10000 }
      );

      const conferences = (data.children || []).map((conf: any) => {
        const entries = (conf.standings?.entries || []).map((entry: any) => {
          const stats = entry.stats || [];
          const getStat = (name: string) =>
            stats.find((s: any) => s.name === name);

          return {
            team: entry.team?.displayName || "?",
            abbreviation: entry.team?.abbreviation || "?",
            team_id: entry.team?.id,
            wins: getStat("wins")?.value ?? 0,
            losses: getStat("losses")?.value ?? 0,
            ties: getStat("ties")?.value ?? 0,
            win_pct: getStat("winPercent")?.value ?? 0,
            playoff_seed: getStat("playoffSeed")?.value ?? null,
            points_for: getStat("pointsFor")?.value ?? 0,
            points_against: getStat("pointsAgainst")?.value ?? 0,
            point_diff: getStat("pointDifferential")?.value ?? 0,
            streak: getStat("streak")?.value ?? 0,
            clincher: getStat("clincher")?.value ?? null,
            division_wins: getStat("divisionWins")?.value ?? 0,
            division_losses: getStat("divisionLosses")?.value ?? 0,
            overall: getStat("overall")?.displayValue || null,
            home: getStat("Home")?.displayValue || null,
            road: getStat("Road")?.displayValue || null,
            vs_division: getStat("vs. Div.")?.displayValue || null,
            vs_conference: getStat("vs. Conf.")?.displayValue || null,
          };
        });

        // Sort by playoff seed
        entries.sort(
          (a: any, b: any) =>
            (a.playoff_seed ?? 99) - (b.playoff_seed ?? 99)
        );

        return {
          conference: conf.name || "?",
          abbreviation: conf.abbreviation || "?",
          teams: entries,
        };
      });

      // Filter by conference
      let result = conferences;
      if (args.conference && args.conference !== "all") {
        result = conferences.filter((c: any) =>
          c.abbreviation
            ?.toUpperCase()
            .includes(args.conference!.toUpperCase()) ||
          c.conference
            ?.toLowerCase()
            .includes(args.conference!.toLowerCase())
        );
      }

      return {
        season,
        total_teams: result.reduce(
          (sum: number, c: any) => sum + c.teams.length,
          0
        ),
        standings: result,
      };
    },
  },

  // ═══════════════════════════════════════════════════════════════════
  //  GET NFL TEAMS — All 32 teams with IDs
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "get_nfl_teams",
      description:
        "Get all 32 NFL teams with their ESPN IDs, abbreviations, and display names. Use this to resolve team names to IDs for other tools.",
      schema: z.object({}),
    },
    handler: async (_args, context) => {
      const teams = await ensureTeamCache(context.signal);

      return {
        total_teams: teams.length,
        teams: teams.map((t) => ({
          id: t.id,
          name: t.displayName,
          abbreviation: t.abbreviation,
          slug: t.slug,
        })),
      };
    },
  },
];
