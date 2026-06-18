/**
 * MLB Stats API Client
 * Interfaces with statsapi.mlb.com for player splits, BvP, game context, and lineups.
 * No API key required — public endpoint.
 */

const MLB_API = "https://statsapi.mlb.com/api/v1";

// ── Types ────────────────────────────────────────────────────────────────────

export interface SplitStat {
  gamesPlayed: number;
  atBats: number;
  hits: number;
  homeRuns: number;
  rbi: number;
  strikeOuts: number;
  baseOnBalls: number;
  avg: string;
  obp: string;
  slg: string;
  ops: string;
  plateAppearances: number;
}

export interface SplitResult {
  splitType: string;
  splitLabel: string;
  season: number;
  stat: SplitStat;
}

export interface BvPResult {
  batterId: number;
  batterName: string;
  pitcherId: number;
  pitcherName: string;
  stats: {
    atBats: number;
    hits: number;
    homeRuns: number;
    strikeOuts: number;
    baseOnBalls: number;
    avg: string;
    obp: string;
    slg: string;
    ops: string;
  };
}

export interface GameEnvironment {
  gamePk: number;
  venue: {
    id: number;
    name: string;
    city: string;
    state: string;
    roof: string;
    capacity: number;
    surfaceType: string;
    leftLine: number | null;
    leftCenter: number | null;
    center: number | null;
    rightCenter: number | null;
    rightLine: number | null;
  };
  weather: {
    condition: string;
    temp: string;
    wind: string;
  } | null;
  gameDate: string;
  status: string;
}

export interface LineupPlayer {
  id: number;
  fullName: string;
  position: string;
  battingOrder: string;
  bats: string;
  throws: string;
  seasonStats: {
    avg: string;
    ops: string;
    homeRuns: number;
  } | null;
}

export interface LineupResult {
  gamePk: number;
  away: {
    team: string;
    teamId: number;
    pitcher: { id: number; fullName: string; era: string; wins: number; losses: number } | null;
    battingOrder: LineupPlayer[];
  };
  home: {
    team: string;
    teamId: number;
    pitcher: { id: number; fullName: string; era: string; wins: number; losses: number } | null;
    battingOrder: LineupPlayer[];
  };
}

export interface PlayerSearchResult {
  id: number;
  fullName: string;
  team: string;
  position: string;
}

// ── Sit Code Mapping ─────────────────────────────────────────────────────────

const SPLIT_SIT_CODES: Record<string, { code: string; label: string }> = {
  vsLeft: { code: "vl", label: "vs LHP" },
  vsRight: { code: "vr", label: "vs RHP" },
  home: { code: "h", label: "Home" },
  away: { code: "a", label: "Away" },
  risp: { code: "risp", label: "RISP" },
  last7: { code: "last7", label: "Last 7 Days" },
  last14: { code: "last14", label: "Last 14 Days" },
  last30: { code: "last30", label: "Last 30 Days" },
};

export type SplitType = keyof typeof SPLIT_SIT_CODES;

// ── HTTP ─────────────────────────────────────────────────────────────────────

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "Truth/1.0" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`MLB API ${res.status}: ${res.statusText} — ${url}`);
  return res.json() as Promise<T>;
}

// ── Player Splits ────────────────────────────────────────────────────────────

export async function fetchPlayerSplits(
  playerId: number,
  splitType: string,
  season?: number,
  group: "hitting" | "pitching" = "hitting"
): Promise<SplitResult | null> {
  const sit = SPLIT_SIT_CODES[splitType];
  if (!sit) {
    throw new Error(`Unknown splitType "${splitType}". Valid: ${Object.keys(SPLIT_SIT_CODES).join(", ")}`);
  }

  const yr = season ?? new Date().getFullYear();

  // last7/14/30 use the lastXGames stat type
  let url: string;
  if (splitType.startsWith("last")) {
    const days = splitType.replace("last", "");
    url = `${MLB_API}/people/${playerId}/stats?stats=lastXGames&season=${yr}&group=${group}&limit=${days}`;
  } else {
    url = `${MLB_API}/people/${playerId}/stats?stats=statSplits&season=${yr}&group=${group}&sitCodes=${sit.code}`;
  }

  const data = await fetchJson<any>(url);
  const splits = data?.stats?.[0]?.splits;
  if (!splits || splits.length === 0) return null;

  const s = splits[0].stat;
  return {
    splitType,
    splitLabel: sit.label,
    season: yr,
    stat: {
      gamesPlayed: s.gamesPlayed ?? 0,
      atBats: s.atBats ?? 0,
      hits: s.hits ?? 0,
      homeRuns: s.homeRuns ?? 0,
      rbi: s.rbi ?? 0,
      strikeOuts: s.strikeOuts ?? 0,
      baseOnBalls: s.baseOnBalls ?? 0,
      avg: s.avg ?? ".000",
      obp: s.obp ?? ".000",
      slg: s.slg ?? ".000",
      ops: s.ops ?? ".000",
      plateAppearances: s.plateAppearances ?? 0,
    },
  };
}

// ── Batter vs Pitcher ────────────────────────────────────────────────────────

