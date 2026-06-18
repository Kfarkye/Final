import { edgeDb } from "../db/spanner";
import { logger } from "../utils/logger";

export interface SoccerGameData {
  eventId: string;
  league: string;
  commenceTime: string;
  homeTeam: string;
  awayTeam: string;
  status: string;
  clock: string | null;
  homeScore: number | null;
  awayScore: number | null;
  redCardsHome: number | null;
  redCardsAway: number | null;
}

const LEAGUES = ["fifa.worldq.conmebol", "fifa.worldq.uefa", "fifa.world"];

export function cleanSoccerTeamName(name: string): string {
  return name.toLowerCase()
    .replace(/[\.\-']/g, "")
    .replace(/\b(football|soccer|fc|national|team|club|rep|republic|of)\b/gi, "")
    .trim();
}

export function soccerTeamsMatch(teamA: string, teamB: string): boolean {
  const cleanA = cleanSoccerTeamName(teamA);
  const cleanB = cleanSoccerTeamName(teamB);
  return cleanA.includes(cleanB) || cleanB.includes(cleanA);
}

async function fetchEspnSoccerGames(): Promise<SoccerGameData[]> {
  const allGames: SoccerGameData[] = [];
  
  for (const league of LEAGUES) {
    try {
      const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/${league}/scoreboard`;
      const res = await fetch(url);
      if (!res.ok) {
        logger.warn({ msg: `ESPN scoreboard for ${league} failed`, status: res.status });
        continue;
      }
      const data = await res.json() as any;
      const rawEvents = data.events || [];
      
      for (const event of rawEvents) {
        const competition = event.competitions?.[0] || {};
        const competitors = competition.competitors || [];
        const home = competitors.find((c: any) => c.homeAway === "home");
        const away = competitors.find((c: any) => c.homeAway === "away");
        
        if (!home || !away || !event.id) continue;
        
        const state = (event.status?.type?.state || "").toLowerCase();
        let status = "upcoming";
        if (state === "in") status = "live";
        else if (state === "post") status = "final";
        
        const clock = event.status?.type?.detail || event.status?.displayClock || null;
        
        const homeScore = status !== "upcoming" && home.score !== undefined ? parseInt(home.score, 10) : null;
        const awayScore = status !== "upcoming" && away.score !== undefined ? parseInt(away.score, 10) : null;
        
        const getRedCards = (comp: any) => {
          if (typeof comp.redCards === "number") return comp.redCards;
          if (comp.redCardsCount !== undefined) return Number(comp.redCardsCount);
          const redCardsStat = comp.statistics?.find((s: any) => s.name === "redCards");
          if (redCardsStat) return Number(redCardsStat.value || 0);
          return 0;
        };
        
        allGames.push({
          eventId: event.id,
          league,
          commenceTime: event.date ? new Date(event.date).toISOString() : new Date().toISOString(),
          homeTeam: home.team?.displayName || "Home Team",
          awayTeam: away.team?.displayName || "Away Team",
          status,
          clock,
          homeScore: isNaN(homeScore as any) ? null : homeScore,
          awayScore: isNaN(awayScore as any) ? null : awayScore,
          redCardsHome: getRedCards(home),
          redCardsAway: getRedCards(away)
        });
      }
    } catch (err: any) {
      logger.error({ msg: `Failed to fetch/parse ESPN soccer league ${league}`, error: err.message });
    }
  }
  
  return allGames;
}

async function fetchOddsApiSoccer(): Promise<any[]> {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    logger.warn({ msg: "ODDS_API_KEY is not configured. Skipping Odds API soccer fetch." });
    return [];
  }
  try {
    const url = `https://api.the-odds-api.com/v4/sports/soccer_fifa_world_cup/odds/?apiKey=${apiKey}&regions=us&markets=h2h&oddsFormat=american`;
    const res = await fetch(url);
    if (!res.ok) {
      logger.warn({ msg: "Odds API soccer fetch failed", status: res.status });
      return [];
    }
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (err: any) {
    logger.error({ msg: "Failed to fetch Odds API soccer", error: err.message });
    return [];
  }
}

export async function runSoccerIngest(): Promise<{ gamesIngested: number; oddsSnapshotsIngested: number }> {
  logger.info({ msg: "Running World Cup Ingest Worker" });
  
  const espnGames = await fetchEspnSoccerGames();
  const oddsEvents = await fetchOddsApiSoccer();
  
  let gamesIngested = 0;
  let oddsSnapshotsIngested = 0;
  
  if (espnGames.length === 0) {
    logger.warn({ msg: "No soccer games fetched from ESPN. Skipping ingest." });
    return { gamesIngested: 0, oddsSnapshotsIngested: 0 };
  }
  
  try {
    await edgeDb.runTransactionAsync(async (transaction) => {
      // 1. Write games to SoccerGames
      for (const game of espnGames) {
        await transaction.runUpdate({
          sql: `
            INSERT OR UPDATE INTO SoccerGames (
              EventId, League, CommenceTime, HomeTeam, AwayTeam, Status, Clock, HomeScore, AwayScore, RedCardsHome, RedCardsAway
            ) VALUES (
              @eventId, @league, @commenceTime, @homeTeam, @awayTeam, @status, @clock, @homeScore, @awayScore, @redCardsHome, @redCardsAway
            )
          `,
          params: {
            eventId: game.eventId,
            league: game.league,
            commenceTime: game.commenceTime,
            homeTeam: game.homeTeam,
            awayTeam: game.awayTeam,
            status: game.status,
            clock: game.clock,
            homeScore: game.homeScore !== null ? game.homeScore : null,
            awayScore: game.awayScore !== null ? game.awayScore : null,
            redCardsHome: game.redCardsHome !== null ? game.redCardsHome : null,
            redCardsAway: game.redCardsAway !== null ? game.redCardsAway : null
          },
          types: {
            eventId: "string",
            league: "string",
            commenceTime: "timestamp",
            homeTeam: "string",
            awayTeam: "string",
            status: "string",
            clock: "string",
            homeScore: "int64",
            awayScore: "int64",
            redCardsHome: "int64",
            redCardsAway: "int64"
          }
        });
        gamesIngested++;
      }
      
      // 2. Map Odds API and write to SoccerOddsHistory
      const capturedAt = new Date().toISOString();
      
      for (const oddsEvent of oddsEvents) {
        const matchedGame = espnGames.find((g) => {
          const timeDiff = Math.abs(new Date(g.commenceTime).getTime() - new Date(oddsEvent.commence_time).getTime());
          if (timeDiff > 24 * 60 * 60 * 1000) return false;
          
          const normalMatch = soccerTeamsMatch(g.homeTeam, oddsEvent.home_team) && soccerTeamsMatch(g.awayTeam, oddsEvent.away_team);
          const reverseMatch = soccerTeamsMatch(g.homeTeam, oddsEvent.away_team) && soccerTeamsMatch(g.awayTeam, oddsEvent.home_team);
          return normalMatch || reverseMatch;
        });
        
        if (!matchedGame) continue;
        
        for (const bookmaker of oddsEvent.bookmakers || []) {
          const h2hMarket = bookmaker.markets?.find((m: any) => m.key === "h2h");
          if (!h2hMarket?.outcomes || h2hMarket.outcomes.length < 3) continue;
          
          let homePrice: number | null = null;
          let drawPrice: number | null = null;
          let awayPrice: number | null = null;
          
          for (const outcome of h2hMarket.outcomes) {
            const outcomeName = outcome.name.toLowerCase();
            if (outcomeName === "draw") {
              drawPrice = outcome.price;
            } else if (soccerTeamsMatch(outcome.name, oddsEvent.home_team)) {
              homePrice = outcome.price;
            } else if (soccerTeamsMatch(outcome.name, oddsEvent.away_team)) {
              awayPrice = outcome.price;
            }
          }
          
          if (homePrice !== null && drawPrice !== null && awayPrice !== null) {
            await transaction.runUpdate({
              sql: `
                INSERT OR UPDATE INTO SoccerOddsHistory (
                  EventId, CapturedAt, Bookmaker, Market, HomePrice, DrawPrice, AwayPrice
                ) VALUES (
                  @eventId, @capturedAt, @bookmaker, @market, @homePrice, @drawPrice, @awayPrice
                )
              `,
              params: {
                eventId: matchedGame.eventId,
                capturedAt: capturedAt,
                bookmaker: bookmaker.key,
                market: "h2h_3_way",
                homePrice: homePrice,
                drawPrice: drawPrice,
                awayPrice: awayPrice
              },
              types: {
                eventId: "string",
                capturedAt: "timestamp",
                bookmaker: "string",
                market: "string",
                homePrice: "int64",
                drawPrice: "int64",
                awayPrice: "int64"
              }
            });
            oddsSnapshotsIngested++;
          }
        }
      }
      
      await transaction.commit();
    });
    
    logger.info({ msg: "World Cup Ingest complete", gamesIngested, oddsSnapshotsIngested });
  } catch (err: any) {
    logger.error({ msg: "Failed soccer ingest transaction", error: err.message });
  }
  
  return { gamesIngested, oddsSnapshotsIngested };
}
