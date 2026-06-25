/**
 * entity-resolver.ts — Vector-powered sports entity resolution.
 *
 * Three-tier resolution pipeline:
 *   1. EXACT MATCH    — O(1) index lookup on AliasLower. Handles "Judge", "NYY", "LeBron James".
 *   2. FUZZY MATCH    — LIKE '%query%' with confidence ranking. Handles "LeBro", "Yank".
 *   3. VECTOR SEARCH  — APPROX_COSINE_DISTANCE on text-embedding-004 embeddings.
 *                        Handles "King James", "the greek freak", "bombs" (≈ home runs).
 *
 * Resolution result always includes the canonical name, ID, sport, and entity type
 * so the Oracle Engine can route to the right database and build correct SQL.
 */

import { Spanner } from "@google-cloud/spanner";
import { logger } from "../utils/logger";
import { env } from "../config/env";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ResolvedEntity {
  canonicalId: string;
  canonicalName: string;
  entityType: "player" | "team" | "stat" | "venue";
  sport: "mlb" | "nba" | "nfl" | "nhl" | "soccer";
  confidence: number;
  matchMethod: "exact" | "fuzzy" | "vector";
  alias: string;        // The original user input that matched
  aliasSource?: string;  // 'nickname' | 'abbreviation' | 'slang' | 'typo'
}

export interface ResolvedStat {
  canonicalColumn: string;
  canonicalLabel: string;
  tableName?: string;
  isAggregatable: boolean;
  sport: string;
  matchMethod: "exact" | "fuzzy";
}

export interface ResolutionResult {
  entities: ResolvedEntity[];
  stats: ResolvedStat[];
  detectedSport: string | null;
  unresolvedTerms: string[];
}

// ── Config ───────────────────────────────────────────────────────────────────

const ENTITIES_DATABASE = "sports-entities-db";
const VECTOR_DIMENSION = 768; // text-embedding-004
const VECTOR_NUM_LEAVES_TO_SEARCH = 50; // More = better recall, slower
const FUZZY_LIMIT = 5;
const VECTOR_LIMIT = 5;
const MIN_VECTOR_CONFIDENCE = 0.65; // Below this, vector results are discarded

// ── Singleton Spanner Connection ─────────────────────────────────────────────

let spannerInstance: InstanceType<typeof Spanner> | null = null;

function getDatabase() {
  const projectId = env.SPANNER_PROJECT_ID || env.GCP_PROJECT;
  const instanceId = env.SPANNER_INSTANCE_ID || "clearspace";

  if (!spannerInstance) {
    spannerInstance = new Spanner({ projectId });
  }

  return spannerInstance.instance(instanceId).database(ENTITIES_DATABASE);
}

// ── Tier 1: Exact Match ──────────────────────────────────────────────────────

async function exactMatch(
  query: string,
  sport?: string
): Promise<ResolvedEntity[]> {
  const database = getDatabase();
  const queryLower = query.toLowerCase().trim();

  let sql: string;
  const params: Record<string, any> = { queryLower };

  if (sport) {
    sql = `
      SELECT AliasId, Alias, EntityType, Sport, CanonicalId, CanonicalName, AliasSource, Confidence
      FROM EntityAliases
      WHERE AliasLower = @queryLower AND Sport = @sport
      ORDER BY Confidence DESC
      LIMIT 3
    `;
    params.sport = sport;
  } else {
    sql = `
      SELECT AliasId, Alias, EntityType, Sport, CanonicalId, CanonicalName, AliasSource, Confidence
      FROM EntityAliases
      WHERE AliasLower = @queryLower
      ORDER BY Confidence DESC
      LIMIT 3
    `;
  }

  try {
    const [rows] = await database.run({ sql, params });
    return rows.map((row: any) => {
      const r = row.toJSON();
      return {
        canonicalId: r.CanonicalId,
        canonicalName: r.CanonicalName,
        entityType: r.EntityType as ResolvedEntity["entityType"],
        sport: r.Sport as ResolvedEntity["sport"],
        confidence: parseFloat(r.Confidence) || 1.0,
        matchMethod: "exact" as const,
        alias: r.Alias,
        aliasSource: r.AliasSource,
      };
    });
  } catch (err: any) {
    logger.warn({ msg: "Entity exact match failed", err: err.message, query });
    return [];
  }
}

// ── Tier 2: Fuzzy Match ──────────────────────────────────────────────────────

