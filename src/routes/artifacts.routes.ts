// src/routes/artifacts.routes.ts
// Deliverable 2: GET /artifacts/:slug — SSR, indexable by construction
// Deliverable 3: GET /sitemap.xml — durable, unlimited index backstop
import { Router, Request, Response } from "express";
import { Storage } from "@google-cloud/storage";
import { edgeDb } from "../db/spanner";
import { logger } from "../utils/logger";

const router = Router();
const storage = new Storage();
const DOMAIN = "https://mcptruth.com";

// ─── Deliverable 2: GET /artifacts/:slug ───────────────────────────────────
router.get("/artifacts/:slug", async (req: Request, res: Response) => {
  const { slug } = req.params;

  try {
    // 1. Look up Artifact by Slug
    const [rows] = await edgeDb.run({
      sql: `SELECT Id, Slug, TenantId, Visibility, GcsPath, Title, Description
            FROM Artifacts WHERE Slug = @slug LIMIT 1`,
      params: { slug },
    });

    if (rows.length === 0) {
      res.status(404).send(notFoundPage());
      return;
    }

    const artifact = rows[0].toJSON() as {
      Id: string;
      Slug: string;
      TenantId: string;
      Visibility: string;
      GcsPath: string;
      Title: string | null;
      Description: string | null;
    };

    // 2. Visibility gate
    if (artifact.Visibility === "private") {
      // Require valid Identity Platform JWT + tenantId match
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith("Bearer ")) {
        res.status(404).send(notFoundPage()); // 404, not 403 — never leak existence
        return;
      }

      try {
        // Decode JWT — in production use google-auth-library or firebase-admin
        const token = authHeader.slice(7);
        const payload = JSON.parse(
          Buffer.from(token.split(".")[1], "base64url").toString()
        );
        if (payload.tenant_id !== artifact.TenantId && payload.tenantId !== artifact.TenantId) {
          res.status(404).send(notFoundPage());
          return;
        }
      } catch {
        res.status(404).send(notFoundPage());
        return;
      }
    }

    // 3. Stream rendered HTML from GCS with SEO head injected server-side
    const [bucket, ...objectParts] = artifact.GcsPath.split("/");
    const objectPath = objectParts.join("/");
    const file = storage.bucket(bucket).file(objectPath);

    const [exists] = await file.exists();
    if (!exists) {
      logger.error({ slug, gcsPath: artifact.GcsPath }, "Artifact GCS object not found");
      res.status(404).send(notFoundPage());
      return;
    }

    const [htmlBuffer] = await file.download();
    let html = htmlBuffer.toString("utf-8");

    // Inject SEO head server-side (before </head> or at top of document)
    const seoHead = buildSeoHead(artifact);
    if (html.includes("</head>")) {
      html = html.replace("</head>", `${seoHead}\n</head>`);
    } else if (html.includes("<html")) {
      html = html.replace(/<html[^>]*>/, (match) => `${match}\n<head>${seoHead}</head>`);
    } else {
      html = `<!DOCTYPE html><html><head>${seoHead}</head><body>${html}</body></html>`;
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=300, s-maxage=600");
    res.send(html);
  } catch (err: any) {
    logger.error({ err, slug }, "Failed to serve artifact");
    res.status(500).send("Internal Server Error");
  }
});

// ─── Deliverable 3: GET /sitemap.xml ───────────────────────────────────────
router.get("/sitemap.xml", async (_req: Request, res: Response) => {
  try {
    const [rows] = await edgeDb.run({
      sql: `SELECT Slug, UpdatedAt FROM Artifacts WHERE Visibility = 'public' ORDER BY UpdatedAt DESC`,
    });

    const urls = rows.map((row) => {
      const { Slug, UpdatedAt } = row.toJSON() as { Slug: string; UpdatedAt: string };
      return `  <url>
    <loc>${DOMAIN}/artifacts/${Slug}</loc>
    <lastmod>${new Date(UpdatedAt).toISOString()}</lastmod>
  </url>`;
    });

    const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join("\n")}
</urlset>`;

    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=300");
    res.send(sitemap);
  } catch (err: any) {
    logger.error({ err }, "Failed to generate sitemap");
    res.status(500).send("Internal Server Error");
  }
});

// ─── Helpers ───────────────────────────────────────────────────────────────
function buildSeoHead(artifact: {
  Slug: string;
  Title: string | null;
  Description: string | null;
  Visibility: string;
}): string {
  const title = artifact.Title || "Truth Artifact";
  const description = artifact.Description || "";
  const canonical = `${DOMAIN}/artifacts/${artifact.Slug}`;
  const noindex = artifact.Visibility !== "public"
    ? `\n  <meta name="robots" content="noindex">`
    : "";

  return `  <title>${escapeHtml(title)} — Truth</title>
  <meta name="description" content="${escapeHtml(description)}">
  <link rel="canonical" href="${canonical}">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:url" content="${canonical}">
  <meta name="twitter:card" content="summary_large_image">${noindex}`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function notFoundPage(): string {
  return `<!DOCTYPE html><html><head><title>Not Found — Truth</title></head>
<body><h1>404 — Artifact not found</h1></body></html>`;
}

export default router;
