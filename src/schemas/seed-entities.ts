/**
 * seed-entities.ts — Initial entity alias seed data.
 *
 * Run with: npx tsx src/schemas/seed-entities.ts
 *
 * Seeds EntityAliases + StatAliases tables with:
 *   - MLB team abbreviations + nicknames
 *   - MLB star player nicknames
 *   - NBA team abbreviations + nicknames
 *   - NBA star player nicknames
 *   - NFL team abbreviations + nicknames
 *   - Stat slang mappings for all sports
 */

import { Spanner } from "@google-cloud/spanner";

const PROJECT = process.env.GCP_PROJECT || "gen-lang-client-0281999829";
const INSTANCE = "clearspace";
const DATABASE = "sports-entities-db";

const spanner = new Spanner({ projectId: PROJECT });
const database = spanner.instance(INSTANCE).database(DATABASE);

// ── Helper ───────────────────────────────────────────────────────────────────

function makeId(sport: string, type: string, canonicalId: string, alias: string): string {
  const hash = Buffer.from(alias.toLowerCase()).toString("base64").substring(0, 12);
  return `${sport}-${type}-${canonicalId}-${hash}`.substring(0, 36);
}

function commitTs() {
  return Spanner.COMMIT_TIMESTAMP;
}

interface AliasRow {
  AliasId: string;
  Alias: string;
  AliasLower: string;
  EntityType: string;
  Sport: string;
  CanonicalId: string;
  CanonicalName: string;
  AliasSource: string;
  Confidence: any;
  AliasEmbedding: null;
  CreatedAt: any;
  UpdatedAt: any;
}

function entityAlias(
  alias: string,
  entityType: "player" | "team" | "stat" | "venue",
  sport: "mlb" | "nba" | "nfl",
  canonicalId: string,
  canonicalName: string,
  source: string = "official",
  confidence: number = 1.0
): AliasRow {
  return {
    AliasId: makeId(sport, entityType, canonicalId, alias),
    Alias: alias,
    AliasLower: alias.toLowerCase(),
    EntityType: entityType,
    Sport: sport,
    CanonicalId: canonicalId,
    CanonicalName: canonicalName,
    AliasSource: source,
    Confidence: Spanner.float(confidence),
    AliasEmbedding: null,
    CreatedAt: commitTs(),
    UpdatedAt: commitTs(),
  };
}

// ── MLB Teams ────────────────────────────────────────────────────────────────

