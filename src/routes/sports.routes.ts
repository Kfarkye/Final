import { Router, Request, Response } from "express";
import { startBackfill, stopBackfill, getBackfillStatus } from "../workers/odds-backfill-worker";
import { getTeamNickname } from "../utils/mlb-teams";
import { fetchEspnScoreboard } from "../lib/espn-grounding";
import { logger } from "../utils/logger";
import { runSoccerIngest } from "../workers/soccer-ingest-worker";
import { runPmIngestion } from "../workers/pm-ingest-worker";
import { runMlbStatsIngestion, runMlbStatsBackfill } from "../workers/mlb-stats-worker";
import { exportLedgerForDate } from "../services/ledger-exporter";
import { getUnifiedMlbSlate } from "../services/mlb-slate-aggregator";
import { runTeamIntelligenceIngest } from "../workers/team-intelligence-worker";
import { runTeamIntelligenceCompute } from "../workers/team-intelligence-compute";
import { runFeedWatchdog } from "../workers/feed-watchdog-worker";
import { edgeDb } from "../db/spanner";

const router = Router();

// --- Slate Helpers ---

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

  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

let serverTeamCache: any[] | null = null;
async function getServerTeams() {
  if (serverTeamCache) return serverTeamCache;
  try {
    const res = await fetch("https://statsapi.mlb.com/api/v1/teams?sportId=1");
    if (res.ok) {
      const data = await res.json() as any;
      serverTeamCache = data.teams || [];
    }
  } catch (err) {
    logger.error({ msg: "Failed to load teams in server:", err });
  }
  return serverTeamCache || [];
}

function extractOddsForBookmaker(bookmaker: any, homeTeam: string, awayTeam: string) {
  let homeML: number | null = null;
  let awayML: number | null = null;
  let totalLine: number | null = null;
  let overPrice: number | null = null;
  let underPrice: number | null = null;

  for (const market of bookmaker.markets || []) {
    if (market.key === "h2h") {
      for (const outcome of market.outcomes || []) {
        if (outcome.name === homeTeam) homeML = outcome.price;
        if (outcome.name === awayTeam) awayML = outcome.price;
      }
    }
    if (market.key === "totals") {
      const overOutcome = market.outcomes?.find((o: any) => o.name === "Over");
      const underOutcome = market.outcomes?.find((o: any) => o.name === "Under");
      if (overOutcome) {
        totalLine = overOutcome.point;
        overPrice = overOutcome.price;
      }
      if (underOutcome) {
        underPrice = underOutcome.price;
      }
    }
  }
  return { homeML, awayML, totalLine, overPrice, underPrice };
}

// ── Unified Slate (single-call aggregator for the LLM) ──

router.get("/mlb/slate/unified", async (req: Request, res: Response) => {
  try {
    const rawDate = req.query.date as string | undefined;
    // Sanitize: only allow safe date formats
    const dateQuery = rawDate && /^[\w\-]{1,20}$/.test(rawDate) ? rawDate : undefined;
    const slate = await getUnifiedMlbSlate(dateQuery);
    // Short cache to avoid hammering during LLM retry loops (30s stale-while-revalidate)
    res.set("Cache-Control", "public, max-age=30, stale-while-revalidate=60");
    res.json(slate);
  } catch (err: any) {
    logger.error({ msg: "Unified MLB slate failed", err: err.message, stack: err.stack?.slice(0, 500) });
    res.status(500).json({
      error: "Unified slate aggregation failed",
      detail: err.message,
      hint: "Fallback to /api/mlb/slate (legacy) or individual tools.",
    });
  }
});

