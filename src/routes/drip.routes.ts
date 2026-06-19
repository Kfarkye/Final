/**
 * THE DRIP — Route Handler
 * 
 * Serves The Drip pages from the thedrip/ directory.
 * Separate from Truth's artifact renderer (/api/artifacts/).
 * 
 * Pages are static HTML files that link to /drip.css.
 * Data comes from Spanner — pages are either:
 *   1. Pre-rendered (HTML written by the app with real data baked in)
 *   2. Template (static shell, data loaded client-side via fetch)
 */

import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { logger } from "../utils/logger";
import { edgeDb } from "../db/spanner";

const router = Router();

const DRIP_DIR = path.join(process.cwd(), "thedrip");

/**
 * Serve a Drip page by file name.
 * Returns 404 with a styled page if the file doesn't exist yet.
 */
function serveDripPage(fileName: string) {
  return (_req: Request, res: Response) => {
    const filePath = path.join(DRIP_DIR, fileName);

    if (!fs.existsSync(filePath)) {
      res.status(404).send(buildPlaceholderPage(fileName));
      return;
    }

    try {
      const html = fs.readFileSync(filePath, "utf-8");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "public, max-age=30");
      res.send(html);
    } catch (err: any) {
      logger.error({ msg: "Failed to serve Drip page", file: fileName, err: err.message });
      res.status(500).send("Internal Server Error");
    }
  };
}

/**
 * Styled 404 placeholder in The Drip design language
 */
function buildPlaceholderPage(fileName: string): string {
  const pageName = fileName.replace(".html", "").replace(/-/g, " ");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Coming Soon | The Drip</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/drip.css">
</head>
<body>
<header class="drip-header">
  <nav class="drip-nav">
    <div class="drip-nav-left">
      <a href="/" class="drip-wordmark">The Drip</a>
      <div class="drip-nav-links">
        <a href="/" class="drip-nav-link">World Cup 2026</a>
        <a href="/mlb/" class="drip-nav-link">MLB</a>
      </div>
    </div>
  </nav>
</header>
<div style="max-width:1060px;margin:0 auto;padding:120px 20px;text-align:center">
  <h1 style="font-family:var(--serif);font-size:2rem;font-weight:700;letter-spacing:-0.03em;margin-bottom:12px">Coming Soon</h1>
  <p style="font-size:1rem;color:var(--text-secondary)">The <strong>${pageName}</strong> page is being built.</p>
  <a href="/" style="display:inline-block;margin-top:24px;font-size:.875rem;font-weight:600;color:var(--accent);text-decoration:none">← Back to World Cup</a>
</div>
<footer class="drip-footer"><p>The Drip — Sports intelligence, not noise.</p></footer>
</body>
</html>`;
}

// ── Static assets ──
router.get("/drip.css", (_req: Request, res: Response) => {
  const cssPath = path.join(DRIP_DIR, "drip.css");
  if (!fs.existsSync(cssPath)) {
    res.status(404).send("/* drip.css not found */");
    return;
  }
  res.setHeader("Content-Type", "text/css; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.send(fs.readFileSync(cssPath, "utf-8"));
});

// ── Page Routes ──
// Groups Overview (home)
router.get("/", serveDripPage("index.html"));

// Group Detail (A–L)
router.get("/group/:letter/", (req: Request, res: Response) => {
  // For now serve a single template — in future, render per-group
  serveDripPage("group-detail.html")(req, res);
});

// Match Detail
router.get("/match/:id/", (req: Request, res: Response) => {
  serveDripPage("match-detail.html")(req, res);
});

// Team Profile
router.get("/team/:code/", (req: Request, res: Response) => {
  serveDripPage("team-profile.html")(req, res);
});

// Today's Matches
router.get("/today/", serveDripPage("today.html"));

// Odds Dashboard
router.get("/odds/", serveDripPage("odds-dashboard.html"));

// MLB Section
router.get("/mlb/", serveDripPage("mlb.html"));

// ── JSON API Routes for Schema Hydration ──

router.get("/api/drip/player/:id", async (req: Request, res: Response) => {
  try {
    const playerId = parseInt(req.params.id, 10);
    if (isNaN(playerId)) {
      res.status(400).json({ error: "Invalid player ID" });
      return;
    }

    // 1. Fetch player from Spanner
    const [rows] = await edgeDb.run({
      sql: `SELECT * FROM MlbPlayerProfile WHERE PlayerId = @playerId`,
      params: { playerId }
    });

    if (!rows || rows.length === 0) {
      res.status(404).json({ error: "Player not found" });
      return;
    }

    const playerRow = rows[0].toJSON();
    const playerData = {
      id: playerRow.PlayerId,
      fullName: playerRow.FullName,
      teamCode: playerRow.TeamCode,
      position: playerRow.Position,
      bats: playerRow.Bats,
      throws: playerRow.Throws,
      height: playerRow.Height,
      weight: playerRow.Weight,
      age: playerRow.Age,
      seasonStats: playerRow.SeasonStatsJson ? JSON.parse(playerRow.SeasonStatsJson) : null
    };

    // 2. Load schema
    const schemaPath = path.join(DRIP_DIR, "player-page-schema.json");
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));

    // 3. Return both so client Renderer can hydrate
    res.json({
      schema,
      data: {
        player: playerData,
        date: new Date().toISOString()
      }
    });

  } catch (err: any) {
    logger.error({ msg: "Failed to fetch player API", err: err.message });
    res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/api/drip/team/:code", async (req: Request, res: Response) => {
  try {
    const teamCode = req.params.code.toUpperCase();

    // 1. Fetch team from Spanner
    const [rows] = await edgeDb.run({
      sql: `SELECT * FROM MlbTeamProfile WHERE TeamCode = @teamCode`,
      params: { teamCode }
    });

    if (!rows || rows.length === 0) {
      res.status(404).json({ error: "Team not found" });
      return;
    }

    const teamRow = rows[0].toJSON();
    const teamData = {
      id: teamRow.TeamId,
      code: teamRow.TeamCode,
      name: teamRow.FullName,
      shortName: teamRow.ShortName,
      location: teamRow.LocationName,
      venue: teamRow.VenueName,
      divisionId: teamRow.DivisionId
    };

    // 2. Load schema
    const schemaPath = path.join(DRIP_DIR, "team-page-schema.json");
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));

    // 3. Return both
    res.json({
      schema,
      data: {
        team: teamData,
        date: new Date().toISOString()
      }
    });

  } catch (err: any) {
    logger.error({ msg: "Failed to fetch team API", err: err.message });
    res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