const mlbTeams: AliasRow[] = [
  // Yankees
  entityAlias("NYY", "team", "mlb", "nyy", "New York Yankees", "abbreviation"),
  entityAlias("Yankees", "team", "mlb", "nyy", "New York Yankees", "official"),
  entityAlias("Yanks", "team", "mlb", "nyy", "New York Yankees", "slang"),
  entityAlias("Bronx Bombers", "team", "mlb", "nyy", "New York Yankees", "nickname"),
  entityAlias("New York Yankees", "team", "mlb", "nyy", "New York Yankees", "official"),
  // Dodgers
  entityAlias("LAD", "team", "mlb", "lad", "Los Angeles Dodgers", "abbreviation"),
  entityAlias("Dodgers", "team", "mlb", "lad", "Los Angeles Dodgers", "official"),
  entityAlias("Los Angeles Dodgers", "team", "mlb", "lad", "Los Angeles Dodgers", "official"),
  entityAlias("LA Dodgers", "team", "mlb", "lad", "Los Angeles Dodgers", "abbreviation"),
  // Red Sox
  entityAlias("BOS", "team", "mlb", "bos", "Boston Red Sox", "abbreviation"),
  entityAlias("Red Sox", "team", "mlb", "bos", "Boston Red Sox", "official"),
  entityAlias("Sox", "team", "mlb", "bos", "Boston Red Sox", "slang", 0.7),
  entityAlias("Boston Red Sox", "team", "mlb", "bos", "Boston Red Sox", "official"),
  // Astros
  entityAlias("HOU", "team", "mlb", "hou", "Houston Astros", "abbreviation"),
  entityAlias("Astros", "team", "mlb", "hou", "Houston Astros", "official"),
  entityAlias("Stros", "team", "mlb", "hou", "Houston Astros", "slang"),
  // Mets
  entityAlias("NYM", "team", "mlb", "nym", "New York Mets", "abbreviation"),
  entityAlias("Mets", "team", "mlb", "nym", "New York Mets", "official"),
  entityAlias("Amazins", "team", "mlb", "nym", "New York Mets", "nickname"),
  // Braves
  entityAlias("ATL", "team", "mlb", "atl", "Atlanta Braves", "abbreviation"),
  entityAlias("Braves", "team", "mlb", "atl", "Atlanta Braves", "official"),
  // Phillies
  entityAlias("PHI", "team", "mlb", "phi", "Philadelphia Phillies", "abbreviation"),
  entityAlias("Phillies", "team", "mlb", "phi", "Philadelphia Phillies", "official"),
  entityAlias("Phils", "team", "mlb", "phi", "Philadelphia Phillies", "slang"),
  // Cubs
  entityAlias("CHC", "team", "mlb", "chc", "Chicago Cubs", "abbreviation"),
  entityAlias("Cubs", "team", "mlb", "chc", "Chicago Cubs", "official"),
  entityAlias("Cubbies", "team", "mlb", "chc", "Chicago Cubs", "nickname"),
  // Cardinals
  entityAlias("STL", "team", "mlb", "stl", "St. Louis Cardinals", "abbreviation"),
  entityAlias("Cardinals", "team", "mlb", "stl", "St. Louis Cardinals", "official"),
  entityAlias("Cards", "team", "mlb", "stl", "St. Louis Cardinals", "slang"),
  // Giants
  entityAlias("SF", "team", "mlb", "sf", "San Francisco Giants", "abbreviation"),
  entityAlias("Giants", "team", "mlb", "sf", "San Francisco Giants", "official"),
  // Padres
  entityAlias("SD", "team", "mlb", "sd", "San Diego Padres", "abbreviation"),
  entityAlias("Padres", "team", "mlb", "sd", "San Diego Padres", "official"),
  entityAlias("Friars", "team", "mlb", "sd", "San Diego Padres", "nickname"),
  // White Sox
  entityAlias("CWS", "team", "mlb", "cws", "Chicago White Sox", "abbreviation"),
  entityAlias("White Sox", "team", "mlb", "cws", "Chicago White Sox", "official"),
  // Tigers
  entityAlias("DET", "team", "mlb", "det", "Detroit Tigers", "abbreviation"),
  entityAlias("Tigers", "team", "mlb", "det", "Detroit Tigers", "official"),
  // Mariners
  entityAlias("SEA", "team", "mlb", "sea", "Seattle Mariners", "abbreviation"),
  entityAlias("Mariners", "team", "mlb", "sea", "Seattle Mariners", "official"),
  entityAlias("M's", "team", "mlb", "sea", "Seattle Mariners", "slang"),
  // Rays
  entityAlias("TB", "team", "mlb", "tb", "Tampa Bay Rays", "abbreviation"),
  entityAlias("Rays", "team", "mlb", "tb", "Tampa Bay Rays", "official"),
  // Blue Jays
  entityAlias("TOR", "team", "mlb", "tor", "Toronto Blue Jays", "abbreviation"),
  entityAlias("Blue Jays", "team", "mlb", "tor", "Toronto Blue Jays", "official"),
  entityAlias("Jays", "team", "mlb", "tor", "Toronto Blue Jays", "slang"),
  // Twins
  entityAlias("MIN", "team", "mlb", "min", "Minnesota Twins", "abbreviation"),
  entityAlias("Twins", "team", "mlb", "min", "Minnesota Twins", "official"),
  // Guardians
  entityAlias("CLE", "team", "mlb", "cle", "Cleveland Guardians", "abbreviation"),
  entityAlias("Guardians", "team", "mlb", "cle", "Cleveland Guardians", "official"),
  // Rangers
  entityAlias("TEX", "team", "mlb", "tex", "Texas Rangers", "abbreviation"),
  entityAlias("Rangers", "team", "mlb", "tex", "Texas Rangers", "official"),
  // Orioles
  entityAlias("BAL", "team", "mlb", "bal", "Baltimore Orioles", "abbreviation"),
  entityAlias("Orioles", "team", "mlb", "bal", "Baltimore Orioles", "official"),
  entityAlias("O's", "team", "mlb", "bal", "Baltimore Orioles", "slang"),
  // Nationals
  entityAlias("WSH", "team", "mlb", "wsh", "Washington Nationals", "abbreviation"),
  entityAlias("Nationals", "team", "mlb", "wsh", "Washington Nationals", "official"),
  entityAlias("Nats", "team", "mlb", "wsh", "Washington Nationals", "slang"),
  // Angels
  entityAlias("LAA", "team", "mlb", "laa", "Los Angeles Angels", "abbreviation"),
  entityAlias("Angels", "team", "mlb", "laa", "Los Angeles Angels", "official"),
  entityAlias("Halos", "team", "mlb", "laa", "Los Angeles Angels", "nickname"),
  // Rockies
  entityAlias("COL", "team", "mlb", "col", "Colorado Rockies", "abbreviation"),
  entityAlias("Rockies", "team", "mlb", "col", "Colorado Rockies", "official"),
  // Athletics
  entityAlias("OAK", "team", "mlb", "oak", "Oakland Athletics", "abbreviation"),
  entityAlias("Athletics", "team", "mlb", "oak", "Oakland Athletics", "official"),
  entityAlias("A's", "team", "mlb", "oak", "Oakland Athletics", "slang"),
  // Reds
  entityAlias("CIN", "team", "mlb", "cin", "Cincinnati Reds", "abbreviation"),
  entityAlias("Reds", "team", "mlb", "cin", "Cincinnati Reds", "official"),
  // Brewers
  entityAlias("MIL", "team", "mlb", "mil", "Milwaukee Brewers", "abbreviation"),
  entityAlias("Brewers", "team", "mlb", "mil", "Milwaukee Brewers", "official"),
  entityAlias("Brew Crew", "team", "mlb", "mil", "Milwaukee Brewers", "nickname"),
  // Pirates
  entityAlias("PIT", "team", "mlb", "pit", "Pittsburgh Pirates", "abbreviation"),
  entityAlias("Pirates", "team", "mlb", "pit", "Pittsburgh Pirates", "official"),
  entityAlias("Buccos", "team", "mlb", "pit", "Pittsburgh Pirates", "nickname"),
  // Marlins
  entityAlias("MIA", "team", "mlb", "mia", "Miami Marlins", "abbreviation"),
  entityAlias("Marlins", "team", "mlb", "mia", "Miami Marlins", "official"),
  // Royals
  entityAlias("KC", "team", "mlb", "kc", "Kansas City Royals", "abbreviation"),
  entityAlias("Royals", "team", "mlb", "kc", "Kansas City Royals", "official"),
  // Diamondbacks
  entityAlias("ARI", "team", "mlb", "ari", "Arizona Diamondbacks", "abbreviation"),
  entityAlias("Diamondbacks", "team", "mlb", "ari", "Arizona Diamondbacks", "official"),
  entityAlias("D-backs", "team", "mlb", "ari", "Arizona Diamondbacks", "slang"),
  entityAlias("Dbacks", "team", "mlb", "ari", "Arizona Diamondbacks", "slang"),
];

