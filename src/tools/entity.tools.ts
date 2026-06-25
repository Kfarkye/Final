/**
 * entity.tools.ts — LLM-callable entity resolution tools.
 *
 * Exposes the vector-powered entity resolver to the agent so it can:
 *   1. Resolve player/team names, nicknames, and slang → canonical IDs
 *   2. Resolve stat slang → canonical column names
 *   3. Seed new aliases (with optional embedding generation)
 *   4. Detect sport from natural language
 */

import { z } from "zod";
import { RegisteredTool } from "./types";
import {
  resolveEntity,
  resolveQuestion,
  seedEntityAliases,
  ResolvedEntity,
} from "../services/entity-resolver";

export const entityTools: RegisteredTool<any>[] = [
  // ═══════════════════════════════════════════════════════════════════
  // resolve_entity — The core lookup. "King James" → LeBron James
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "resolve_entity",
      description:
        "Resolve a player name, team name, nickname, or slang to its canonical database entity. " +
        "Uses a 3-tier pipeline: exact index match → fuzzy substring → vector similarity search. " +
        "Examples: 'King James' → LeBron James, 'Yanks' → NYY, 'the greek freak' → Giannis Antetokounmpo, " +
        "'bombs' resolves as a stat alias for Home Runs. " +
        "Use this BEFORE building queries when the user uses informal language.",
      schema: z.object({
        query: z
          .string()
          .min(1)
          .describe(
            "The entity mention to resolve (e.g. 'King James', 'Yanks', 'Bron', 'bombs')"
          ),
        sport: z
          .enum(["mlb", "nba", "nfl", "nhl", "soccer"])
          .optional()
          .describe(
            "Optional sport context to narrow results. If omitted, searches across all sports."
          ),
      }),
    },
    handler: async (args) => {
      const results = await resolveEntity(args.query, args.sport);

      if (results.length === 0) {
        return {
          resolved: false,
          query: args.query,
          sport: args.sport || "all",
          message: `No entity found for "${args.query}". The term may need to be added to the alias database.`,
          suggestion:
            "Try the full official name, or use seed_entity_aliases to add this as a known alias.",
        };
      }

      const best = results[0];
      return {
        resolved: true,
        query: args.query,
        matchCount: results.length,
        best: {
          canonicalId: best.canonicalId,
          canonicalName: best.canonicalName,
          entityType: best.entityType,
          sport: best.sport,
          confidence: best.confidence,
          matchMethod: best.matchMethod,
        },
        alternatives:
          results.length > 1
            ? results.slice(1).map((r) => ({
                canonicalName: r.canonicalName,
                sport: r.sport,
                confidence: r.confidence,
                matchMethod: r.matchMethod,
              }))
            : [],
      };
    },
  },

  // ═══════════════════════════════════════════════════════════════════
  // resolve_question — Full NL question → entities + stats + sport
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "resolve_question",
      description:
        "Resolve ALL entities and stat terms from a full natural-language sports question. " +
        "Extracts player/team mentions, stat slang, and auto-detects the sport. " +
        "Example: 'How many bombs did King James hit at Coors?' → " +
        "entities: [{LeBron James, nba}], stats: [{HomeRuns, mlb}], detected conflict → asks for clarification. " +
        "Use this as the FIRST step when processing a StatMuse-style question.",
      schema: z.object({
        terms: z
          .array(z.string())
          .min(1)
          .describe(
            "Extracted entity/stat terms from the question " +
            "(e.g. ['King James', 'bombs', 'Coors'])"
          ),
        questionText: z
          .string()
          .min(1)
          .describe("The full original question text for sport detection"),
      }),
    },
    handler: async (args) => {
      const result = await resolveQuestion(args.terms, args.questionText);

      return {
        detectedSport: result.detectedSport,
        entityCount: result.entities.length,
        statCount: result.stats.length,
        unresolvedCount: result.unresolvedTerms.length,
        entities: result.entities.map((e) => ({
          canonicalId: e.canonicalId,
          canonicalName: e.canonicalName,
          entityType: e.entityType,
          sport: e.sport,
          confidence: e.confidence,
          matchMethod: e.matchMethod,
          originalAlias: e.alias,
        })),
        stats: result.stats.map((s) => ({
          canonicalColumn: s.canonicalColumn,
          canonicalLabel: s.canonicalLabel,
          tableName: s.tableName,
          sport: s.sport,
        })),
        unresolvedTerms: result.unresolvedTerms,
        hint:
          result.unresolvedTerms.length > 0
            ? `Could not resolve: ${result.unresolvedTerms.join(", ")}. Try using official names or seed these as aliases.`
            : undefined,
      };
    },
  },

  // ═══════════════════════════════════════════════════════════════════
  // seed_entity_aliases — Bulk-insert aliases for entity resolution
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "seed_entity_aliases",
      description:
        "Insert entity aliases into the resolution database. Use this to add player nicknames, " +
        "team abbreviations, common misspellings, and stat slang. " +
        "Optionally generates text-embedding-004 embeddings for vector search (slower but enables semantic matching). " +
        "Example: seed 'King James' → LeBron James, 'Bron' → LeBron James, 'dubs' → Golden State Warriors.",
      schema: z.object({
        aliases: z
          .array(
            z.object({
              alias: z
                .string()
                .min(1)
                .describe("The alias text (what users type)"),
              entityType: z
                .enum(["player", "team", "stat", "venue"])
                .describe("What kind of entity this alias refers to"),
              sport: z
                .enum(["mlb", "nba", "nfl", "nhl", "soccer"])
                .describe("Which sport this alias belongs to"),
              canonicalId: z
                .string()
                .min(1)
                .describe(
                  "The canonical entity ID in the sport-specific database"
                ),
              canonicalName: z
                .string()
                .min(1)
                .describe(
                  "The official/canonical name (e.g. 'LeBron James', 'New York Yankees')"
                ),
              aliasSource: z
                .enum(["official", "nickname", "abbreviation", "slang", "typo", "auto"])
                .optional()
                .describe("How this alias was sourced"),
              confidence: z
                .number()
                .min(0)
                .max(1)
                .optional()
                .describe(
                  "Confidence score (1.0 = perfect match, 0.5 = weak). Default 1.0"
                ),
            })
          )
          .min(1)
          .max(200)
          .describe("Array of alias records to insert (max 200 per call)"),
        generateEmbeddings: z
          .boolean()
          .optional()
          .describe(
            "If true, generates text-embedding-004 vectors for each alias (enables vector search but slower). Default false."
          ),
      }),
    },
    handler: async (args) => {
      const result = await seedEntityAliases(
        args.aliases,
        args.generateEmbeddings || false
      );

      return {
        success: result.inserted > 0,
        inserted: result.inserted,
        requested: args.aliases.length,
        embeddingsGenerated: args.generateEmbeddings || false,
        errors:
          result.errors.length > 0
            ? result.errors.slice(0, 10) // Cap error output
            : undefined,
        message: `Seeded ${result.inserted}/${args.aliases.length} aliases${
          args.generateEmbeddings ? " with embeddings" : ""
        }.${result.errors.length > 0 ? ` ${result.errors.length} errors.` : ""}`,
      };
    },
  },

  // ═══════════════════════════════════════════════════════════════════
  // detect_sport — Quick sport detection from text
  // ═══════════════════════════════════════════════════════════════════
  {
    definition: {
      name: "detect_sport",
      description:
        "Detect which sport a natural-language question is about based on keyword analysis. " +
        "Returns the most likely sport and confidence indicators. " +
        "Use this when the user's question doesn't explicitly mention a sport. " +
        "Example: 'who has the most triple-doubles?' → nba",
      schema: z.object({
        text: z
          .string()
          .min(1)
          .describe("The question or text to analyze for sport detection"),
      }),
    },
    handler: async (args) => {
      const lower = args.text.toLowerCase();
      const SPORT_KEYWORDS: Record<string, string[]> = {
        mlb: [
          "batting", "average", "home run", "homer", "rbi", "era", "strikeout",
          "pitch", "inning", "at-bat", "slugging", "obp", "whip", "base",
          "diamond", "mound", "bullpen", "lineup", "batter", "pitcher",
          "baseball", "mlb",
        ],
        nba: [
          "points", "rebound", "assist", "block", "steal", "triple-double",
          "double-double", "three-pointer", "dunk", "quarter", "free throw",
          "court", "bucket", "paint", "fadeaway", "basketball", "nba",
        ],
        nfl: [
          "touchdown", "passing yard", "rushing", "interception", "sack",
          "reception", "fantasy", "quarterback", "wide receiver", "tight end",
          "field goal", "punt", "fumble", "red zone", "football", "nfl",
        ],
        nhl: [
          "goal", "hockey", "nhl", "hat trick", "power play", "penalty",
          "goaltender", "slap shot", "icing", "face-off",
        ],
        soccer: [
          "goal", "soccer", "football", "premier league", "la liga",
          "champions league", "penalty kick", "offside", "world cup",
          "clean sheet", "hat trick",
        ],
      };

      const scores: Record<string, { score: number; matches: string[] }> = {};
      for (const [sport, keywords] of Object.entries(SPORT_KEYWORDS)) {
        const matches: string[] = [];
        for (const keyword of keywords) {
          if (lower.includes(keyword)) matches.push(keyword);
        }
        scores[sport] = { score: matches.length, matches };
      }

      const sorted = Object.entries(scores).sort(
        (a, b) => b[1].score - a[1].score
      );
      const best = sorted[0];

      return {
        detectedSport: best[1].score > 0 ? best[0] : null,
        confidence:
          best[1].score > 0
            ? best[1].score >= 3
              ? "high"
              : best[1].score >= 2
              ? "medium"
              : "low"
            : "none",
        scores: Object.fromEntries(
          sorted
            .filter(([, v]) => v.score > 0)
            .map(([k, v]) => [k, { score: v.score, matchedKeywords: v.matches }])
        ),
        hint:
          best[1].score === 0
            ? "Could not detect sport from text. Ask the user which sport they mean."
            : undefined,
      };
    },
  },
];
