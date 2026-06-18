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

const router = Router();

const getDirname = () => {
  try {
    return __dirname;
  } catch {
    return path.dirname(fileURLToPath(import.meta.url));
  }
};

const DRIP_DIR = path.join(getDirname(), "..", "..", "thedrip");

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

export default router;