// ── MLB Players (Star Nicknames) ─────────────────────────────────────────────

const mlbPlayers: AliasRow[] = [
  // Aaron Judge
  entityAlias("Aaron Judge", "player", "mlb", "judge-592450", "Aaron Judge", "official"),
  entityAlias("Judge", "player", "mlb", "judge-592450", "Aaron Judge", "official"),
  entityAlias("All Rise", "player", "mlb", "judge-592450", "Aaron Judge", "nickname"),
  entityAlias("The Judge", "player", "mlb", "judge-592450", "Aaron Judge", "nickname"),
  // Shohei Ohtani
  entityAlias("Shohei Ohtani", "player", "mlb", "ohtani-660271", "Shohei Ohtani", "official"),
  entityAlias("Ohtani", "player", "mlb", "ohtani-660271", "Shohei Ohtani", "official"),
  entityAlias("Shotime", "player", "mlb", "ohtani-660271", "Shohei Ohtani", "nickname"),
  entityAlias("Sho-Time", "player", "mlb", "ohtani-660271", "Shohei Ohtani", "nickname"),
  // Mike Trout
  entityAlias("Mike Trout", "player", "mlb", "trout-545361", "Mike Trout", "official"),
  entityAlias("Trout", "player", "mlb", "trout-545361", "Mike Trout", "official"),
  entityAlias("Millville Meteor", "player", "mlb", "trout-545361", "Mike Trout", "nickname"),
  entityAlias("Kiiiiid", "player", "mlb", "trout-545361", "Mike Trout", "nickname"),
  // Mookie Betts
  entityAlias("Mookie Betts", "player", "mlb", "betts-605141", "Mookie Betts", "official"),
  entityAlias("Mookie", "player", "mlb", "betts-605141", "Mookie Betts", "official"),
  // Juan Soto
  entityAlias("Juan Soto", "player", "mlb", "soto-665742", "Juan Soto", "official"),
  entityAlias("Soto", "player", "mlb", "soto-665742", "Juan Soto", "official"),
  entityAlias("Childish Bambino", "player", "mlb", "soto-665742", "Juan Soto", "nickname"),
  // Freddie Freeman
  entityAlias("Freddie Freeman", "player", "mlb", "freeman-518692", "Freddie Freeman", "official"),
  entityAlias("Freeman", "player", "mlb", "freeman-518692", "Freddie Freeman", "official"),
  // Gerrit Cole
  entityAlias("Gerrit Cole", "player", "mlb", "cole-543037", "Gerrit Cole", "official"),
  entityAlias("Cole", "player", "mlb", "cole-543037", "Gerrit Cole", "official"),
  // Ronald Acuña Jr.
  entityAlias("Ronald Acuña Jr.", "player", "mlb", "acuna-660670", "Ronald Acuña Jr.", "official"),
  entityAlias("Acuna", "player", "mlb", "acuna-660670", "Ronald Acuña Jr.", "official"),
  entityAlias("El Abusador", "player", "mlb", "acuna-660670", "Ronald Acuña Jr.", "nickname"),
  // Trea Turner
  entityAlias("Trea Turner", "player", "mlb", "turner-607208", "Trea Turner", "official"),
  entityAlias("Trea", "player", "mlb", "turner-607208", "Trea Turner", "official"),
  // Corbin Burnes
  entityAlias("Corbin Burnes", "player", "mlb", "burnes-669203", "Corbin Burnes", "official"),
  entityAlias("Burnes", "player", "mlb", "burnes-669203", "Corbin Burnes", "official"),
];

