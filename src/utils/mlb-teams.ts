export interface MlbTeam {
  fullName: string;
  city: string;
  nickname: string;
  abbr: string[]; // Primary ticker abbreviation + any known variants (e.g. SD, SDP)
}

// Canonical source of truth for MLB team aliases
export const MLB_TEAMS: MlbTeam[] = [
  { fullName: "Arizona Diamondbacks", city: "Arizona", nickname: "Diamondbacks", abbr: ["ARI", "AZ"] },
  { fullName: "Atlanta Braves", city: "Atlanta", nickname: "Braves", abbr: ["ATL"] },
  { fullName: "Baltimore Orioles", city: "Baltimore", nickname: "Orioles", abbr: ["BAL"] },
  { fullName: "Boston Red Sox", city: "Boston", nickname: "Red Sox", abbr: ["BOS"] },
  { fullName: "Chicago Cubs", city: "Chicago", nickname: "Cubs", abbr: ["CHC", "CUB"] },
  { fullName: "Chicago White Sox", city: "Chicago", nickname: "White Sox", abbr: ["CWS", "CHW", "WSX"] },
  { fullName: "Cincinnati Reds", city: "Cincinnati", nickname: "Reds", abbr: ["CIN"] },
  { fullName: "Cleveland Guardians", city: "Cleveland", nickname: "Guardians", abbr: ["CLE"] },
  { fullName: "Colorado Rockies", city: "Colorado", nickname: "Rockies", abbr: ["COL"] },
  { fullName: "Detroit Tigers", city: "Detroit", nickname: "Tigers", abbr: ["DET"] },
  { fullName: "Houston Astros", city: "Houston", nickname: "Astros", abbr: ["HOU"] },
  { fullName: "Kansas City Royals", city: "Kansas City", nickname: "Royals", abbr: ["KC", "KCR"] },
  { fullName: "Los Angeles Angels", city: "Los Angeles", nickname: "Angels", abbr: ["LAA"] },
  { fullName: "Los Angeles Dodgers", city: "Los Angeles", nickname: "Dodgers", abbr: ["LAD"] },
  { fullName: "Miami Marlins", city: "Miami", nickname: "Marlins", abbr: ["MIA"] },
  { fullName: "Milwaukee Brewers", city: "Milwaukee", nickname: "Brewers", abbr: ["MIL"] },
  { fullName: "Minnesota Twins", city: "Minnesota", nickname: "Twins", abbr: ["MIN"] },
  { fullName: "New York Mets", city: "New York", nickname: "Mets", abbr: ["NYM"] },
  { fullName: "New York Yankees", city: "New York", nickname: "Yankees", abbr: ["NYY"] },
  { fullName: "Athletics", city: "Oakland", nickname: "Athletics", abbr: ["OAK", "ATH", "OAKLAND"] }, // Franchise dropped "Oakland" for 2025+
  { fullName: "Philadelphia Phillies", city: "Philadelphia", nickname: "Phillies", abbr: ["PHI"] },
  { fullName: "Pittsburgh Pirates", city: "Pittsburgh", nickname: "Pirates", abbr: ["PIT"] },
  { fullName: "San Diego Padres", city: "San Diego", nickname: "Padres", abbr: ["SD", "SDP"] },
  { fullName: "San Francisco Giants", city: "San Francisco", nickname: "Giants", abbr: ["SF", "SFG"] },
  { fullName: "Seattle Mariners", city: "Seattle", nickname: "Mariners", abbr: ["SEA"] },
  { fullName: "St. Louis Cardinals", city: "St. Louis", nickname: "Cardinals", abbr: ["STL"] },
  { fullName: "Tampa Bay Rays", city: "Tampa Bay", nickname: "Rays", abbr: ["TB", "TBR"] },
  { fullName: "Texas Rangers", city: "Texas", nickname: "Rangers", abbr: ["TEX"] },
  { fullName: "Toronto Blue Jays", city: "Toronto", nickname: "Blue Jays", abbr: ["TOR"] },
  { fullName: "Washington Nationals", city: "Washington", nickname: "Nationals", abbr: ["WSH", "WAS", "WSN"] },
];

