/**
 * TRUTH PLATFORM — ESPN TeamId → Internal Team Crosswalk
 * 
 * Maps ESPN teamId (from news categories[].teamId) → internal identifiers
 * used across the odds pipeline (Odds API full names) and Spanner MlbGames.
 *
 * ESPN teamIds are stable. Verified against live ESPN Site API:
 *   GET site.api.espn.com/apis/site/v2/sports/baseball/mlb/teams
 *   teamId 6  = Detroit Tigers (confirmed in audit)
 *   teamId 21 = New York Mets (confirmed: Mets=21, Pirates=23)
 *   teamId 11 = Athletics (ESPN dropped "Oakland"; oddsApiName retains it for Spanner join)
 *
 * The "oddsApiName" column is the canonical full team name the Odds API
 * returns (and what Truth stores in Spanner MlbGames). This is the join key.
 * If the Odds API string drifts (relocations, rebrands), update oddsApiName
 * here and nothing downstream breaks. This table is the single source of truth
 * for team-name resolution.
 */

export interface EspnTeamMapping {
  espnTeamId: number;
  abbr: string;          // ESPN/standard abbreviation
  oddsApiName: string;   // EXACT string the Odds API uses (join key into MlbGames)
  location: string;
  nickname: string;
  league: 'AL' | 'NL';
  division: 'East' | 'Central' | 'West';
}

export const ESPN_MLB_TEAM_CROSSWALK: EspnTeamMapping[] = [
  // ── AL East ──
  { espnTeamId: 1,  abbr: 'BAL', oddsApiName: 'Baltimore Orioles',     location: 'Baltimore',     nickname: 'Orioles',      league: 'AL', division: 'East' },
  { espnTeamId: 2,  abbr: 'BOS', oddsApiName: 'Boston Red Sox',        location: 'Boston',        nickname: 'Red Sox',      league: 'AL', division: 'East' },
  { espnTeamId: 10, abbr: 'NYY', oddsApiName: 'New York Yankees',      location: 'New York',      nickname: 'Yankees',      league: 'AL', division: 'East' },
  { espnTeamId: 30, abbr: 'TB',  oddsApiName: 'Tampa Bay Rays',        location: 'Tampa Bay',     nickname: 'Rays',         league: 'AL', division: 'East' },
  { espnTeamId: 14, abbr: 'TOR', oddsApiName: 'Toronto Blue Jays',     location: 'Toronto',       nickname: 'Blue Jays',    league: 'AL', division: 'East' },

  // ── AL Central ──
  { espnTeamId: 4,  abbr: 'CWS', oddsApiName: 'Chicago White Sox',     location: 'Chicago',       nickname: 'White Sox',    league: 'AL', division: 'Central' },
  { espnTeamId: 5,  abbr: 'CLE', oddsApiName: 'Cleveland Guardians',   location: 'Cleveland',     nickname: 'Guardians',    league: 'AL', division: 'Central' },
  { espnTeamId: 6,  abbr: 'DET', oddsApiName: 'Detroit Tigers',        location: 'Detroit',       nickname: 'Tigers',       league: 'AL', division: 'Central' }, // ✅ verified live
  { espnTeamId: 7,  abbr: 'KC',  oddsApiName: 'Kansas City Royals',    location: 'Kansas City',   nickname: 'Royals',       league: 'AL', division: 'Central' },
  { espnTeamId: 9,  abbr: 'MIN', oddsApiName: 'Minnesota Twins',       location: 'Minnesota',     nickname: 'Twins',        league: 'AL', division: 'Central' },

  // ── AL West ──
  { espnTeamId: 18, abbr: 'HOU', oddsApiName: 'Houston Astros',        location: 'Houston',       nickname: 'Astros',       league: 'AL', division: 'West' },
  { espnTeamId: 3,  abbr: 'LAA', oddsApiName: 'Los Angeles Angels',    location: 'Los Angeles',   nickname: 'Angels',       league: 'AL', division: 'West' },
  { espnTeamId: 11, abbr: 'ATH', oddsApiName: 'Athletics',            location: 'Athletics',     nickname: 'Athletics',    league: 'AL', division: 'West' }, // ESPN + OddsAPI both use "Athletics" post-relocation
  { espnTeamId: 12, abbr: 'SEA', oddsApiName: 'Seattle Mariners',      location: 'Seattle',       nickname: 'Mariners',     league: 'AL', division: 'West' },
  { espnTeamId: 13, abbr: 'TEX', oddsApiName: 'Texas Rangers',         location: 'Texas',         nickname: 'Rangers',      league: 'AL', division: 'West' },

  // ── NL East ──
  { espnTeamId: 15, abbr: 'ATL', oddsApiName: 'Atlanta Braves',        location: 'Atlanta',       nickname: 'Braves',       league: 'NL', division: 'East' },
  { espnTeamId: 28, abbr: 'MIA', oddsApiName: 'Miami Marlins',         location: 'Miami',         nickname: 'Marlins',      league: 'NL', division: 'East' },
  { espnTeamId: 21, abbr: 'NYM', oddsApiName: 'New York Mets',         location: 'New York',      nickname: 'Mets',         league: 'NL', division: 'East' }, // ✅ verified: Mets=21, Pirates=23
  { espnTeamId: 22, abbr: 'PHI', oddsApiName: 'Philadelphia Phillies', location: 'Philadelphia',  nickname: 'Phillies',     league: 'NL', division: 'East' },
  { espnTeamId: 20, abbr: 'WSH', oddsApiName: 'Washington Nationals',  location: 'Washington',    nickname: 'Nationals',    league: 'NL', division: 'East' },

  // ── NL Central ──
  { espnTeamId: 16, abbr: 'CHC', oddsApiName: 'Chicago Cubs',          location: 'Chicago',       nickname: 'Cubs',         league: 'NL', division: 'Central' },
  { espnTeamId: 17, abbr: 'CIN', oddsApiName: 'Cincinnati Reds',       location: 'Cincinnati',    nickname: 'Reds',         league: 'NL', division: 'Central' },
  { espnTeamId: 8,  abbr: 'MIL', oddsApiName: 'Milwaukee Brewers',     location: 'Milwaukee',     nickname: 'Brewers',      league: 'NL', division: 'Central' },
  { espnTeamId: 23, abbr: 'PIT', oddsApiName: 'Pittsburgh Pirates',    location: 'Pittsburgh',    nickname: 'Pirates',      league: 'NL', division: 'Central' },
  { espnTeamId: 24, abbr: 'STL', oddsApiName: 'St. Louis Cardinals',   location: 'St. Louis',     nickname: 'Cardinals',    league: 'NL', division: 'Central' },

  // ── NL West ──
  { espnTeamId: 29, abbr: 'ARI', oddsApiName: 'Arizona Diamondbacks',  location: 'Arizona',       nickname: 'Diamondbacks', league: 'NL', division: 'West' },
  { espnTeamId: 27, abbr: 'COL', oddsApiName: 'Colorado Rockies',      location: 'Colorado',      nickname: 'Rockies',      league: 'NL', division: 'West' },
  { espnTeamId: 19, abbr: 'LAD', oddsApiName: 'Los Angeles Dodgers',   location: 'Los Angeles',   nickname: 'Dodgers',      league: 'NL', division: 'West' },
  { espnTeamId: 25, abbr: 'SD',  oddsApiName: 'San Diego Padres',      location: 'San Diego',     nickname: 'Padres',       league: 'NL', division: 'West' },
  { espnTeamId: 26, abbr: 'SF',  oddsApiName: 'San Francisco Giants',  location: 'San Francisco', nickname: 'Giants',       league: 'NL', division: 'West' },
];