// ── NBA Teams ────────────────────────────────────────────────────────────────

const nbaTeams: AliasRow[] = [
  entityAlias("LAL", "team", "nba", "lal", "Los Angeles Lakers", "abbreviation"),
  entityAlias("Lakers", "team", "nba", "lal", "Los Angeles Lakers", "official"),
  entityAlias("Lake Show", "team", "nba", "lal", "Los Angeles Lakers", "nickname"),
  entityAlias("Purple and Gold", "team", "nba", "lal", "Los Angeles Lakers", "nickname"),

  entityAlias("GSW", "team", "nba", "gsw", "Golden State Warriors", "abbreviation"),
  entityAlias("Warriors", "team", "nba", "gsw", "Golden State Warriors", "official"),
  entityAlias("Dubs", "team", "nba", "gsw", "Golden State Warriors", "slang"),

  entityAlias("BOS", "team", "nba", "bos-nba", "Boston Celtics", "abbreviation"),
  entityAlias("Celtics", "team", "nba", "bos-nba", "Boston Celtics", "official"),

  entityAlias("MIL", "team", "nba", "mil-nba", "Milwaukee Bucks", "abbreviation"),
  entityAlias("Bucks", "team", "nba", "mil-nba", "Milwaukee Bucks", "official"),

  entityAlias("DAL", "team", "nba", "dal", "Dallas Mavericks", "abbreviation"),
  entityAlias("Mavericks", "team", "nba", "dal", "Dallas Mavericks", "official"),
  entityAlias("Mavs", "team", "nba", "dal", "Dallas Mavericks", "slang"),

  entityAlias("PHX", "team", "nba", "phx", "Phoenix Suns", "abbreviation"),
  entityAlias("Suns", "team", "nba", "phx", "Phoenix Suns", "official"),

  entityAlias("DEN", "team", "nba", "den", "Denver Nuggets", "abbreviation"),
  entityAlias("Nuggets", "team", "nba", "den", "Denver Nuggets", "official"),

  entityAlias("MIA", "team", "nba", "mia-nba", "Miami Heat", "abbreviation"),
  entityAlias("Heat", "team", "nba", "mia-nba", "Miami Heat", "official"),

  entityAlias("PHI", "team", "nba", "phi-nba", "Philadelphia 76ers", "abbreviation"),
  entityAlias("76ers", "team", "nba", "phi-nba", "Philadelphia 76ers", "official"),
  entityAlias("Sixers", "team", "nba", "phi-nba", "Philadelphia 76ers", "slang"),

  entityAlias("NYK", "team", "nba", "nyk", "New York Knicks", "abbreviation"),
  entityAlias("Knicks", "team", "nba", "nyk", "New York Knicks", "official"),

  entityAlias("BKN", "team", "nba", "bkn", "Brooklyn Nets", "abbreviation"),
  entityAlias("Nets", "team", "nba", "bkn", "Brooklyn Nets", "official"),

  entityAlias("LAC", "team", "nba", "lac", "Los Angeles Clippers", "abbreviation"),
  entityAlias("Clippers", "team", "nba", "lac", "Los Angeles Clippers", "official"),
  entityAlias("Clips", "team", "nba", "lac", "Los Angeles Clippers", "slang"),

  entityAlias("CHI", "team", "nba", "chi-nba", "Chicago Bulls", "abbreviation"),
  entityAlias("Bulls", "team", "nba", "chi-nba", "Chicago Bulls", "official"),

  entityAlias("OKC", "team", "nba", "okc", "Oklahoma City Thunder", "abbreviation"),
  entityAlias("Thunder", "team", "nba", "okc", "Oklahoma City Thunder", "official"),

  entityAlias("MIN", "team", "nba", "min-nba", "Minnesota Timberwolves", "abbreviation"),
  entityAlias("Timberwolves", "team", "nba", "min-nba", "Minnesota Timberwolves", "official"),
  entityAlias("Wolves", "team", "nba", "min-nba", "Minnesota Timberwolves", "slang"),
  entityAlias("T-Wolves", "team", "nba", "min-nba", "Minnesota Timberwolves", "slang"),
];

