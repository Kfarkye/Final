// src/routes/artifacts.routes.ts
// Deliverable 2: GET /artifacts/:slug — SSR, indexable by construction
// Deliverable 3: GET /sitemap.xml — durable, unlimited index backstop
import { Router, Request, Response, NextFunction } from "express";
import { Storage } from "@google-cloud/storage";
import { OAuth2Client, LoginTicket } from "google-auth-library";
import { edgeDb } from "../db/spanner";
import { logger } from "../utils/logger";

const router = Router();
const storage = new Storage();
const iapClient = new OAuth2Client();
const IAP_ISSUERS = ["https://cloud.google.com/iap"];
const ARTIFACTS_HOST_SUFFIX = (process.env.ARTIFACTS_HOST_SUFFIX || "").trim().toLowerCase();
const ARTIFACTS_IAP_AUDIENCE = (process.env.ARTIFACTS_IAP_AUDIENCE || "").trim();
const ARTIFACTS_REQUIRE_IAP = String(process.env.ARTIFACTS_REQUIRE_IAP || "false").toLowerCase() === "true";
const DOMAIN = (process.env.ARTIFACTS_PUBLIC_BASE_URL || "https://mcptruth.com").trim();

// ─── Deliverable 2: GET /artifacts/:slug ───────────────────────────────────
router.get("/artifacts/:slug", async (req: Request, res: Response) => {
  const { slug } = req.params;
  try {
    await serveArtifactBySlug(req, res, slug, "path");
  } catch (err: any) {
    logger.error({ err, slug }, "Failed to serve artifact");
    res.status(500).send("Internal Server Error");
  }
});

// ─── Artifact wildcard host: https://{slug}.{ARTIFACTS_HOST_SUFFIX} ─────────
router.get("*", async (req: Request, res: Response, next: NextFunction) => {
  const host = extractRequestHost(req);
  const slug = extractArtifactSlugFromHost(host);
  if (!slug) {
    next();
    return;
  }

  try {
    await serveArtifactBySlug(req, res, slug, "host");
  } catch (err: any) {
    logger.error({ err, slug, host }, "Failed to serve wildcard-host artifact");
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

type ArtifactRow = {
  Id: string;
  Slug: string;
  TenantId: string;
  Visibility: string;
  GcsPath: string;
  Title: string | null;
  Description: string | null;
};

async function serveArtifactBySlug(
  req: Request,
  res: Response,
  slug: string,
  routeMode: "path" | "host",
): Promise<void> {
  const [rows] = await edgeDb.run({
    sql: `SELECT Id, Slug, TenantId, Visibility, GcsPath, Title, Description
          FROM Artifacts WHERE Slug = @slug LIMIT 1`,
    params: { slug },
  });

  if (rows.length === 0) {
    res.status(404).send(notFoundPage());
    return;
  }

  const artifact = rows[0].toJSON() as ArtifactRow;
  const iapTicket = routeMode === "host" ? await verifyIapAssertion(req) : null;

  if (routeMode === "host" && ARTIFACTS_REQUIRE_IAP && !iapTicket) {
    logger.warn({ slug, host: extractRequestHost(req) }, "Artifact host request blocked: missing or invalid IAP assertion");
    res.status(404).send(notFoundPage());
    return;
  }

  if (artifact.Visibility === "private") {
    if (routeMode === "host") {
      if (!iapTicket) {
        res.status(404).send(notFoundPage());
        return;
      }
    } else {
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith("Bearer ")) {
        res.status(404).send(notFoundPage());
        return;
      }

      try {
        const token = authHeader.slice(7);
        const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
        if (payload.tenant_id !== artifact.TenantId && payload.tenantId !== artifact.TenantId) {
          res.status(404).send(notFoundPage());
          return;
        }
      } catch {
        res.status(404).send(notFoundPage());
        return;
      }
    }
  }

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
}

function extractRequestHost(req: Request): string {
  const xForwardedHost = req.headers["x-forwarded-host"];
  const rawHost = Array.isArray(xForwardedHost)
    ? xForwardedHost[0]
    : xForwardedHost || req.headers.host || "";
  return String(rawHost)
    .split(",")[0]
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, "");
}

function extractArtifactSlugFromHost(host: string): string | null {
  if (!ARTIFACTS_HOST_SUFFIX) return null;
  const expectedSuffix = `.${ARTIFACTS_HOST_SUFFIX}`;
  if (!host.endsWith(expectedSuffix)) return null;
  const slug = host.slice(0, -expectedSuffix.length);
  if (!slug || slug.includes(".") || slug.includes("/")) return null;
  return slug;
}

async function verifyIapAssertion(req: Request): Promise<LoginTicket | null> {
  const assertion = req.header("x-goog-iap-jwt-assertion");
  if (!assertion) return null;
  if (!ARTIFACTS_IAP_AUDIENCE) {
    logger.warn("ARTIFACTS_IAP_AUDIENCE is not set; IAP assertion cannot be verified");
    return null;
  }

  try {
    const certs = await iapClient.getIapPublicKeys();
    return await iapClient.verifySignedJwtWithCertsAsync(
      assertion,
      certs.pubkeys,
      ARTIFACTS_IAP_AUDIENCE,
      IAP_ISSUERS,
    );
  } catch (err: any) {
    logger.warn({ err: err?.message }, "Failed to verify IAP assertion");
    return null;
  }
}

export default router;
