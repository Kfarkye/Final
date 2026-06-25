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
    // 1. Fetch event IDs
    const eventsUrl = `https://api.the-odds-api.com/v4/sports/soccer_fifa_world_cup/events?apiKey=${apiKey}`;
    const eventsRes = await fetch(eventsUrl);
    if (!eventsRes.ok) {
      logger.warn({ msg: "Odds API soccer events fetch failed", status: eventsRes.status });
      return [];
    }
    const eventsData = await eventsRes.json();
    if (!Array.isArray(eventsData) || eventsData.length === 0) return [];

    // 2. Iterate over events in batches using Promise.all
    const batchSize = 15;
    const allOdds: any[] = [];
    const markets = "btts,player_goal_scorer_anytime,h2h_half_time,alternate_spreads,h2h";
    const regions = "eu,uk,us";

    for (let i = 0; i < eventsData.length; i += batchSize) {
      const batch = eventsData.slice(i, i + batchSize);
      const batchPromises = batch.map(async (event: any) => {
        try {
          const oddsUrl = `https://api.the-odds-api.com/v4/sports/soccer_fifa_world_cup/events/${event.id}/odds?apiKey=${apiKey}&regions=${regions}&markets=${markets}&oddsFormat=american`;
          const res = await fetch(oddsUrl);
          if (!res.ok) {
             logger.warn({ msg: `Failed to fetch odds for event ${event.id}`, status: res.status });
             return null;
          }
          return await res.json();
        } catch (err: any) {
          logger.error({ msg: `Error fetching odds for event ${event.id}`, error: err.message });
          return null;
        }
      });
      
      const batchResults = await Promise.all(batchPromises);
      for (const result of batchResults) {
        if (result) allOdds.push(result);
      }
    }
    
    return allOdds;
  } catch (err: any) {
    logger.error({ msg: "Failed to fetch Odds API soccer", error: err.message });
    return [];
  }
}

function toAmerican(decimal: number): number {
  if (decimal >= 2.0) {
    return Math.round((decimal - 1) * 100);
  } else if (decimal > 1.0) {
    return Math.round(-100 / (decimal - 1));
  }
  return 0;
}

function addMinutes(dateStr: string, mins: number): string {
  const d = new Date(dateStr);
  d.setMinutes(d.getMinutes() + mins);
  return d.toISOString();
}

function normalizeSel(outcome: any): string {
  return outcome.name.toLowerCase().replace(/[^a-z0-9]/g, '_');
}

function classifyOutcome(ev: any, market: any, outcome: any): string {
  const name = outcome.name.toLowerCase();
  const home = (ev.home_team || "").toLowerCase();
  const away = (ev.away_team || "").toLowerCase();
  
  if (market.key.includes('h2h') || market.key === 'alternate_spreads') {
    if (name === 'draw') return 'draw';
    if (name === home) return 'home';
    if (name === away) return 'away';
    return 'team';
  }
  if (market.key === 'btts') {
    if (name === 'yes') return 'yes';
    if (name === 'no') return 'no';
  }
  if (market.key === 'player_goal_scorer_anytime') {
    return 'player';
  }
  return 'unknown';
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
      // Write games to SoccerGames
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
            clock: game.clock ? game.clock.substring(0, 16) : null,
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
      await transaction.commit();
    });
  } catch (err: any) {
    logger.error({ msg: "Failed soccer games transaction", error: err.message });
  }

  if (oddsEvents.length === 0) {
    return { gamesIngested, oddsSnapshotsIngested: 0 };
  }

  const runId = `soccer-wc-${Date.now()}`;
  const now = new Date().toISOString();
  
  try {
    await edgeDb.runTransactionAsync(async (transaction) => {
      // Phase 1: Open the run
      await transaction.runUpdate({
        sql: `
          INSERT INTO OddsIngestionRuns (
            RunId, Provider, SportKey, Markets, Regions, ScheduledBucket, RequestedAt, 
            AdapterVersion, NormalizerVersion, Status, CommittedAt
          ) VALUES (
            @runId, 'the-odds-api', 'soccer_fifa_world_cup', 'btts,player_goal_scorer_anytime,h2h_half_time,alternate_spreads,h2h',
            'eu,uk,us', 'live', @requestedAt, '1.0.0', '1.0.0', 'RUNNING', PENDING_COMMIT_TIMESTAMP()
          )
        `,
        params: {
          runId,
          requestedAt: now
        }
      });
      
      // Phase 2: Normalize every bookmaker x market x outcome into CurrentOdds
      const currentOddsRows: any[] = [];
      for (const ev of oddsEvents) {
        for (const book of ev.bookmakers || []) {
          for (const market of book.markets || []) {
            for (const outcome of market.outcomes || []) {
              const period = market.key === 'h2h_half_time' ? '1H' : 'FT';
              const lineKey = outcome.point != null ? String(outcome.point) : 'NONE';
              
              currentOddsRows.push({
                ProviderEventId: ev.id,
                Sportsbook: book.key,
                MarketType: market.key,
                Period: period,
                SelectionKey: normalizeSel(outcome),
                LineKey: lineKey,
                SportKey: 'soccer_fifa_world_cup',
                CommenceTime: ev.commence_time,
                HomeTeam: ev.home_team,
                AwayTeam: ev.away_team,
                Selection: outcome.name,
                OutcomeType: classifyOutcome(ev, market, outcome),
                LineValue: outcome.point ?? null,
                AmericanPrice: toAmerican(outcome.price),
                DecimalPrice: outcome.price,
                IsActive: true,
                ValidUntil: addMinutes(now, 15),
                LastSeenAt: now,
                BookmakerUpdatedAt: book.last_update ?? null,
                MarketUpdatedAt: market.last_update ?? null,
                SourceFetchedAt: now,
                LastRunId: runId,
                UpdatedAt: 'spanner.commit_timestamp()' // string sentinel required by the Spanner library for allow_commit_timestamp, or we import Spanner
              });
              oddsSnapshotsIngested++;
            }
          }
        }
      }
      
      if (currentOddsRows.length > 0) {
        // Upsert normalized rows
        transaction.upsert('CurrentOdds', currentOddsRows);
      }
      
      // Phase 3: Close the run
      await transaction.runUpdate({
        sql: `
          UPDATE OddsIngestionRuns SET
            EventCount = @eventCount,
            SnapshotCount = @snapshotCount,
            ReceivedAt = @receivedAt,
            CompletedAt = PENDING_COMMIT_TIMESTAMP(),
            Status = 'SUCCESS'
          WHERE RunId = @runId
        `,
        params: {
          runId,
          eventCount: oddsEvents.length,
          snapshotCount: oddsSnapshotsIngested,
          receivedAt: now
        }
      });
      
      await transaction.commit();
    });
    
    logger.info({ msg: "World Cup Ingest complete", gamesIngested, oddsSnapshotsIngested });
  } catch (err: any) {
    logger.error({ msg: "Failed soccer ingest transaction", error: err.message });
    // Attempt to mark the run as failed
    try {
      await edgeDb.runTransactionAsync(async (t) => {
        await t.runUpdate({
          sql: `UPDATE OddsIngestionRuns SET Status = 'FAILED', CompletedAt = PENDING_COMMIT_TIMESTAMP() WHERE RunId = @runId`,
          params: { runId }
        });
        await t.commit();
      });
    } catch (e) {
      logger.error({ msg: "Failed to mark run as failed", error: (e as any).message });
    }
  }
  
  return { gamesIngested, oddsSnapshotsIngested };
}
