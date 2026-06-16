import { env } from "./src/config/env";

import express from "express";
import http from "http";
import path from "path";
import fs from "fs";
import { createHttpTerminator } from "http-terminator";

// Controllers & Services
import { auditController, AuditPayloadSchema } from "./src/controllers/audit.controller";
import { chatController } from "./src/controllers/chat.controller";
import { healthController } from "./src/controllers/health.controller";
import { gitController } from "./src/controllers/git.controller";
import stripeMcpRoutes from "./src/routes/stripeMcpRoutes";
import linearMcpRoutes from "./src/routes/linearMcpRoutes";
import notebookMcpRoutes from "./src/routes/notebookMcpRoutes";
import spannerMcpRoutes from "./src/routes/spannerMcpRoutes";

// Middleware & Managers
import { chatRateLimiter, validateChatPayload } from './lib/middleware/chat-security';
import { sseManager } from './lib/sse/sse-manager';
import { validateRequest } from "./src/middleware/validate";
import { globalErrorHandler, notFoundHandler } from "./src/middleware/errorHandler";
import { requestTracing } from "./src/middleware/tracing";
import { logger } from "./src/utils/logger";
import { closeDatabase } from "./src/db/index";
import { handleApproval } from "./src/utils/approval";
import { startBackfill, stopBackfill, getBackfillStatus, getTeamNickname } from "./src/workers/odds-backfill-worker";
import { fetchEspnScoreboard } from "./src/lib/espn-grounding";
import { Spanner } from "@google-cloud/spanner";
import { EdgeEngine, assertLiveEdgeSource, assertNoPlaceholderLeak, EdgeCard } from "./src/services/edge-engine";

const app = express();
const PORT = env.PORT;

// Mount request tracing immediately so all subsequent logs are traced
app.use(requestTracing);
app.use(express.json({ limit: "10mb" }));

// --- DevOps Probes ---
app.get("/healthz", healthController.liveness);
app.get("/readyz", healthController.readiness);

// --- API Routes ---
app.post("/api/audit", validateRequest(AuditPayloadSchema), auditController.createAuditLog);
app.get("/api/audit", auditController.getAuditLogs);
app.post("/api/truth/chat", chatRateLimiter, validateChatPayload, chatController.handleChat);

// --- Multi-Service MCP Routes ---
app.use("/api/mcp/stripe", stripeMcpRoutes);
app.use("/api/mcp/linear", linearMcpRoutes);
app.use("/api/mcp/notebook", notebookMcpRoutes);
app.use("/api/mcp/spanner", spannerMcpRoutes);

// --- Model Registry API + MCP ---
import modelRegistryRoutes from "./src/routes/modelRegistryRoutes";
import modelRegistryMcpRoutes from "./src/routes/modelRegistryMcpRoutes";
app.use("/api/models", modelRegistryRoutes);
app.use("/api/mcp/model-registry", modelRegistryMcpRoutes);

// --- Debug: list all registered tools ---
import { toolRegistry } from './src/tools';
app.get("/api/debug/tools", (_req, res) => {
  const schemas = toolRegistry.getSchemas();
  const toolDetails = Object.entries(schemas).map(([name, schema]: [string, any]) => ({
    name,
    description: schema.description || '',
  }));
  res.json({ registeredTools: Object.keys(schemas), count: Object.keys(schemas).length, tools: toolDetails });
});

// --- Live System Status API (consumed by HTML5 artifacts) ---
const SERVER_START_TIME = Date.now();

app.get("/api/system/status", (_req, res) => {
  const mem = process.memoryUsage();
  const schemas = toolRegistry.getSchemas();
  res.json({
    status: "healthy",
    uptime: Math.floor((Date.now() - SERVER_START_TIME) / 1000),
    uptimeFormatted: formatUptime(Date.now() - SERVER_START_TIME),
    memory: {
      heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
      rssMB: Math.round(mem.rss / 1024 / 1024),
    },
    tools: {
      count: Object.keys(schemas).length,
      names: Object.keys(schemas),
    },
    workers: {
      oddsBackfill: getBackfillStatus(),
    },
    node: process.version,
    platform: process.platform,
    env: env.NODE_ENV,
    region: "us-central1",
    service: "reverie",
    timestamp: new Date().toISOString(),
  });
});

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}