export async function fetchBatterVsPitcher(
  batterId: number,
  pitcherId: number,
  season?: number
): Promise<BvPResult> {
  const yr = season ?? new Date().getFullYear();
  const url = `${MLB_API}/people/${batterId}/stats?stats=vsPlayer&opposingPlayerId=${pitcherId}&season=${yr}&group=hitting`;

  const [data, batterData, pitcherData] = await Promise.all([
    fetchJson<any>(url),
    fetchJson<any>(`${MLB_API}/people/${batterId}`),
    fetchJson<any>(`${MLB_API}/people/${pitcherId}`),
  ]);

  const batterName = batterData?.people?.[0]?.fullName ?? `Player ${batterId}`;
  const pitcherName = pitcherData?.people?.[0]?.fullName ?? `Player ${pitcherId}`;
  const splits = data?.stats?.[0]?.splits;

  if (!splits || splits.length === 0) {
    return {
      batterId, batterName, pitcherId, pitcherName,
      stats: { atBats: 0, hits: 0, homeRuns: 0, strikeOuts: 0, baseOnBalls: 0, avg: ".000", obp: ".000", slg: ".000", ops: ".000" },
    };
  }

  const s = splits[0].stat;
  return {
    batterId, batterName, pitcherId, pitcherName,
    stats: {
      atBats: s.atBats ?? 0,
      hits: s.hits ?? 0,
      homeRuns: s.homeRuns ?? 0,
      strikeOuts: s.strikeOuts ?? 0,
      baseOnBalls: s.baseOnBalls ?? 0,
      avg: s.avg ?? ".000",
      obp: s.obp ?? ".000",
      slg: s.slg ?? ".000",
      ops: s.ops ?? ".000",
    },
  };
}

// ── Game Environment ─────────────────────────────────────────────────────────
// Uses schedule hydration for venue dimensions + field info (richer than /feed/live)

export async function fetchGameContext(gamePk: number): Promise<GameEnvironment> {
  const url = `${MLB_API}/schedule?gamePk=${gamePk}&hydrate=weather,venue(location,fieldInfo)`;
  const data = await fetchJson<any>(url);

  const game = data?.dates?.[0]?.games?.[0];
  if (!game) throw new Error(`Game ${gamePk} not found`);

  const v = game.venue ?? {};
  const fi = v.fieldInfo ?? {};
  const loc = v.location ?? {};
  const w = game.weather;

  return {
    gamePk,
    venue: {
      id: v.id ?? 0,
      name: v.name ?? "Unknown",
      city: loc.city ?? "",
      state: loc.stateProvince ?? "",
      roof: fi.roofType ?? "Unknown",
      capacity: fi.capacity ?? 0,
      surfaceType: fi.turfType ?? "Unknown",
      leftLine: fi.leftLine ?? null,
      leftCenter: fi.leftCenter ?? null,
      center: fi.center ?? null,
      rightCenter: fi.rightCenter ?? null,
      rightLine: fi.rightLine ?? null,
    },
    weather: w
      ? {
          condition: w.condition ?? "Unknown",
          temp: w.temp ? `${w.temp}°F` : "Unknown",
          wind: w.wind ?? "Unknown",
        }
      : null,
    gameDate: game.gameDate ?? "",
    status: game.status?.detailedState ?? "Unknown",
  };
}

// ── Starting Lineups ─────────────────────────────────────────────────────────

export async function fetchStartingLineups(gamePk: number): Promise<LineupResult> {
  const url = `${MLB_API}/game/${gamePk}/boxscore`;
  const data = await fetchJson<any>(url);

  const teams = data?.teams;
  if (!teams) throw new Error(`Boxscore not available for game ${gamePk}`);

  function extractSide(side: any): LineupResult["home"] {
    const team = side.team ?? {};
    const players = side.players ?? {};
    const batOrder: number[] = side.battingOrder ?? [];
    const pitchers: number[] = side.pitchers ?? [];

    // Starting pitcher is first in pitchers array
    let pitcher: LineupResult["home"]["pitcher"] = null;
    if (pitchers.length > 0) {
      const pid = pitchers[0];
      const p = players[`ID${pid}`];
      if (p) {
        const ps = p.seasonStats?.pitching ?? {};
        pitcher = {
          id: pid,
          fullName: p.person?.fullName ?? `Player ${pid}`,
          era: ps.era ?? "0.00",
          wins: ps.wins ?? 0,
          losses: ps.losses ?? 0,
        };
      }
    }

    // Batting order with handedness + season stats
    const lineup: LineupPlayer[] = batOrder
      .map((pid: number, idx: number) => {
        const p = players[`ID${pid}`];
        if (!p) return null;
        const bs = p.seasonStats?.batting ?? {};
        return {
          id: pid,
          fullName: p.person?.fullName ?? `Player ${pid}`,
          position: p.position?.abbreviation ?? "DH",
          battingOrder: String(idx + 1),
          bats: p.person?.batSide?.code ?? "?",
          throws: p.person?.pitchHand?.code ?? "?",
          seasonStats: {
            avg: bs.avg ?? ".000",
            ops: bs.ops ?? ".000",
            homeRuns: bs.homeRuns ?? 0,
          },
        };
      })
      .filter(Boolean) as LineupPlayer[];

    return {
      team: team.name ?? "Unknown",
      teamId: team.id ?? 0,
      pitcher,
      battingOrder: lineup,
    };
  }

  return {
    gamePk,
    away: extractSide(teams.away),
    home: extractSide(teams.home),
  };
}

// ── Player Search ────────────────────────────────────────────────────────────

export async function searchPlayer(name: string): Promise<PlayerSearchResult[]> {
  const url = `${MLB_API}/people/search?names=${encodeURIComponent(name)}&sportIds=1&hydrate=currentTeam`;
  const data = await fetchJson<any>(url);
  return (data?.people ?? []).slice(0, 5).map((p: any) => ({
    id: p.id,
    fullName: p.fullName ?? name,
    team: p.currentTeam?.name ?? "Unknown",
    position: p.primaryPosition?.abbreviation ?? "?",
  }));
}
