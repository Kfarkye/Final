// lib/artifact-indexing.ts
// Deliverable 4: Generator tail — 4 API calls on every artifact
// 1. Cloud Storage → write HTML → set GcsPath
// 2. Spanner → upsert Artifact row
// 3. Indexing API → nudge Google (best-effort, public only)
// 4. URL Inspection API → verify indexed status (async, public only)
import { Storage } from "@google-cloud/storage";
import { GoogleAuth } from "google-auth-library";
import { edgeDb } from "../src/db/spanner";
import { logger } from "../src/utils/logger";
import { v4 as uuid } from "uuid";

const storage = new Storage();
const ARTIFACT_BUCKET = "clearspace-artifacts";
const ARTIFACT_PREFIX = "truth-artifacts";
const DOMAIN = "https://mcptruth.com";

const auth = new GoogleAuth({
  scopes: [
    "https://www.googleapis.com/auth/indexing",
    "https://www.googleapis.com/auth/webmasters",
  ],
});

export interface ArtifactInput {
  slug: string;
  tenantId: string;
  visibility: "public" | "unlisted" | "private";
  title: string;
  description: string;
  html: string;
}

/**
 * The 4-call generator tail. Call this after the crawler produces HTML.
 * Steps:
 *   1. Write HTML to GCS
 *   2. Upsert Artifact row in Spanner
 *   3. If public: Indexing API nudge (best-effort)
 *   4. If public: URL Inspection API verify (async)
 */
export async function publishArtifact(input: ArtifactInput): Promise<{
  id: string;
  slug: string;
  gcsPath: string;
  indexStatus: string;
}> {
  const id = uuid();
  const objectName = `${ARTIFACT_PREFIX}/${input.slug}.html`;
  const gcsPath = `${ARTIFACT_BUCKET}/${objectName}`;

  // ── Step 1: Cloud Storage → write HTML ──
  const file = storage.bucket(ARTIFACT_BUCKET).file(objectName);
  await file.save(input.html, {
    contentType: "text/html; charset=utf-8",
    metadata: {
      cacheControl: "public, max-age=300",
    },
  });
  logger.info({ slug: input.slug, gcsPath }, "Artifact HTML written to GCS");

  // ── Step 2: Spanner → upsert Artifact row ──
  await edgeDb.table("Artifacts").upsert([
    {
      Id: id,
      Slug: input.slug,
      TenantId: input.tenantId,
      Visibility: input.visibility,
      GcsPath: gcsPath,
      Title: input.title,
      Description: input.description,
      IndexStatus: "PENDING",
      IndexVerdict: null,
      LastInspected: null,
      CreatedAt: "spanner.commit_timestamp()",
      UpdatedAt: "spanner.commit_timestamp()",
    },
  ]);
  logger.info({ id, slug: input.slug }, "Artifact row upserted in Spanner");

  let indexStatus = "PENDING";

  // ── Steps 3 & 4: Only for public artifacts ──
  if (input.visibility === "public") {
    // Step 3: Indexing API → nudge Google (best-effort)
    indexStatus = await nudgeIndexingApi(input.slug);

    // Step 4: URL Inspection API → verify (fire-and-forget, check later)
    // Delay inspection — Google needs time to crawl after the nudge
    setTimeout(() => {
      inspectUrl(input.slug, id).catch((err) =>
        logger.error({ err, slug: input.slug }, "URL Inspection failed (async)")
      );
    }, 60_000); // 1 minute delay
  }

  return { id, slug: input.slug, gcsPath, indexStatus };
}

/**
 * Step 3: Indexing API — POST urlNotifications:publish
 * Best-effort nudge. Treat quota/type limits as non-fatal.
 */
async function nudgeIndexingApi(slug: string): Promise<string> {
  const url = `${DOMAIN}/artifacts/${slug}`;
  try {
    const client = await auth.getClient();
    const res = await client.request({
      url: "https://indexing.googleapis.com/v3/urlNotifications:publish",
      method: "POST",
      data: { url, type: "URL_UPDATED" },
    });

    logger.info({ slug, status: (res as any).status }, "Indexing API nudge sent");
    return "SUBMITTED";
  } catch (err: any) {
    // Non-fatal — sitemap is the authoritative coverage mechanism
    logger.warn({ err: err.message, slug }, "Indexing API nudge failed (best-effort)");
    return "PENDING";
  }
}

/**
 * Step 4: URL Inspection API — POST urlInspection/index:inspect
 * Closes the womb→indexed loop programmatically.
 */
async function inspectUrl(slug: string, artifactId: string): Promise<void> {
  const inspectionUrl = `${DOMAIN}/artifacts/${slug}`;
  try {
    const client = await auth.getClient();
    const res = await client.request({
      url: "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect",
      method: "POST",
      data: {
        inspectionUrl,
        siteUrl: `${DOMAIN}/`,
      },
    });

    const result = (res as any).data?.inspectionResult?.indexStatusResult;
    const verdict = result?.verdict || "NEUTRAL";
    const coverageState = result?.coverageState || "UNKNOWN";

    // Map verdict to IndexStatus
    let indexStatus: string;
    switch (verdict) {
      case "PASS":
        indexStatus = "INDEXED";
        break;
      case "FAIL":
        indexStatus = "NOT_INDEXED";
        break;
      default:
        indexStatus = "PENDING";
    }

    // Update Spanner with inspection results
    await edgeDb.table("Artifacts").update([
      {
        Id: artifactId,
        IndexStatus: indexStatus,
        IndexVerdict: verdict,
        LastInspected: "spanner.commit_timestamp()",
        UpdatedAt: "spanner.commit_timestamp()",
      },
    ]);

    logger.info(
      { slug, verdict, coverageState, indexStatus },
      "URL Inspection completed — loop closed"
    );
  } catch (err: any) {
    // Update status to ERROR
    await edgeDb.table("Artifacts").update([
      {
        Id: artifactId,
        IndexStatus: "ERROR",
        IndexVerdict: err.message?.slice(0, 32) || "UNKNOWN_ERROR",
        LastInspected: "spanner.commit_timestamp()",
        UpdatedAt: "spanner.commit_timestamp()",
      },
    ]);

    logger.error({ err: err.message, slug }, "URL Inspection API failed");
  }
}
