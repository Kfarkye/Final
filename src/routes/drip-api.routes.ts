import { Router, Request, Response } from "express";
import { logger } from "../utils/logger";
import { edgeDb } from "../db/spanner";
import { runMlbArbitrageScout } from "../workers/mlb-kalshi-arbitrage-scout";

const router = Router();

// GET /healthz
router.get("/healthz", (_req: Request, res: Response) => {
  res.status(200).send("OK");
});

// GET /api/db/health
router.get("/api/db/health", async (_req: Request, res: Response) => {
  try {
    await edgeDb.run("SELECT 1");
    res.json({ status: "ok" });
  } catch (err: any) {
    logger.error({ msg: "DB health check failed", err: err.message });
    res.status(500).json({ status: "error", message: err.message });
  }
});

// GET /api/db/status
router.get("/api/db/status", async (_req: Request, res: Response) => {
  try {
    await edgeDb.run("SELECT 1");
    res.json({ status: "ok", message: "Database is connected and responding" });
  } catch (err: any) {
    logger.error({ msg: "DB status check failed", err: err.message });
    res.status(500).json({ status: "error", message: err.message });
  }
});

// GET /api/db/feed-health
router.get("/api/db/feed-health", async (_req: Request, res: Response) => {
  try {
    const [rows] = await edgeDb.run({
      sql: `SELECT FeedId, LastSuccessAt, LastCheckAt, RowsWrittenL5Min, RowsWrittenL1Hour, ExpectedIntervalSec, MaxStalenessBeforeAlarmSec, IsHealthy, IsGameWindow, AlarmFiredAt, ConsecutiveAlarms, LastErrorMessage, LastIngestRunId, ComputedAt FROM DataFeedHealth`
    });
    res.json({ status: "ok", count: rows.length, feeds: rows.map(r => r.toJSON()) });
  } catch (err: any) {
    logger.error({ msg: "Failed to fetch feed health", err: err.message });
    res.status(500).json({ status: "error", message: "Internal Server Error" });
  }
});

// GET /api/mlb/games
router.get("/api/mlb/games", async (req: Request, res: Response) => {
  try {
    const limit = parseInt((req.query.limit as string) || "50", 10);
    let sql = `SELECT EventId, CompetitionId, Venue, Status, HomeTeamId, HomeTeamName, HomeTeamAbbr, AwayTeamId, AwayTeamName, AwayTeamAbbr, HomeScore, AwayScore, CurrentInning, SituationBalls, SituationStrikes, SituationOuts, SituationRunnersOnBase, SituationOnFirst, SituationOnSecond, SituationOnThird, CurrentPitcherId, CurrentBatterId, LastPlayId, GameDate, StartTime, Season, FetchedAt, CreatedAt, UpdatedAt, HomeTeamLogoCdnUrl, AwayTeamLogoCdnUrl FROM MlbGames`;
    const conditions = [];
    const params: any = {};
    if (req.query.season) {
      conditions.push("Season = @season");
      params.season = req.query.season;
    }
    if (req.query.status) {
      conditions.push("Status = @status");
      params.status = req.query.status;
    }
    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }
    sql += " LIMIT @limit";
    params.limit = limit;

    const [rows] = await edgeDb.run({ sql, params });
    res.json({ status: "ok", count: rows.length, games: rows.map(r => r.toJSON()) });
  } catch (err: any) {
    logger.error({ msg: "Failed to fetch games", err: err.message });
    res.status(500).json({ status: "error", message: "Internal Server Error" });
  }
});

// GET /api/mlb/games/live
router.get("/api/mlb/games/live", async (req: Request, res: Response) => {
  try {
    const limit = parseInt((req.query.limit as string) || "50", 10);
    const sql = `SELECT EventId, CompetitionId, Venue, Status, HomeTeamId, HomeTeamName, HomeTeamAbbr, AwayTeamId, AwayTeamName, AwayTeamAbbr, HomeScore, AwayScore, CurrentInning, SituationBalls, SituationStrikes, SituationOuts, SituationRunnersOnBase, SituationOnFirst, SituationOnSecond, SituationOnThird, CurrentPitcherId, CurrentBatterId, LastPlayId, GameDate, StartTime, Season, FetchedAt, CreatedAt, UpdatedAt, HomeTeamLogoCdnUrl, AwayTeamLogoCdnUrl FROM MlbGames WHERE Status = 'STATUS_IN_PROGRESS' OR LOWER(Status) LIKE '%live%' OR LOWER(Status) LIKE '%progress%' LIMIT @limit`;
    const [rows] = await edgeDb.run({ sql, params: { limit } });
    res.json({ status: "ok", count: rows.length, games: rows.map(r => r.toJSON()) });
  } catch (err: any) {
    logger.error({ msg: "Failed to fetch live games", err: err.message });
    res.status(500).json({ status: "error", message: "Internal Server Error" });
  }
});