// ── NBA Players ──────────────────────────────────────────────────────────────

const nbaPlayers: AliasRow[] = [
  // LeBron James
  entityAlias("LeBron James", "player", "nba", "lebron-2544", "LeBron James", "official"),
  entityAlias("LeBron", "player", "nba", "lebron-2544", "LeBron James", "official"),
  entityAlias("Bron", "player", "nba", "lebron-2544", "LeBron James", "slang"),
  entityAlias("King James", "player", "nba", "lebron-2544", "LeBron James", "nickname"),
  entityAlias("The King", "player", "nba", "lebron-2544", "LeBron James", "nickname"),
  entityAlias("LBJ", "player", "nba", "lebron-2544", "LeBron James", "abbreviation"),
  entityAlias("The Chosen One", "player", "nba", "lebron-2544", "LeBron James", "nickname"),

  // Stephen Curry
  entityAlias("Stephen Curry", "player", "nba", "curry-201939", "Stephen Curry", "official"),
  entityAlias("Steph Curry", "player", "nba", "curry-201939", "Stephen Curry", "official"),
  entityAlias("Steph", "player", "nba", "curry-201939", "Stephen Curry", "slang"),
  entityAlias("Chef Curry", "player", "nba", "curry-201939", "Stephen Curry", "nickname"),
  entityAlias("Baby-Faced Assassin", "player", "nba", "curry-201939", "Stephen Curry", "nickname"),

  // Kevin Durant
  entityAlias("Kevin Durant", "player", "nba", "kd-201142", "Kevin Durant", "official"),
  entityAlias("KD", "player", "nba", "kd-201142", "Kevin Durant", "abbreviation"),
  entityAlias("Durant", "player", "nba", "kd-201142", "Kevin Durant", "official"),
  entityAlias("The Slim Reaper", "player", "nba", "kd-201142", "Kevin Durant", "nickname"),
  entityAlias("Easy Money Sniper", "player", "nba", "kd-201142", "Kevin Durant", "nickname"),

  // Giannis Antetokounmpo
  entityAlias("Giannis Antetokounmpo", "player", "nba", "giannis-203507", "Giannis Antetokounmpo", "official"),
  entityAlias("Giannis", "player", "nba", "giannis-203507", "Giannis Antetokounmpo", "official"),
  entityAlias("The Greek Freak", "player", "nba", "giannis-203507", "Giannis Antetokounmpo", "nickname"),
  entityAlias("Greek Freak", "player", "nba", "giannis-203507", "Giannis Antetokounmpo", "nickname"),

  // Luka Doncic
  entityAlias("Luka Doncic", "player", "nba", "luka-1629029", "Luka Doncic", "official"),
  entityAlias("Luka", "player", "nba", "luka-1629029", "Luka Doncic", "official"),
  entityAlias("Luka Magic", "player", "nba", "luka-1629029", "Luka Doncic", "nickname"),
  entityAlias("The Don", "player", "nba", "luka-1629029", "Luka Doncic", "nickname"),
  entityAlias("Wonder Boy", "player", "nba", "luka-1629029", "Luka Doncic", "nickname"),

  // Nikola Jokic
  entityAlias("Nikola Jokic", "player", "nba", "jokic-203999", "Nikola Jokic", "official"),
  entityAlias("Jokic", "player", "nba", "jokic-203999", "Nikola Jokic", "official"),
  entityAlias("The Joker", "player", "nba", "jokic-203999", "Nikola Jokic", "nickname"),
  entityAlias("Big Honey", "player", "nba", "jokic-203999", "Nikola Jokic", "nickname"),

  // Joel Embiid
  entityAlias("Joel Embiid", "player", "nba", "embiid-203954", "Joel Embiid", "official"),
  entityAlias("Embiid", "player", "nba", "embiid-203954", "Joel Embiid", "official"),
  entityAlias("The Process", "player", "nba", "embiid-203954", "Joel Embiid", "nickname"),

  // Jayson Tatum
  entityAlias("Jayson Tatum", "player", "nba", "tatum-1628369", "Jayson Tatum", "official"),
  entityAlias("Tatum", "player", "nba", "tatum-1628369", "Jayson Tatum", "official"),
  entityAlias("JT", "player", "nba", "tatum-1628369", "Jayson Tatum", "abbreviation"),

  // Shai Gilgeous-Alexander
  entityAlias("Shai Gilgeous-Alexander", "player", "nba", "sga-1628983", "Shai Gilgeous-Alexander", "official"),
  entityAlias("SGA", "player", "nba", "sga-1628983", "Shai Gilgeous-Alexander", "abbreviation"),
  entityAlias("Shai", "player", "nba", "sga-1628983", "Shai Gilgeous-Alexander", "official"),

  // Anthony Edwards
  entityAlias("Anthony Edwards", "player", "nba", "ant-1630162", "Anthony Edwards", "official"),
  entityAlias("Ant", "player", "nba", "ant-1630162", "Anthony Edwards", "slang"),
  entityAlias("Ant-Man", "player", "nba", "ant-1630162", "Anthony Edwards", "nickname"),
  entityAlias("A1 from Day 1", "player", "nba", "ant-1630162", "Anthony Edwards", "nickname"),

  // Victor Wembanyama
  entityAlias("Victor Wembanyama", "player", "nba", "wemby-1641705", "Victor Wembanyama", "official"),
  entityAlias("Wemby", "player", "nba", "wemby-1641705", "Victor Wembanyama", "nickname"),
  entityAlias("Wembanyama", "player", "nba", "wemby-1641705", "Victor Wembanyama", "official"),
  entityAlias("The Alien", "player", "nba", "wemby-1641705", "Victor Wembanyama", "nickname"),
];