// --- HTML5 Artifact Serving ---
import { callGcpMcpTool } from './src/tools/gcp-mcp-client';
const ARTIFACT_BUCKET = "clearspace-artifacts";
const ARTIFACT_PREFIX = "truth-artifacts";
const STORAGE_MCP_URL = "https://storage.googleapis.com/storage/mcp";

app.get("/api/artifacts/:id", async (req, res) => {
  try {
    const objectName = `${ARTIFACT_PREFIX}/${req.params.id}.html`;
    const result = await callGcpMcpTool(STORAGE_MCP_URL, "read_text", {
      bucketName: ARTIFACT_BUCKET,
      objectName
    });
    const html = typeof result === "string" ? result : (result?.content || result?.text || "");
    if (!html) {
      res.status(404).json({ error: "Artifact not found" });
      return;
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=60");
    res.send(html);
  } catch (err: any) {
    res.status(500).json({ error: `Failed to serve artifact: ${err.message}` });
  }
});

app.get("/api/artifacts", async (_req, res) => {
  try {
    const result = await callGcpMcpTool(STORAGE_MCP_URL, "list_objects", {
      bucketName: ARTIFACT_BUCKET,
      prefix: `${ARTIFACT_PREFIX}/`
    });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: `Failed to list artifacts: ${err.message}` });
  }
});

// --- Serverless Deploy (user-facing button) ---
app.post("/api/deploy-html", async (req, res) => {
  try {
    const { html, title } = req.body;
    if (!html || typeof html !== "string") {
      res.status(400).json({ error: "html field is required." });
      return;
    }
    if (html.length > 2 * 1024 * 1024) {
      res.status(413).json({ error: "HTML content exceeds 2MB limit." });
      return;
    }

    const cleanTitle = (title || "artifact")
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 60);
    const timestamp = Date.now().toString(36);
    const objectName = `${ARTIFACT_PREFIX}/${cleanTitle}-${timestamp}.html`;

    await callGcpMcpTool(STORAGE_MCP_URL, "write_text", {
      bucketName: ARTIFACT_BUCKET,
      objectName,
      textContent: html,
      contentType: "text/html; charset=utf-8"
    });

    const publicUrl = `https://storage.googleapis.com/${ARTIFACT_BUCKET}/${encodeURIComponent(objectName)}`;
    
    // HEAD request verification
    let verified = false;
    try {
      const headRes = await fetch(publicUrl, { method: "HEAD" });
      const contentType = headRes.headers.get("content-type") || "";
      if (contentType.toLowerCase().startsWith("text/html")) {
        verified = true;
      }
    } catch (err: any) {
      logger.error({ msg: "HEAD verification failed in deploy-html endpoint", err: err.message, publicUrl });
    }

    if (!verified) {
      res.status(500).json({ error: "Deploy verification failed: served object content-type is not text/html." });
      return;
    }

    logger.info({ msg: "HTML artifact deployed", objectName, publicUrl });
    res.json({ url: publicUrl, objectName, verified: true });
  } catch (err: any) {
    logger.error({ msg: "Deploy failed", err: err.message });
    res.status(500).json({ error: `Deploy failed: ${err.message}` });
  }
});

// --- Git Workspace Routes ---
app.post("/api/git/provision", gitController.provisionWorkspace);
app.get("/api/git/tree", gitController.getFileTree);
app.get("/api/git/file", gitController.getFileContent);
app.get("/api/git/status", gitController.getGitStatus);
app.get("/api/git/commits", gitController.getGitCommits);
app.get("/api/git/diff", gitController.getFileDiff);
app.get("/api/git/branches", gitController.getBranches);

// --- MCP human UX approval route ---
app.post("/api/mcp/approve", (req, res) => {
  const { approvalId, approved } = req.body;
  if (!approvalId) {
    res.status(400).json({ error: "approvalId is required" });
    return;
  }
  const handled = handleApproval(approvalId, !!approved);
  if (handled) {
    res.json({ success: true });
  } else {
    res.status(404).json({ error: "Approval request not found or expired." });
  }
});

// --- Background Workers API ---
app.post("/api/workers/odds-backfill", (req, res) => {
  const result = startBackfill(req.body || {});
  res.json(result);
});

app.delete("/api/workers/odds-backfill", (_req, res) => {
  const result = stopBackfill();
  res.json(result);
});