// GET /api/mlb/odds/current
router.get("/api/mlb/odds/current", async (req: Request, res: Response) => {
  try {
    const limit = parseInt((req.query.limit as string) || "200", 10);
    const activeOnly = req.query.activeOnly !== 'false';
    const freshOnly = req.query.freshOnly !== 'false';
    const cleanOnly = req.query.cleanOnly !== 'false';

    let sql = `SELECT ProviderEventId, Sportsbook, MarketType, Period, SelectionKey, LineKey, SportKey, CommenceTime, HomeTeam, AwayTeam, Selection, OutcomeType, LineValue, AmericanPrice, DecimalPrice, IsActive, ValidUntil, LastSeenAt, BookmakerUpdatedAt, MarketUpdatedAt, SourceFetchedAt, UpdatedAt, IsSuspicious, IsComplete, IsFresh, ValidationState FROM CurrentOdds WHERE 1=1`;
    const params: any = { limit };

    if (activeOnly) sql += " AND IsActive = TRUE";
    if (freshOnly) sql += " AND IsFresh = TRUE";
    if (cleanOnly) sql += " AND IsSuspicious = FALSE";

    if (req.query.eventId) {
      sql += " AND ProviderEventId = @eventId";
      params.eventId = req.query.eventId;
    }
    if (req.query.marketType) {
      sql += " AND MarketType = @marketType";
      params.marketType = req.query.marketType;
    }
    if (req.query.sportsbook) {
      sql += " AND Sportsbook = @sportsbook";
      params.sportsbook = req.query.sportsbook;
    }

    sql += " LIMIT @limit";

    const [rows] = await edgeDb.run({ sql, params });
    res.json({ status: "ok", count: rows.length, odds: rows.map(r => r.toJSON()) });
  } catch (err: any) {
    logger.error({ msg: "Failed to fetch current odds", err: err.message });
    res.status(500).json({ status: "error", message: "Internal Server Error" });
  }
});

// GET /api/mlb/weather
router.get("/api/mlb/weather", async (req: Request, res: Response) => {
  try {
    const limit = parseInt((req.query.limit as string) || "100", 10);
    let sql = `SELECT EventId, Venue, City, State, Temperature, Condition, WindSpeed, WindDirection, Humidity, Precipitation, RoofType, Surface, FetchedAt, CreatedAt, UpdatedAt FROM MlbGameConditions`;
    const params: any = { limit };

    if (req.query.eventId) {
      sql += " WHERE EventId = @eventId";
      params.eventId = req.query.eventId;
    }

    sql += " LIMIT @limit";

    const [rows] = await edgeDb.run({ sql, params });
    res.json({ status: "ok", count: rows.length, weather: rows.map(r => r.toJSON()) });
  } catch (err: any) {
    logger.error({ msg: "Failed to fetch weather", err: err.message });
    res.status(500).json({ status: "error", message: "Internal Server Error" });
  }
});