// ── Lookup maps (built once at module load) ──────────────────────────

const BY_ESPN_ID = new Map<number, EspnTeamMapping>(
  ESPN_MLB_TEAM_CROSSWALK.map((t) => [t.espnTeamId, t])
);
const BY_ODDS_NAME = new Map<string, EspnTeamMapping>(
  ESPN_MLB_TEAM_CROSSWALK.map((t) => [t.oddsApiName.toLowerCase(), t])
);
const BY_ABBR = new Map<string, EspnTeamMapping>(
  ESPN_MLB_TEAM_CROSSWALK.map((t) => [t.abbr.toLowerCase(), t])
);

// ── Public API ───────────────────────────────────────────────────────

/** ESPN news categories[].teamId → canonical Odds API team name (join key). */
export function espnTeamIdToOddsName(espnTeamId: number): string | null {
  return BY_ESPN_ID.get(espnTeamId)?.oddsApiName ?? null;
}

export function espnTeamIdToMapping(espnTeamId: number): EspnTeamMapping | null {
  return BY_ESPN_ID.get(espnTeamId) ?? null;
}

/** Reverse: Odds API full name → ESPN mapping (for edge-card → news joins). */
export function oddsNameToMapping(oddsApiName: string): EspnTeamMapping | null {
  return BY_ODDS_NAME.get(oddsApiName.trim().toLowerCase()) ?? null;
}

export function abbrToMapping(abbr: string): EspnTeamMapping | null {
  return BY_ABBR.get(abbr.trim().toLowerCase()) ?? null;
}

/** Resolve an array of ESPN teamIds → Odds API names, dropping unknowns. */
export function resolveEspnTeamIds(espnTeamIds: number[]): string[] {
  return espnTeamIds
    .map((id) => espnTeamIdToOddsName(id))
    .filter((name): name is string => name !== null);
}