app.get("/api/workers/odds-backfill", (_req, res) => {
  res.json(getBackfillStatus());
});

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

app.get("/api/mlb/slate", async (req, res) => {
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

const spannerClient = new Spanner({ projectId: env.SPANNER_PROJECT_ID });
const edgeDb = spannerClient.instance("clearspace").database("sports-mlb-db");

app.get("/api/edge/board", async (req, res) => {
  try {
    const dateQuery = req.query.date as string | undefined;
    const formattedDate = dateQuery || new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());

    const [rows] = await edgeDb.run({
      sql: `
        SELECT g.EventId, g.HomeTeamName, g.AwayTeamName, g.StartTime,
               e.CompositeEdge, e.EdgeSide, e.Confidence, e.StateJson
        FROM MlbGames g
        LEFT JOIN GameEdgeState e ON g.EventId = e.GamePk
        WHERE g.GameDate = @date
      `,
      params: { date: formattedDate }
    });

    const edges: EdgeCard[] = [];
    const warnings: string[] = [];

    for (const r of rows) {
      const data = r.toJSON();
      const stateJson = data.StateJson || {};
      const gameEdges: EdgeCard[] = stateJson.edges || [];

      for (const edge of gameEdges) {
        try {
          // Critical production rule: assertLiveEdgeSource will throw if simulated and fixtures are not allowed
          assertLiveEdgeSource(edge.sourceMeta);
          assertNoPlaceholderLeak(JSON.stringify(edge));
          edges.push(edge);
        } catch (err: any) {
          logger.warn({ msg: "Edge filtered by board quality gates", edgeId: edge.edgeId, error: err.message });
          warnings.push(`Edge ${edge.edgeId} filtered: ${err.message}`);
        }
      }
    }

    res.json({
      generatedAt: new Date().toISOString(),
      sourceMode: "live",
      sport: "mlb",
      edges,
      warnings: warnings.length > 0 ? warnings : undefined
    });
  } catch (err: any) {
    logger.error({ msg: "Failed to fetch edge board", err: err.message });
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/edge/game/:gamePk", async (req, res) => {
  try {
    const gamePk = req.params.gamePk;

    // Check if the game itself is simulated (e.g. gamePk starts with "test-")
    const isSimulated = gamePk.startsWith("test-");
    const allowFixtures = process.env.NODE_ENV === "test" || process.env.ALLOW_EDGE_FIXTURES === "true";
    if (isSimulated && !allowFixtures) {
      return res.status(403).json({ error: "Access Denied: Simulated games are blocked in production/staging environments." });
    }

    const [edgeRows] = await edgeDb.run({
      sql: `
        SELECT StateJson, ComputedAt
        FROM GameEdgeState
        WHERE GamePk = @gamePk
        ORDER BY ComputedAt DESC
        LIMIT 1
      `,
      params: { gamePk }
    });

    if (edgeRows.length === 0) {
      return res.status(404).json({ error: `No edge state found for game ${gamePk}` });
    }

    const edgeState = edgeRows[0].toJSON();
    const stateJson = edgeState.StateJson || {};

    // Validate using assertLiveEdgeSource
    if (stateJson.sourceMeta) {
      try {
        assertLiveEdgeSource(stateJson.sourceMeta);
      } catch (err: any) {
        return res.status(403).json({ error: `Access Denied: ${err.message}` });
      }
    }

    // Also assert placeholder leaks on the returned payload
    try {
      assertNoPlaceholderLeak(stateJson);
    } catch (err: any) {
      return res.status(422).json({ error: `Validation Error: ${err.message}` });
    }

    const [snapshotRows] = await edgeDb.run({
      sql: `
        SELECT Book, Market, Side, Price, Point, CapturedAt
        FROM OddsSnapshot
        WHERE GamePk = @gamePk
        ORDER BY CapturedAt DESC
        LIMIT 20
      `,
      params: { gamePk }
    });

    res.json({
      gamePk,
      sourceMode: "live",
      computedAt: edgeState.ComputedAt,
      compositeEdge: stateJson.compositeEdge || 0,
      edgeSide: stateJson.edgeSide || "none",
      confidence: stateJson.confidence || "low",
      headline: EdgeEngine.generateHeadline(stateJson),
      indicators: {
        steam: { score: stateJson.steamScore || 0 },
        crossBook: { score: stateJson.crossBookDiverg || 0 },
        sharpLeadLag: { score: stateJson.sharpLeadLag || 0 },
        fairLineGap: stateJson.fairLineResult || {},
        cobb: stateJson.cobbResult || {}
      },
      edges: stateJson.edges || [],
      sourceMeta: stateJson.sourceMeta || [],
      supportingSnapshots: snapshotRows.map((r: any) => r.toJSON())
    });
  } catch (err: any) {
    logger.error({ msg: "Failed to fetch edge details", err: err.message });
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/edge/movement/:gamePk", async (req, res) => {
  try {
    const gamePk = req.params.gamePk;
    const [rows] = await edgeDb.run({
      sql: `
        SELECT Book, IsSharp, Market, Side, Price, Point, CapturedAt
        FROM OddsSnapshot
        WHERE GamePk = @gamePk
        ORDER BY CapturedAt ASC
      `,
      params: { gamePk }
    });

    res.json({
      gamePk,
      movement: rows.map((r: any) => r.toJSON())
    });
  } catch (err: any) {
    logger.error({ msg: "Failed to fetch line movement", err: err.message });
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/pm/quarantine", async (req, res) => {
  try {
    const [rows] = await edgeDb.run({
      sql: `
        SELECT Platform, MarketId, Title, Reason, Detail, CapturedAt
        FROM PmQuarantine
        ORDER BY CapturedAt DESC
        LIMIT 100
      `
    });

    res.json({
      quarantineList: rows.map((r: any) => r.toJSON())
    });
  } catch (err: any) {
    logger.error({ msg: "Failed to fetch quarantine list", err: err.message });
    res.status(500).json({ error: err.message });
  }
});

async function startServer() {
  // Catch-All 404 Route for API (must be mounted before static files/Vite catch-all)
  app.use("/api", notFoundHandler);

  if (env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      // Check if the requested file exists in dist/ (e.g., truth-platform-vision.html)
      const requestedFile = path.join(distPath, req.path);
      if (req.path !== '/' && fs.existsSync(requestedFile) && fs.statSync(requestedFile).isFile()) {
        res.sendFile(requestedFile);
      } else {
        // SPA fallback — serve index.html for all non-file routes
        res.sendFile(path.join(distPath, 'index.html'));
      }
    });
  }

  // Global Error Handler
  app.use(globalErrorHandler);

  // 1. Create the native HTTP server explicitly
  const server = http.createServer(app);

  // 2. Initialize the HTTP Terminator
  const httpTerminator = createHttpTerminator({
    server,
    // Give active requests exactly 15 seconds to finish before forcing sockets closed
    gracefulTerminationTimeout: 15000, 
  });

  server.listen(PORT, "0.0.0.0", () => {
    logger.info({ msg: "Server started successfully", port: PORT, env: env.NODE_ENV });
  });

  // 3. The Graceful Shutdown Orchestrator
  const shutdown = async (signal: string) => {
    logger.info({ msg: `[${signal}] Initiating graceful shutdown sequence...` });

    try {
      // Step A: Stop accepting new TCP connections and wait for active requests to finish
      await httpTerminator.terminate();
      logger.info({ msg: "HTTP server closed, all active requests finished safely." });

      // Step B: Stop background workers
      stopBackfill();
      logger.info({ msg: "Background workers stopped." });

      // Step C: Flush Server-Sent Events (SSE) connections explicitly
      if (sseManager && typeof sseManager.shutdown === 'function') {
        sseManager.shutdown();
        logger.info({ msg: "SSE connections flushed and terminated." });
      }

      // Step C: Safely drain and disconnect the database pool
      await closeDatabase();
      await spannerClient.close();

      logger.info({ msg: "Graceful shutdown complete. Exiting process safely." });
      process.exit(0);
    } catch (err: any) {
      logger.error({ msg: "Fatal error during shutdown sequence", err: err.message });
      process.exit(1);
    }
  };

  // 4. Bind listeners to standard OS termination signals
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT",  () => shutdown("SIGINT"));
  
  process.on("uncaughtException", (err) => {
    logger.fatal({ msg: "Uncaught Exception", err });
    shutdown("uncaughtException");
  });
  
  process.on("unhandledRejection", (reason) => {
    logger.fatal({ msg: "Unhandled Rejection", reason });
    shutdown("unhandledRejection");
  });
}

startServer();