async function fuzzyMatch(
  query: string,
  sport?: string
): Promise<ResolvedEntity[]> {
  const database = getDatabase();
  const queryLower = `%${query.toLowerCase().trim()}%`;

  let sql: string;
  const params: Record<string, any> = { queryLower };

  if (sport) {
    sql = `
      SELECT AliasId, Alias, EntityType, Sport, CanonicalId, CanonicalName, AliasSource, Confidence
      FROM EntityAliases
      WHERE AliasLower LIKE @queryLower AND Sport = @sport
      ORDER BY Confidence DESC
      LIMIT @limit
    `;
    params.sport = sport;
  } else {
    sql = `
      SELECT AliasId, Alias, EntityType, Sport, CanonicalId, CanonicalName, AliasSource, Confidence
      FROM EntityAliases
      WHERE AliasLower LIKE @queryLower
      ORDER BY Confidence DESC
      LIMIT @limit
    `;
  }
  params.limit = FUZZY_LIMIT;

  try {
    const [rows] = await database.run({ sql, params });
    return rows.map((row: any) => {
      const r = row.toJSON();
      return {
        canonicalId: r.CanonicalId,
        canonicalName: r.CanonicalName,
        entityType: r.EntityType as ResolvedEntity["entityType"],
        sport: r.Sport as ResolvedEntity["sport"],
        confidence: (parseFloat(r.Confidence) || 1.0) * 0.85, // Fuzzy gets a confidence haircut
        matchMethod: "fuzzy" as const,
        alias: r.Alias,
        aliasSource: r.AliasSource,
      };
    });
  } catch (err: any) {
    logger.warn({ msg: "Entity fuzzy match failed", err: err.message, query });
    return [];
  }
}

// ── Tier 3: Vector Search ────────────────────────────────────────────────────

/**
 * Generate an embedding for the query text using Vertex AI's text-embedding-004.
 * Returns a 768-dimensional float array.
 */