import { logger } from "./logger";

/**
 * Normalizes a team string for comparison
 * Converts to lowercase, removes punctuation (dots, dashes, apostrophes), and trims
 */
export function normalizeTeamString(name: string): string {
  return name.toLowerCase().replace(/[\.\-']/g, '').trim();
}

const ABBR_TO_TEAM = new Map<string, MlbTeam>();
for (const team of MLB_TEAMS) {
  for (const a of team.abbr) {
    ABBR_TO_TEAM.set(a.toUpperCase().trim(), team);
  }
}

/** 
 * Resolve a ticker abbr to a canonical team. Logs loudly on miss.
 * Used for Kalshi market ingestion.
 */
export function teamFromAbbr(abbr: string): MlbTeam | null {
  if (!abbr) return null;
  const key = abbr.toUpperCase().trim();
  const team = ABBR_TO_TEAM.get(key);
  if (!team) {
    logger.error({
      msg: "UNMAPPED_KALSHI_ABBR",
      abbr: key,
      hint: "Add this abbr variant to MLB_TEAMS in mlb-teams.ts",
    });
    return null;
  }
  return team;
}

/**
 * Looks up a team by its full name or common variations and returns its canonical Nickname.
 * Used for backward compatibility with `odds-backfill-worker.ts`.
 */
export function getTeamNickname(name: string): string {
  if (!name) return "";
  const normalized = normalizeTeamString(name);
  
  // Specific fallbacks for historically tricky names
  if (normalized.endsWith('red sox')) return 'redsox';
  if (normalized.endsWith('white sox')) return 'whitesox';
  if (normalized.endsWith('blue jays')) return 'bluejays';
  if (normalized.includes('dbacks') || normalized.includes('diamondbacks')) return 'diamondbacks';

  // Find the matching team in the dictionary
  for (const team of MLB_TEAMS) {
    const fn = normalizeTeamString(team.fullName);
    const nn = normalizeTeamString(team.nickname);
    if (normalized === fn || normalized === nn) {
      return nn; // Return normalized nickname to match legacy behavior
    }
  }

  // Fallback: just return the last word (legacy behavior)
  const parts = normalized.split(/\s+/);
  return parts[parts.length - 1] || normalized;
}

/**
 * Returns an array of normalized aliases for a given team name (e.g. from Spanner).
 * teamAliases("Pittsburgh Pirates") → ["pirates", "pittsburgh", "pit"]
 */
export function getTeamAliases(name: string): string[] {
  const normalized = normalizeTeamString(name);
  let matchedTeam: MlbTeam | null = null;

  for (const team of MLB_TEAMS) {
    const fn = normalizeTeamString(team.fullName);
    const nn = normalizeTeamString(team.nickname);
    if (normalized === fn || normalized === nn) {
      matchedTeam = team;
      break;
    }
  }

  if (matchedTeam) {
    // Generate canonical aliases
    const aliases = new Set<string>();
    aliases.add(normalizeTeamString(matchedTeam.nickname));
    
    // Guard against dangerous short-tokens like "as" (Oakland A's) causing false positives
    const cityNorm = normalizeTeamString(matchedTeam.city);
    // Don't add 'new york', 'chicago', or 'los angeles' as a standalone alias because it's ambiguous!
    if (!["new york", "chicago", "los angeles"].includes(cityNorm)) {
      aliases.add(cityNorm);
    }
    
    // Add all abbreviations
    matchedTeam.abbr.forEach(a => aliases.add(a.toLowerCase()));

    return Array.from(aliases);
  }

  // If no canonical team was found, just fallback to the legacy split behavior
  return [getTeamNickname(name)];
}