router.get("/mlb/slate", async (req: Request, res: Response) => {
  try {
    const dateQuery = req.query.date as string | undefined;
    const formattedDate = getMlbTargetDate(dateQuery);
    const yyyy = parseInt(formattedDate.split("-")[0]);

    // 1. Fetch MLB schedule
    const mlbScheduleUrl = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${formattedDate}&hydrate=probablePitcher`;
    const scheduleRes = await fetch(mlbScheduleUrl);
    if (!scheduleRes.ok) {
      throw new Error(`Failed to fetch MLB schedule: ${scheduleRes.statusText}`);
    }
    const scheduleData = await scheduleRes.json() as any;
    const rawGames = scheduleData.dates?.[0]?.games || [];

    // 2. Fetch team abbreviation lookup cache
    const teamsList = await getServerTeams();

    // 3. Hydrate pitcher stats
    const pitcherIds = new Set<number>();
    for (const g of rawGames) {
      if (g.teams?.away?.probablePitcher?.id) pitcherIds.add(g.teams.away.probablePitcher.id);
      if (g.teams?.home?.probablePitcher?.id) pitcherIds.add(g.teams.home.probablePitcher.id);
    }

    const pitcherMap = new Map<number, any>();
    if (pitcherIds.size > 0) {
      try {
        const peopleUrl = `https://statsapi.mlb.com/api/v1/people?personIds=${Array.from(pitcherIds).join(",")}&hydrate=stats(group=pitching,type=season,season=${yyyy})`;
        const peopleRes = await fetch(peopleUrl);
        if (peopleRes.ok) {
          const peopleData = await peopleRes.json() as any;
          for (const person of peopleData.people || []) {
            const stat = person.stats?.[0]?.splits?.[0]?.stat || {};
            pitcherMap.set(person.id, {
              name: person.fullName,
              hand: person.pitchHand?.code || null,
              era: stat.era ?? null,
              whip: stat.whip ?? null,
              wins: stat.wins ?? null,
              losses: stat.losses ?? null,
            });
          }
        }
      } catch (err: any) {
        logger.error({ msg: "Failed to hydrate pitcher stats for slate", err: err.message });
      }
    }

    // 4. Fetch ESPN scoreboard
    let espnEvents: any[] = [];
    try {
      const espnData = await fetchEspnScoreboard(formattedDate);
      espnEvents = espnData.events || [];
    } catch (err: any) {
      logger.error({ msg: "Failed to fetch ESPN scoreboard for slate", err: err.message });
    }

    // 5. Fetch live odds
    let oddsEvents: any[] = [];
    const oddsApiKey = process.env.ODDS_API_KEY;
    if (oddsApiKey) {
      try {
        const oddsUrl = `https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/?apiKey=${oddsApiKey}&regions=us&markets=h2h,totals&oddsFormat=american`;
        const oddsRes = await fetch(oddsUrl);
        if (oddsRes.ok) {
          const oRes = await oddsRes.json() as any;
          oddsEvents = Array.isArray(oRes) ? oRes : (oRes.odds || []);
        }
      } catch (err: any) {
        logger.error({ msg: "Failed to fetch Odds API data for slate", err: err.message });
      }
    }

    // 6. Merge sources
    const games: any[] = [];
    let liveCount = 0;
    let finalCount = 0;
    let scheduledCount = 0;

    for (const g of rawGames) {
      const awayId = g.teams?.away?.team?.id;
      const homeId = g.teams?.home?.team?.id;
      const awayTeamName = g.teams?.away?.team?.name || "";
      const homeTeamName = g.teams?.home?.team?.name || "";

      const awayAbbr = teamsList.find(t => t.id === awayId)?.abbreviation || "";
      const homeAbbr = teamsList.find(t => t.id === homeId)?.abbreviation || "";

      // Match ESPN Event
      let espnMatch: any = null;
      const mlbHomeNick = getTeamNickname(homeTeamName);
      const mlbAwayNick = getTeamNickname(awayTeamName);
      for (const event of espnEvents) {
        const espnHomeNick = getTeamNickname(event.home_team);
        const espnAwayNick = getTeamNickname(event.away_team);
        if (
          (mlbHomeNick === espnHomeNick && mlbAwayNick === espnAwayNick) ||
          (mlbHomeNick === espnAwayNick && mlbAwayNick === espnHomeNick)
        ) {
          espnMatch = event;
          break;
        }
      }

      // Determine Status
      let status = "scheduled";
      const detailedState = (g.status?.detailedState || "").toLowerCase();
      if (detailedState.includes("postpon") || detailedState.includes("cancel")) {
        status = "postponed";
      } else if (espnMatch) {
        if (espnMatch.status === "live") status = "live";
        else if (espnMatch.status === "final") status = "final";
        else status = "scheduled";
      } else {
        if (detailedState.includes("progress") || detailedState.includes("live") || detailedState.includes("delayed")) {
          status = "live";
        } else if (detailedState.includes("final") || detailedState.includes("game over") || detailedState.includes("completed")) {
          status = "final";
        } else {
          status = "scheduled";
        }
      }

      // Increment counts
      if (status === "live") liveCount++;
      else if (status === "final") finalCount++;
      else if (status === "scheduled") scheduledCount++;

      // Inning description
      let inningVal: string | null = null;
      if (status === "live" && espnMatch) {
        if (espnMatch.inning) {
          const half = espnMatch.inning_half ? (espnMatch.inning_half.toLowerCase().includes("top") ? "Top" : "Bot") : "";
          inningVal = half ? `${half} ${espnMatch.inning}` : `${espnMatch.inning}`;
        }
      }

      // Scores
      const awayScore = (status === "live" || status === "final")
        ? (espnMatch?.away_score != null ? parseInt(espnMatch.away_score, 10) : (g.teams?.away?.score ?? null))
        : null;
      const homeScore = (status === "live" || status === "final")
        ? (espnMatch?.home_score != null ? parseInt(espnMatch.home_score, 10) : (g.teams?.home?.score ?? null))
        : null;

      // Pitchers
      const awayPitcherRaw = g.teams?.away?.probablePitcher;
      const homePitcherRaw = g.teams?.home?.probablePitcher;

      const awayPitcherHydrated = awayPitcherRaw ? pitcherMap.get(awayPitcherRaw.id) : null;
      const homePitcherHydrated = homePitcherRaw ? pitcherMap.get(homePitcherRaw.id) : null;

      const awayPitcher = awayPitcherRaw ? {
        name: awayPitcherRaw.fullName,
        hand: awayPitcherHydrated?.hand || null,
        era: awayPitcherHydrated?.era || null,
        record: (awayPitcherHydrated?.wins != null && awayPitcherHydrated?.losses != null) ? `${awayPitcherHydrated.wins}-${awayPitcherHydrated.losses}` : null,
        whip: awayPitcherHydrated?.whip || null
      } : null;

      const homePitcher = homePitcherRaw ? {
        name: homePitcherRaw.fullName,
        hand: homePitcherHydrated?.hand || null,
        era: homePitcherHydrated?.era || null,
        record: (homePitcherHydrated?.wins != null && homePitcherHydrated?.losses != null) ? `${homePitcherHydrated.wins}-${homePitcherHydrated.losses}` : null,
        whip: homePitcherHydrated?.whip || null
      } : null;

      // Odds API matching
      let oddsMatch: any = null;
      for (const event of oddsEvents) {
        const oddsHomeNick = getTeamNickname(event.home_team);
        const oddsAwayNick = getTeamNickname(event.away_team);
        if (
          (mlbHomeNick === oddsHomeNick && mlbAwayNick === oddsAwayNick) ||
          (mlbHomeNick === oddsAwayNick && mlbAwayNick === oddsHomeNick)
        ) {
          oddsMatch = event;
          break;
        }
      }

      // Extract Odds h2h / totals
      let moneylineAway: number | null = null;
      let moneylineHome: number | null = null;
      let totalLine: number | null = null;
      let overPrice: number | null = null;
      let underPrice: number | null = null;
      let oddsSource: string | null = null;

      if (oddsMatch && Array.isArray(oddsMatch.bookmakers)) {
        const pinnacle = oddsMatch.bookmakers.find((b: any) => b.key === "pinnacle");
        if (pinnacle) {
          const o = extractOddsForBookmaker(pinnacle, oddsMatch.home_team, oddsMatch.away_team);
          moneylineHome = o.homeML;
          moneylineAway = o.awayML;
          totalLine = o.totalLine;
          overPrice = o.overPrice;
          underPrice = o.underPrice;
          oddsSource = "pinnacle";
        } else {
          // Consensus average
          const otherBooks = oddsMatch.bookmakers.filter((b: any) => b.key !== "pinnacle");
          if (otherBooks.length > 0) {
            let sumHomeML = 0, countHomeML = 0;
            let sumAwayML = 0, countAwayML = 0;
            let sumTotalLine = 0, countTotalLine = 0;
            let sumOverPrice = 0, countOverPrice = 0;
            let sumUnderPrice = 0, countUnderPrice = 0;

            for (const b of otherBooks) {
              const o = extractOddsForBookmaker(b, oddsMatch.home_team, oddsMatch.away_team);
              if (o.homeML !== null) { sumHomeML += o.homeML; countHomeML++; }
              if (o.awayML !== null) { sumAwayML += o.awayML; countAwayML++; }
              if (o.totalLine !== null) { sumTotalLine += o.totalLine; countTotalLine++; }
              if (o.overPrice !== null) { sumOverPrice += o.overPrice; countOverPrice++; }
              if (o.underPrice !== null) { sumUnderPrice += o.underPrice; countUnderPrice++; }
            }

            moneylineHome = countHomeML > 0 ? Math.round(sumHomeML / countHomeML) : null;
            moneylineAway = countAwayML > 0 ? Math.round(sumAwayML / countAwayML) : null;
            totalLine = countTotalLine > 0 ? Number((sumTotalLine / countTotalLine).toFixed(1)) : null;
            overPrice = countOverPrice > 0 ? Math.round(sumOverPrice / countOverPrice) : null;
            underPrice = countUnderPrice > 0 ? Math.round(sumUnderPrice / countUnderPrice) : null;
            oddsSource = "consensus";
          }
        }
      }

      // Convert start date to America/New_York
      const gameTime = new Date(g.gameDate);
      const timeStr = gameTime.toLocaleTimeString("en-US", {
        timeZone: "America/New_York",
        hour: "numeric",
        minute: "2-digit"
      });
      const startTimeLocal = `${timeStr} ET`;

      games.push({
        gamePk: g.gamePk,
        status,
        startTimeLocal,
        startTimeIso: g.gameDate,
        inning: inningVal,
        venue: g.venue?.name || null,
        away: {
          team: awayTeamName,
          abbr: awayAbbr || null,
          record: g.teams?.away?.leagueRecord ? `${g.teams.away.leagueRecord.wins}-${g.teams.away.leagueRecord.losses}` : null,
          score: awayScore,
          pitcher: awayPitcher,
          moneyline: moneylineAway
        },
        home: {
          team: homeTeamName,
          abbr: homeAbbr || null,
          record: g.teams?.home?.leagueRecord ? `${g.teams.home.leagueRecord.wins}-${g.teams.home.leagueRecord.losses}` : null,
          score: homeScore,
          pitcher: homePitcher,
          moneyline: moneylineHome
        },
        total: totalLine !== null ? {
          line: totalLine,
          over: overPrice,
          under: underPrice
        } : null,
        oddsSource
      });
    }

    res.json({
      date: formattedDate,
      generatedAt: new Date().toISOString(),
      timezone: "America/New_York",
      games,
      meta: {
        gameCount: games.length,
        live: liveCount,
        final: finalCount,
        scheduled: scheduledCount
      }
    });

  } catch (err: any) {
    logger.error({ msg: "Failed to assemble MLB slate payload", err: err.message });
    res.status(500).json({ error: `Failed to assemble MLB slate payload: ${err.message}` });
  }
});