async function generateEmbedding(text: string): Promise<number[]> {
  // Use Vertex AI Embeddings API
  const projectId = env.SPANNER_PROJECT_ID || env.GCP_PROJECT;
  const location = "us-central1";
  const model = "text-embedding-004";

  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:predict`;

  // Use ADC (Application Default Credentials) — works on Cloud Run
  const { GoogleAuth } = await import("google-auth-library");
  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  const client = await auth.getClient();

  const response = await client.request({
    url,
    method: "POST",
    data: {
      instances: [{ content: text }],
      parameters: { outputDimensionality: VECTOR_DIMENSION },
    },
  });

  const predictions = (response.data as any).predictions;
  if (!predictions || !predictions[0]?.embeddings?.values) {
    throw new Error("No embedding returned from Vertex AI");
  }

  return predictions[0].embeddings.values;
}

async function vectorSearch(
  query: string,
  sport?: string
): Promise<ResolvedEntity[]> {
  const database = getDatabase();

  try {
    // Step 1: Generate embedding for the user's query
    const embedding = await generateEmbedding(query);

    // Step 2: Build the ANN query
    // APPROX_COSINE_DISTANCE returns distance (0 = identical, 2 = opposite)
    // We convert to confidence: 1 - (distance / 2)
    const embeddingLiteral = `ARRAY<FLOAT32>[${embedding.join(",")}]`;

    let whereClause = "AliasEmbedding IS NOT NULL";
    const params: Record<string, any> = {};
    if (sport) {
      whereClause += " AND Sport = @sport";
      params.sport = sport;
    }

    const sql = `
      SELECT
        AliasId, Alias, EntityType, Sport, CanonicalId, CanonicalName, AliasSource,
        APPROX_COSINE_DISTANCE(AliasEmbedding, ${embeddingLiteral},
          options => JSON '{"num_leaves_to_search": ${VECTOR_NUM_LEAVES_TO_SEARCH}}'
        ) AS Distance
      FROM EntityAliases
      WHERE ${whereClause}
      ORDER BY APPROX_COSINE_DISTANCE(AliasEmbedding, ${embeddingLiteral},
        options => JSON '{"num_leaves_to_search": ${VECTOR_NUM_LEAVES_TO_SEARCH}}'
      )
      LIMIT @limit
    `;
    params.limit = VECTOR_LIMIT;

    const [rows] = await database.run({ sql, params });

    return rows
      .map((row: any) => {
        const r = row.toJSON();
        const distance = parseFloat(r.Distance) || 2.0;
        const confidence = 1 - distance / 2; // Normalize to 0-1

        return {
          canonicalId: r.CanonicalId,
          canonicalName: r.CanonicalName,
          entityType: r.EntityType as ResolvedEntity["entityType"],
          sport: r.Sport as ResolvedEntity["sport"],
          confidence,
          matchMethod: "vector" as const,
          alias: r.Alias,
          aliasSource: r.AliasSource,
        };
      })
      .filter((e) => e.confidence >= MIN_VECTOR_CONFIDENCE); // Drop low-confidence noise
  } catch (err: any) {
    logger.warn({
      msg: "Entity vector search failed (possibly no embeddings seeded yet)",
      err: err.message,
      query,
    });
    return [];
  }
}

// ── Stat Resolution ──────────────────────────────────────────────────────────

async function resolveStatTerm(
  term: string,
  sport?: string
): Promise<ResolvedStat[]> {
  const database = getDatabase();
  const termLower = term.toLowerCase().trim();
  const params: Record<string, any> = { termLower };

  let sql: string;
  if (sport) {
    sql = `
      SELECT AliasLower, CanonicalColumn, CanonicalLabel, TableName, IsAggregatable, Sport
      FROM StatAliases
      WHERE AliasLower = @termLower AND Sport = @sport
      LIMIT 3
    `;
    params.sport = sport;
  } else {
    sql = `
      SELECT AliasLower, CanonicalColumn, CanonicalLabel, TableName, IsAggregatable, Sport
      FROM StatAliases
      WHERE AliasLower = @termLower
      LIMIT 3
    `;
  }

  try {
    const [rows] = await database.run({ sql, params });
    return rows.map((row: any) => {
      const r = row.toJSON();
      return {
        canonicalColumn: r.CanonicalColumn,
        canonicalLabel: r.CanonicalLabel,
        tableName: r.TableName,
        isAggregatable: r.IsAggregatable,
        sport: r.Sport,
        matchMethod: "exact" as const,
      };
    });
  } catch (err: any) {
    logger.warn({ msg: "Stat resolution failed", err: err.message, term });
    return [];
  }
}

// ── Sport Detection ──────────────────────────────────────────────────────────

const SPORT_KEYWORDS: Record<string, string[]> = {
  mlb: [
    "batting", "average", "home run", "homer", "rbi", "era", "strikeout",
    "pitch", "inning", "at-bat", "slugging", "obp", "whip", "base",
    "diamond", "mound", "bullpen", "lineup", "batter", "pitcher",
  ],
  nba: [
    "points", "rebound", "assist", "block", "steal", "triple-double",
    "double-double", "three-pointer", "dunk", "quarter", "free throw",
    "court", "bucket", "paint", "fadeaway", "crossover",
  ],
  nfl: [
    "touchdown", "passing yard", "rushing", "interception", "sack",
    "reception", "fantasy", "quarterback", "wide receiver", "tight end",
    "field goal", "punt", "fumble", "red zone", "end zone",
  ],
};

function detectSportFromText(text: string): string | null {
  const lower = text.toLowerCase();
  const scores: Record<string, number> = { mlb: 0, nba: 0, nfl: 0 };

  for (const [sport, keywords] of Object.entries(SPORT_KEYWORDS)) {
    for (const keyword of keywords) {
      if (lower.includes(keyword)) {
        scores[sport]++;
      }
    }
  }

  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : null;
}

// ── Main Resolution Pipeline ─────────────────────────────────────────────────

/**
 * Resolve a natural-language entity mention to canonical database entities.
 *
 * Pipeline:
 *   1. Try exact match (fastest, most confident)
 *   2. If no exact match, try fuzzy substring match
 *   3. If still nothing, try vector similarity search (handles nicknames, slang)
 *
 * @param query - Raw user text (e.g. "King James", "bombs", "the greek freak")
 * @param sport - Optional sport context to narrow results
 * @returns Array of resolved entities, sorted by confidence
 */
export async function resolveEntity(
  query: string,
  sport?: string
): Promise<ResolvedEntity[]> {
  // Tier 1: Exact
  const exact = await exactMatch(query, sport);
  if (exact.length > 0) {
    logger.info({ msg: "Entity resolved via exact match", query, results: exact.length });
    return exact;
  }

  // Tier 2: Fuzzy
  const fuzzy = await fuzzyMatch(query, sport);
  if (fuzzy.length > 0) {
    logger.info({ msg: "Entity resolved via fuzzy match", query, results: fuzzy.length });
    return fuzzy;
  }

  // Tier 3: Vector
  const vector = await vectorSearch(query, sport);
  if (vector.length > 0) {
    logger.info({ msg: "Entity resolved via vector search", query, results: vector.length });
    return vector;
  }

  logger.info({ msg: "Entity resolution failed — no matches", query, sport });
  return [];
}

/**
 * Full resolution pipeline for a natural-language sports question.
 *
 * Extracts potential entity mentions, resolves each one, detects sport,
 * and resolves any stat-slang terms.
 *
 * @param terms - Array of extracted terms from the NL question
 *                (player names, team names, stat terms, etc.)
 * @param questionText - The full original question for sport detection
 * @returns ResolutionResult with all resolved entities, stats, and detected sport
 */
export async function resolveQuestion(
  terms: string[],
  questionText: string
): Promise<ResolutionResult> {
  // Detect sport from full question text
  const detectedSport = detectSportFromText(questionText);

  const entities: ResolvedEntity[] = [];
  const stats: ResolvedStat[] = [];
  const unresolvedTerms: string[] = [];

  // Resolve each term in parallel
  const resolutions = await Promise.allSettled(
    terms.map(async (term) => {
      // Try entity resolution first
      const entityResults = await resolveEntity(term, detectedSport || undefined);
      if (entityResults.length > 0) {
        return { type: "entity" as const, term, results: entityResults };
      }

      // Try stat resolution
      const statResults = await resolveStatTerm(term, detectedSport || undefined);
      if (statResults.length > 0) {
        return { type: "stat" as const, term, results: statResults };
      }

      return { type: "unresolved" as const, term, results: [] };
    })
  );

  for (const result of resolutions) {
    if (result.status === "rejected") continue;
    const { type, term, results } = result.value;

    if (type === "entity") {
      entities.push(...(results as ResolvedEntity[]));
    } else if (type === "stat") {
      stats.push(...(results as ResolvedStat[]));
    } else {
      unresolvedTerms.push(term);
    }
  }

  // If sport wasn't detected from keywords, infer from resolved entities
  const inferredSport =
    detectedSport ||
    entities[0]?.sport ||
    stats[0]?.sport ||
    null;

  return {
    entities,
    stats,
    detectedSport: inferredSport,
    unresolvedTerms,
  };
}

// ── Seed Data Helper ─────────────────────────────────────────────────────────

/**
 * Insert a batch of entity aliases. Used for initial seeding.
 * Each alias optionally gets an embedding generated via Vertex AI.
 *
 * @param aliases - Array of alias records to insert
 * @param generateEmbeddings - If true, generate embeddings for each alias (slower but enables vector search)
 */
export async function seedEntityAliases(
  aliases: Array<{
    alias: string;
    entityType: ResolvedEntity["entityType"];
    sport: ResolvedEntity["sport"];
    canonicalId: string;
    canonicalName: string;
    aliasSource?: string;
    confidence?: number;
  }>,
  generateEmbeddings = false
): Promise<{ inserted: number; errors: string[] }> {
  const database = getDatabase();
  const errors: string[] = [];
  let inserted = 0;

  // Process in batches of 50 to avoid mutation limits
  const BATCH_SIZE = 50;
  for (let i = 0; i < aliases.length; i += BATCH_SIZE) {
    const batch = aliases.slice(i, i + BATCH_SIZE);

    const rows = await Promise.all(
      batch.map(async (alias) => {
        let embedding: number[] | null = null;
        if (generateEmbeddings) {
          try {
            embedding = await generateEmbedding(alias.alias);
          } catch (err: any) {
            errors.push(`Embedding failed for "${alias.alias}": ${err.message}`);
          }
        }

        const now = Spanner.COMMIT_TIMESTAMP;
        return {
          AliasId: `${alias.sport}-${alias.entityType}-${alias.canonicalId}-${Buffer.from(alias.alias).toString("base64").substring(0, 12)}`,
          Alias: alias.alias,
          AliasLower: alias.alias.toLowerCase(),
          EntityType: alias.entityType,
          Sport: alias.sport,
          CanonicalId: alias.canonicalId,
          CanonicalName: alias.canonicalName,
          AliasSource: alias.aliasSource || "auto",
          Confidence: Spanner.float(alias.confidence || 1.0),
          AliasEmbedding: embedding,
          CreatedAt: now,
          UpdatedAt: now,
        };
      })
    );

    try {
      await database.table("EntityAliases").upsert(rows);
      inserted += rows.length;
    } catch (err: any) {
      errors.push(`Batch insert failed at offset ${i}: ${err.message}`);
    }
  }

  logger.info({ msg: "Entity aliases seeded", inserted, errorCount: errors.length });
  return { inserted, errors };
}