// ── NFL Teams (subset) ───────────────────────────────────────────────────────

const nflTeams: AliasRow[] = [
  entityAlias("KC", "team", "nfl", "kc-nfl", "Kansas City Chiefs", "abbreviation"),
  entityAlias("Chiefs", "team", "nfl", "kc-nfl", "Kansas City Chiefs", "official"),

  entityAlias("BUF", "team", "nfl", "buf", "Buffalo Bills", "abbreviation"),
  entityAlias("Bills", "team", "nfl", "buf", "Buffalo Bills", "official"),

  entityAlias("SF", "team", "nfl", "sf-nfl", "San Francisco 49ers", "abbreviation"),
  entityAlias("49ers", "team", "nfl", "sf-nfl", "San Francisco 49ers", "official"),
  entityAlias("Niners", "team", "nfl", "sf-nfl", "San Francisco 49ers", "slang"),

  entityAlias("DAL", "team", "nfl", "dal-nfl", "Dallas Cowboys", "abbreviation"),
  entityAlias("Cowboys", "team", "nfl", "dal-nfl", "Dallas Cowboys", "official"),
  entityAlias("America's Team", "team", "nfl", "dal-nfl", "Dallas Cowboys", "nickname"),

  entityAlias("PHI", "team", "nfl", "phi-nfl", "Philadelphia Eagles", "abbreviation"),
  entityAlias("Eagles", "team", "nfl", "phi-nfl", "Philadelphia Eagles", "official"),
  entityAlias("Birds", "team", "nfl", "phi-nfl", "Philadelphia Eagles", "slang"),

  entityAlias("DET", "team", "nfl", "det-nfl", "Detroit Lions", "abbreviation"),
  entityAlias("Lions", "team", "nfl", "det-nfl", "Detroit Lions", "official"),

  entityAlias("BAL", "team", "nfl", "bal-nfl", "Baltimore Ravens", "abbreviation"),
  entityAlias("Ravens", "team", "nfl", "bal-nfl", "Baltimore Ravens", "official"),

  entityAlias("MIA", "team", "nfl", "mia-nfl", "Miami Dolphins", "abbreviation"),
  entityAlias("Dolphins", "team", "nfl", "mia-nfl", "Miami Dolphins", "official"),
  entityAlias("Fins", "team", "nfl", "mia-nfl", "Miami Dolphins", "slang"),

  entityAlias("GB", "team", "nfl", "gb", "Green Bay Packers", "abbreviation"),
  entityAlias("Packers", "team", "nfl", "gb", "Green Bay Packers", "official"),
  entityAlias("Pack", "team", "nfl", "gb", "Green Bay Packers", "slang"),
];