// GET /api/truth/live-game-dashboard/:eventId
router.get("/api/truth/live-game-dashboard/:eventId", async (req: Request, res: Response) => {
  try {
    const eventId = req.params.eventId;
    
    // 1. Fetch Game State
    const [games] = await edgeDb.run({
      sql: `SELECT * FROM MlbGames WHERE EventId = @eventId LIMIT 1`,
      params: { eventId }
    });
    
    // 2. Fetch Odds
    const [odds] = await edgeDb.run({
      sql: `SELECT Sportsbook, MarketType, OutcomeType, LineValue, AmericanPrice FROM CurrentOdds WHERE ProviderEventId = @eventId AND IsActive = TRUE`,
      params: { eventId }
    });

    const game = games[0]?.toJSON();
    if (!game) {
      return res.status(404).json({ status: "error", message: "Game not found" });
    }

    // 3. Fetch Additional Data
    const [plays] = await edgeDb.run({
      sql: `SELECT Period, PlayText, RawJson FROM MlbPlayByPlay WHERE EventId = @eventId ORDER BY Wallclock DESC LIMIT 5`,
      params: { eventId }
    });

    let currentPitcherName = game.CurrentPitcherId || "TBD";
    let pitcherThrows = "RHP";
    let pitcherIp = 0, pitcherH = 0, pitcherEr = 0, pitcherK = 0, pitcherBb = 0, pitcherCount = 0;
    
    if (game.CurrentPitcherId) {
      try {
        const [pitcherStats] = await edgeDb.run({
          sql: `SELECT Name, Throws, InningsPitched, Hits, EarnedRuns, Strikeouts, Walks, PitchCount FROM MlbBoxscorePitching WHERE EventId = @eventId AND AthleteId = @pitcherId LIMIT 1`,
          params: { eventId, pitcherId: game.CurrentPitcherId }
        });
        if (pitcherStats.length > 0) {
          const stats = pitcherStats[0].toJSON();
          currentPitcherName = stats.Name || currentPitcherName;
          pitcherThrows = stats.Throws || pitcherThrows;
          pitcherIp = stats.InningsPitched || 0;
          pitcherH = stats.Hits || 0;
          pitcherEr = stats.EarnedRuns || 0;
          pitcherK = stats.Strikeouts || 0;
          pitcherBb = stats.Walks || 0;
          pitcherCount = stats.PitchCount || 0;
        }
      } catch (err) { logger.error({ msg: "Error fetching pitcher", err }); }
    }

    let atBatName = game.CurrentBatterId || "TBD";
    if (game.CurrentBatterId) {
      try {
        const [batterProfile] = await edgeDb.run({
          sql: `SELECT FullName FROM MlbPlayerProfile WHERE PlayerId = @batterId LIMIT 1`,
          params: { batterId: game.CurrentBatterId }
        });
        if (batterProfile.length > 0) {
          atBatName = batterProfile[0].toJSON().FullName || atBatName;
        }
      } catch (err) { logger.error({ msg: "Error fetching batter", err }); }
    }

    // Assemble JSON Contract
    const dashboardContract = {
      game: {
        gameId: game.EventId,
        status: game.Status,
        inning: game.CurrentInning || "PREGAME",
        outs: game.SituationOuts || 0,
        count: {
          balls: game.SituationBalls || 0,
          strikes: game.SituationStrikes || 0
        },
        bases: {
          first: !!game.SituationOnFirst,
          second: !!game.SituationOnSecond,
          third: !!game.SituationOnThird
        },
        awayTeam: {
          abbr: game.AwayTeamAbbr,
          name: game.AwayTeamName,
          score: game.AwayScore || 0,
          record: "0-0" // Mock record
        },
        homeTeam: {
          abbr: game.HomeTeamAbbr,
          name: game.HomeTeamName,
          score: game.HomeScore || 0,
          record: "0-0"
        }
      },
      pitching: {
        currentPitcher: {
          name: currentPitcherName,
          throws: pitcherThrows,
          teamAbbr: "TBD",
          era: 3.50,
          ip: pitcherIp,
          h: pitcherH, er: pitcherEr, k: pitcherK, bb: pitcherBb,
          pitchCount: pitcherCount
        }
      },
      matchup: {
        atBat: atBatName,
        onDeck: "TBD",
        dueUp: "TBD"
      },
      odds: {
        sportsbooks: ["DraftKings", "FanDuel", "BetMGM", "Caesars", "BetRivers"],
        markets: {
          moneyline: { away: { books: [] as any[] }, home: { books: [] as any[] } },
          spread: { away: { line: "-1.5", books: [] as any[] }, home: { line: "+1.5", books: [] as any[] } },
          total: { line: "8.5", over: { books: [] as any[] }, under: { books: [] as any[] } }
        }
      },
      truthIntelligence: {
        modelProjections: {
          awayWinProb: "52%", homeWinProb: "48%",
          projectedTotal: "8.2", projectedAwayScore: "4.3", projectedHomeScore: "3.9"
        },
        marketEdge: {
          topEdgeMarket: game.AwayTeamAbbr + " -1.5", edgePercentage: "+4.2%", valueRating: 4
        }
      },
      umpire: {
        name: "Pat Hoberg", accuracy: "96.4%", consistency: "95.2%", runsExpected: "+0.14"
      },
      bullpen: {
        home: [{ name: "C. Holmes", era: "2.14", status: "AVAILABLE" }],
        away: [{ name: "K. Jansen", era: "2.74", status: "AVAILABLE" }]
      },
      playFeed: plays.map((p: any) => {
        const row = p.toJSON();
        const raw = row.RawJson || {};
        return {
          inning: row.Period || "",
          description: row.PlayText || "",
          isScoringPlay: !!raw.scoringPlay,
          scoreString: raw.awayScore !== undefined && raw.homeScore !== undefined ? `${raw.awayScore} - ${raw.homeScore}` : ""
        };
      })
    };

    // Format odds
    odds.forEach((o: any) => {
        const row = o.toJSON();
        const book = row.Sportsbook;
        const market = row.MarketType;
        const outcome = row.OutcomeType;
        const price = row.AmericanPrice > 0 ? "+" + row.AmericanPrice : String(row.AmericanPrice);
        
        if (market === "h2h") { // Moneyline
           if (outcome === "Away") dashboardContract.odds.markets.moneyline.away.books.push({ name: book, odds: price, isBest: false });
           if (outcome === "Home") dashboardContract.odds.markets.moneyline.home.books.push({ name: book, odds: price, isBest: false });
        } else if (market === "spreads") {
           const line = (row.LineValue > 0 ? "+" : "") + row.LineValue;
           if (outcome === "Away") {
               dashboardContract.odds.markets.spread.away.line = line;
               dashboardContract.odds.markets.spread.away.books.push({ name: book, odds: price, isBest: false });
           }
           if (outcome === "Home") {
               dashboardContract.odds.markets.spread.home.line = line;
               dashboardContract.odds.markets.spread.home.books.push({ name: book, odds: price, isBest: false });
           }
        } else if (market === "totals") {
           const line = String(row.LineValue);
           dashboardContract.odds.markets.total.line = line;
           if (outcome === "Over") dashboardContract.odds.markets.total.over.books.push({ name: book, odds: price, isBest: false });
           if (outcome === "Under") dashboardContract.odds.markets.total.under.books.push({ name: book, odds: price, isBest: false });
        }
    });

    res.json({ status: "ok", data: dashboardContract });
  } catch (err: any) {
    logger.error({ msg: "Failed to fetch live dashboard data", err: err.message });
    res.status(500).json({ status: "error", message: "Internal Server Error" });
  }
});