router.post("/workers/odds-backfill", (req: Request, res: Response) => {
  const result = startBackfill(req.body || {});
  res.json(result);
});

router.delete("/workers/odds-backfill", (_req: Request, res: Response) => {
  const result = stopBackfill();
  res.json(result);
});

router.get("/workers/odds-backfill", (_req: Request, res: Response) => {
  res.json(getBackfillStatus());
});

router.post("/workers/soccer-ingest", async (_req: Request, res: Response) => {
  try {
    const result = await runSoccerIngest();
    res.json({ success: true, ...result });
  } catch (err: any) {
    logger.error({ msg: "Soccer ingest worker failed via route", error: err.message });
    res.status(500).json({ error: err.message });
  }
});

router.post("/workers/pm-ingest", async (_req: Request, res: Response) => {
  logger.info({ msg: "Received manual PM ingestion trigger request via sports routes" });
  try {
    const stats = await runPmIngestion();
    res.json({ success: true, stats });
  } catch (err: any) {
    logger.error({ msg: "Failed PM ingestion trigger via sports routes", error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── MLB Stats Ingestion (Box Scores + Player Stats) ──

router.post("/workers/mlb-stats-ingest", async (req: Request, res: Response) => {
  const date = (req.query.date as string) || new Date().toISOString().split("T")[0];
  logger.info({ msg: "MLB stats ingestion triggered", date });
  try {
    const result = await runMlbStatsIngestion(date);
    res.json({ success: true, ...result });
  } catch (err: any) {
    logger.error({ msg: "MLB stats ingestion failed", error: err.message });
    res.status(500).json({ error: err.message });
  }
});

router.post("/workers/mlb-stats-backfill", async (req: Request, res: Response) => {
  const startDate = (req.query.startDate as string) || "2026-04-01";
  const endDate = (req.query.endDate as string) || new Date().toISOString().split("T")[0];
  logger.info({ msg: "MLB stats backfill triggered", startDate, endDate });
  try {
    const result = await runMlbStatsBackfill(startDate, endDate);
    res.json({ success: true, ...result });
  } catch (err: any) {
    logger.error({ msg: "MLB stats backfill failed", error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── Ledger Export (Git Ledger Serialization) ──

router.post("/workers/ledger-export", async (req: Request, res: Response) => {
  const date = (req.query.date as string) || new Date(Date.now() - 86400000).toISOString().split("T")[0];
  logger.info({ msg: "Ledger export triggered", date });
  try {
    const result = await exportLedgerForDate(date);
    res.json({ success: true, ...result });
  } catch (err: any) {
    logger.error({ msg: "Ledger export failed", error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── Team Intelligence Ingestion (TeamRankings + Covers → Spanner) ──

router.post("/workers/team-intelligence-ingest", async (req: Request, res: Response) => {
  const source = req.query.source as string | undefined;
  const skipCompute = req.query.skipCompute === "true";
  logger.info({ msg: "Team intelligence ingestion triggered", source: source || "ALL", skipCompute });
  try {
    const ingestResult = await runTeamIntelligenceIngest(source);
    let computeResult = null;
    if (!skipCompute) {
      computeResult = await runTeamIntelligenceCompute(ingestResult.snapshotDate);
    }
    res.json({ success: true, ingest: ingestResult, compute: computeResult });
  } catch (err: any) {
    logger.error({ msg: "Team intelligence ingestion failed", error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── Team Intelligence Compute (Chart Table Materializer) ──

router.post("/workers/team-intelligence-compute", async (req: Request, res: Response) => {
  const date = (req.query.date as string) || new Date().toISOString().split("T")[0];
  logger.info({ msg: "Team intelligence compute triggered", date });
  try {
    const result = await runTeamIntelligenceCompute(date);
    res.json({ success: true, ...result });
  } catch (err: any) {
    logger.error({ msg: "Team intelligence compute failed", error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── Feed Watchdog (Backup Odds Ingestor + Dead Feed Reconciler) ──

router.post("/workers/feed-watchdog", async (_req: Request, res: Response) => {
  logger.info({ msg: "Feed watchdog triggered" });
  try {
    const result = await runFeedWatchdog();
    res.json({ success: true, ...result });
  } catch (err: any) {
    logger.error({ msg: "Feed watchdog failed", error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Covers MLB Team Stats ──

router.get("/mlb/covers/team-stats", async (req: Request, res: Response) => {
  try {
    const db = edgeDb;
    const [rows] = await db.run({
      sql: `
        SELECT 
          Season,
          SnapshotDate,
          TeamCode,
          TeamName,
          Wins,
          Losses,
          MoneyValue,
          HomeWins,
          HomeLosses,
          HomeMoneyValue,
          AwayWins,
          AwayLosses,
          AwayMoneyValue,
          RunLineWins,
          RunLineLosses,
          RunLineMoney,
          OverUnderWins,
          OverUnderLosses,
          AVG AS HittingAvg,
          OPS AS HittingOps,
          ERA AS PitchingEra,
          BullpenERA AS BullpenEra
        FROM CoversMlbTeamStatSnapshot
        WHERE SnapshotDate = (SELECT MAX(SnapshotDate) FROM CoversMlbTeamStatSnapshot)
      `
    });

    const jsonRows = rows.map((r: any) => r.toJSON());
    
    const formattedRows = jsonRows.map((r: any) => ({
      season: Number(r.Season),
      snapshotDate: r.SnapshotDate,
      teamCode: r.TeamCode,
      teamName: r.TeamName || r.TeamCode,
      wins: Number(r.Wins) || 0,
      losses: Number(r.Losses) || 0,
      moneyValue: Number(r.MoneyValue) || 0,
      homeWins: Number(r.HomeWins) || 0,
      homeLosses: Number(r.HomeLosses) || 0,
      homeMoneyValue: Number(r.HomeMoneyValue) || 0,
      awayWins: Number(r.AwayWins) || 0,
      awayLosses: Number(r.AwayLosses) || 0,
      awayMoneyValue: Number(r.AwayMoneyValue) || 0,
      runLineWins: Number(r.RunLineWins) || 0,
      runLineLosses: Number(r.RunLineLosses) || 0,
      runLineMoney: Number(r.RunLineMoney) || 0,
      overUnderWins: Number(r.OverUnderWins) || 0,
      overUnderLosses: Number(r.OverUnderLosses) || 0,
      hittingAvg: Number(r.HittingAvg) || 0,
      hittingOps: Number(r.HittingOps) || 0,
      pitchingEra: Number(r.PitchingEra) || 0,
      bullpenEra: Number(r.BullpenEra) || 0
    }));

    res.json({
      success: true,
      snapshotDate: formattedRows.length > 0 ? formattedRows[0].snapshotDate : null,
      count: formattedRows.length,
      data: formattedRows
    });
  } catch (err: any) {
    logger.error({ msg: "Covers stats fetch failed", error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