// ── NFL Players ──────────────────────────────────────────────────────────────

const nflPlayers: AliasRow[] = [
  entityAlias("Patrick Mahomes", "player", "nfl", "mahomes-3139477", "Patrick Mahomes", "official"),
  entityAlias("Mahomes", "player", "nfl", "mahomes-3139477", "Patrick Mahomes", "official"),
  entityAlias("Showtime", "player", "nfl", "mahomes-3139477", "Patrick Mahomes", "nickname"),

  entityAlias("Josh Allen", "player", "nfl", "allen-3918298", "Josh Allen", "official"),
  entityAlias("Allen", "player", "nfl", "allen-3918298", "Josh Allen", "official"),

  entityAlias("Lamar Jackson", "player", "nfl", "lamar-3916387", "Lamar Jackson", "official"),
  entityAlias("Lamar", "player", "nfl", "lamar-3916387", "Lamar Jackson", "official"),
  entityAlias("Action Jackson", "player", "nfl", "lamar-3916387", "Lamar Jackson", "nickname"),

  entityAlias("Travis Kelce", "player", "nfl", "kelce-2519036", "Travis Kelce", "official"),
  entityAlias("Kelce", "player", "nfl", "kelce-2519036", "Travis Kelce", "official"),

  entityAlias("Tyreek Hill", "player", "nfl", "hill-3116406", "Tyreek Hill", "official"),
  entityAlias("Cheetah", "player", "nfl", "hill-3116406", "Tyreek Hill", "nickname"),

  entityAlias("Jalen Hurts", "player", "nfl", "hurts-4040715", "Jalen Hurts", "official"),
  entityAlias("Hurts", "player", "nfl", "hurts-4040715", "Jalen Hurts", "official"),
];

// ── Stat Aliases ─────────────────────────────────────────────────────────────

interface StatRow {
  AliasId: string;
  Alias: string;
  AliasLower: string;
  Sport: string;
  CanonicalColumn: string;
  CanonicalLabel: string;
  TableName: string;
  IsAggregatable: boolean;
  CreatedAt: any;
}

function statAlias(
  alias: string,
  sport: string,
  column: string,
  label: string,
  table: string,
  aggregatable: boolean = true
): StatRow {
  return {
    AliasId: makeId(sport, "stat", column, alias),
    Alias: alias,
    AliasLower: alias.toLowerCase(),
    Sport: sport,
    CanonicalColumn: column,
    CanonicalLabel: label,
    TableName: table,
    IsAggregatable: aggregatable,
    CreatedAt: commitTs(),
  };
}