// GET /api/scout/mlb/arbitrage
router.get("/api/scout/mlb/arbitrage", async (req: Request, res: Response) => {
  try {
    const homeTeam = req.query.homeTeam as string;
    const awayTeam = req.query.awayTeam as string;
    if (!homeTeam || !awayTeam) {
      return res.status(400).json({ status: "error", message: "Missing homeTeam or awayTeam query parameters" });
    }
    logger.info({ msg: `Running MLB Arbitrage Scout manually via API for ${awayTeam} @ ${homeTeam}` });
    const data = await runMlbArbitrageScout(homeTeam, awayTeam);
    res.json({ status: "ok", data });
  } catch (err: any) {
    logger.error({ msg: "Failed to run MLB Arbitrage Scout", err: err.message });
    res.status(500).json({ status: "error", message: err.message });
  }
});


// GET /api/mlb/scores
// Proxy to statsapi.mlb.com with guaranteed fields for the live dashboard
router.get("/api/mlb/scores", async (req: Request, res: Response) => {
  try {
    const date = req.query.date as string || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&hydrate=linescore,decisions,probablePitcher,team`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`MLB API returned ${response.status}`);
    
    const data = await response.json();
    let games = data.dates?.[0]?.games || [];

    // Harden the payload to ensure status and player IDs exist in a flat games[] array
    games = games.map((g: any) => {
      return {
        ...g,
        status: g.status?.detailedState || g.status?.abstractGameState || "Preview",
        // Force player IDs up to the top level of pitcher/batter if nested weirdly
        currentPlay: {
           ...g.currentPlay,
           pitcher: {
              ...g.linescore?.defense?.pitcher,
              ...g.currentPlay?.pitcher,
              id: g.linescore?.defense?.pitcher?.id || g.currentPlay?.pitcher?.id
           },
           batter: {
              ...g.linescore?.offense?.batter,
              ...g.currentPlay?.batter,
              id: g.linescore?.offense?.batter?.id || g.currentPlay?.batter?.id
           }
        }
      };
    });

    res.json({ games });
  } catch (err: any) {
    logger.error({ msg: "Failed to proxy mlb scores", err: err.message });
    res.status(500).json({ status: "error", message: err.message });
  }
});

export default router;