const statAliases: StatRow[] = [
  // MLB batting
  statAlias("bombs", "mlb", "HomeRuns", "Home Runs", "MlbPlayerPerformances"),
  statAlias("dingers", "mlb", "HomeRuns", "Home Runs", "MlbPlayerPerformances"),
  statAlias("jacks", "mlb", "HomeRuns", "Home Runs", "MlbPlayerPerformances"),
  statAlias("long ball", "mlb", "HomeRuns", "Home Runs", "MlbPlayerPerformances"),
  statAlias("ribbie", "mlb", "RBI", "RBI", "MlbPlayerPerformances"),
  statAlias("ribbies", "mlb", "RBI", "RBI", "MlbPlayerPerformances"),
  statAlias("K", "mlb", "Strikeouts", "Strikeouts", "MlbPlayerPerformances"),
  statAlias("whiffs", "mlb", "Strikeouts", "Strikeouts", "MlbPlayerPerformances"),
  statAlias("bags", "mlb", "StolenBases", "Stolen Bases", "MlbPlayerPerformances"),
  statAlias("steals", "mlb", "StolenBases", "Stolen Bases", "MlbPlayerPerformances"),
  statAlias("average", "mlb", "AVG", "Batting Average", "MlbPlayerPerformances", false),
  statAlias("batting average", "mlb", "AVG", "Batting Average", "MlbPlayerPerformances", false),

  // MLB pitching
  statAlias("punchouts", "mlb", "PitchingK", "Strikeouts (Pitching)", "MlbPlayerPerformances"),
  statAlias("Ks", "mlb", "PitchingK", "Strikeouts (Pitching)", "MlbPlayerPerformances"),
  statAlias("earned run average", "mlb", "ERA", "ERA", "MlbPlayerPerformances", false),

  // NBA
  statAlias("dimes", "nba", "Assists", "Assists", "NbaPlayerGameStats"),
  statAlias("boards", "nba", "Rebounds", "Rebounds", "NbaPlayerGameStats"),
  statAlias("buckets", "nba", "Points", "Points", "NbaPlayerGameStats"),
  statAlias("treys", "nba", "ThreePtMade", "Three-Pointers Made", "NbaPlayerGameStats"),
  statAlias("threes", "nba", "ThreePtMade", "Three-Pointers Made", "NbaPlayerGameStats"),
  statAlias("swats", "nba", "Blocks", "Blocks", "NbaPlayerGameStats"),
  statAlias("cookies", "nba", "Steals", "Steals", "NbaPlayerGameStats"),
  statAlias("triple-double", "nba", "TripleDouble", "Triple-Doubles", "NbaPlayerGameStats"),
  statAlias("triple double", "nba", "TripleDouble", "Triple-Doubles", "NbaPlayerGameStats"),
  statAlias("double-double", "nba", "DoubleDouble", "Double-Doubles", "NbaPlayerGameStats"),

  // NFL
  statAlias("tuddies", "nfl", "PassTD", "Passing Touchdowns", "NflPlayerGameStats"),
  statAlias("touchdowns", "nfl", "PassTD", "Passing Touchdowns", "NflPlayerGameStats"),
  statAlias("picks", "nfl", "Interceptions", "Interceptions", "NflPlayerGameStats"),
  statAlias("sacks", "nfl", "DefSacks", "Sacks", "NflPlayerGameStats"),
  statAlias("catches", "nfl", "Receptions", "Receptions", "NflPlayerGameStats"),
  statAlias("yards", "nfl", "PassYards", "Passing Yards", "NflPlayerGameStats"),
  statAlias("rushing yards", "nfl", "RushYards", "Rushing Yards", "NflPlayerGameStats"),
  statAlias("receiving yards", "nfl", "RecYards", "Receiving Yards", "NflPlayerGameStats"),
];

// ── Execute ──────────────────────────────────────────────────────────────────

async function main() {
  const allEntities: AliasRow[] = [
    ...mlbTeams,
    ...mlbPlayers,
    ...nbaTeams,
    ...nbaPlayers,
    ...nflTeams,
    ...nflPlayers,
  ];

  console.log(`Seeding ${allEntities.length} entity aliases...`);

  const BATCH = 50;
  for (let i = 0; i < allEntities.length; i += BATCH) {
    const batch = allEntities.slice(i, i + BATCH);
    try {
      await database.table("EntityAliases").upsert(batch);
      console.log(`  ✓ Inserted batch ${Math.floor(i / BATCH) + 1} (${batch.length} rows)`);
    } catch (err: any) {
      console.error(`  ✗ Batch ${Math.floor(i / BATCH) + 1} failed: ${err.message}`);
    }
  }

  console.log(`\nSeeding ${statAliases.length} stat aliases...`);

  for (let i = 0; i < statAliases.length; i += BATCH) {
    const batch = statAliases.slice(i, i + BATCH);
    try {
      await database.table("StatAliases").upsert(batch);
      console.log(`  ✓ Inserted stat batch ${Math.floor(i / BATCH) + 1} (${batch.length} rows)`);
    } catch (err: any) {
      console.error(`  ✗ Stat batch ${Math.floor(i / BATCH) + 1} failed: ${err.message}`);
    }
  }

  console.log("\n✅ Seeding complete.");
  await spanner.close();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
