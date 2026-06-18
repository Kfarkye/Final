/**
 * Knowledge Tools — LLM-callable tools for persistent memory.
 *
 * Mirrors the Antigravity IDE pattern where the agent can read/write
 * Knowledge Items during conversation. The LLM uses these to:
 *   - Proactively save insights ("user follows KBO")
 *   - Recall previous analysis and preferences
 *   - Search across all stored knowledge
 */

import { z } from 'zod';
import { RegisteredTool } from './types';
import { knowledgeManager, FreshnessClass } from '../services/knowledge-manager';

export const knowledgeTools: RegisteredTool<any>[] = [
  {
    definition: {
      name: 'list_knowledge',
      description:
        'Lists all Knowledge Items (persistent memory namespaces) with their summaries and freshness status. ' +
        'Use this at conversation start to understand what the agent already knows.',
      schema: z.object({}),
    },
    handler: () => {
      const items = knowledgeManager.listKnowledgeItems();
      return {
        count: items.length,
        items: items.map(item => ({
          namespace: item.namespace,
          title: item.title,
          summary: item.summary,
          freshnessClass: item.freshnessClass,
          freshnessStatus: item.freshnessStatus,
          tags: item.tags,
          artifactCount: item.artifactPaths.length,
        })),
      };
    },
  },

  {
    definition: {
      name: 'read_knowledge',
      description:
        'Reads a specific Knowledge Item by namespace, including all artifact content. ' +
        'Returns the full metadata, timestamps, freshness status, and artifact text. ' +
        'IMPORTANT: Check the freshnessStatus before citing content as current fact. ' +
        'Items with freshnessStatus "context_only" must be verified with live tools.',
      schema: z.object({
        namespace: z.string().min(1, 'Namespace is required (e.g., "user_preferences", "market_intelligence")'),
      }),
    },
    handler: (args) => {
      const item = knowledgeManager.getKnowledgeItem(args.namespace);
      if (!item) {
        return { error: `Knowledge Item '${args.namespace}' not found. Use list_knowledge to see available namespaces.` };
      }
      return {
        namespace: item.namespace,
        title: item.metadata.title,
        summary: item.metadata.summary,
        freshnessClass: item.metadata.freshnessClass,
        freshnessStatus: item.freshnessStatus,
        tags: item.metadata.tags,
        lastModified: item.timestamps.modified,
        lastAccessed: item.timestamps.accessed,
        artifacts: item.artifacts.map(a => ({
          path: a.path,
          content: a.content,
        })),
      };
    },
  },

  {
    definition: {
      name: 'write_knowledge',
      description:
        'Writes or updates a Knowledge Item in persistent memory. ' +
        'Use this proactively to save durable insights about the user, market patterns, or platform knowledge. ' +
        'Examples: "user follows the Dodgers", "Pinnacle is the sharp anchor for MLB totals", ' +
        '"pm-resolver requires awayAbbr normalization for futures". ' +
        'Choose the appropriate freshnessClass: ' +
        '"static" for facts that don\'t change (team IDs, user preferences), ' +
        '"slow_changing" for things that evolve over weeks (roster tendencies, market patterns), ' +
        '"volatile" for data that decays in hours (injuries, odds, lineups), ' +
        '"analysis_snapshot" for point-in-time analysis (yesterday\'s slate recap).',
      schema: z.object({
        namespace: z.string().min(1, 'Namespace (e.g., "user_preferences", "market_intelligence/pinnacle_patterns")'),
        title: z.string().optional().describe('Human-readable title for this knowledge item'),
        summary: z.string().optional().describe('Brief summary of what this KI contains'),
        freshnessClass: z
          .enum(['static', 'slow_changing', 'volatile', 'analysis_snapshot'])
          .optional()
          .describe('How quickly this knowledge decays'),
        tags: z.array(z.string()).optional().describe('Searchable tags'),
        artifactPath: z.string().optional().describe('Relative path within artifacts/ (e.g., "overview.md", "patterns/sharp_books.md")'),
        artifactContent: z.string().optional().describe('Markdown content to write to the artifact file'),
      }),
    },
    handler: (args) => {
      const metadata: any = {};
      if (args.title) metadata.title = args.title;
      if (args.summary) metadata.summary = args.summary;
      if (args.freshnessClass) metadata.freshnessClass = args.freshnessClass as FreshnessClass;
      if (args.tags) metadata.tags = args.tags;

      return knowledgeManager.writeKnowledgeItem(
        args.namespace,
        metadata,
        args.artifactPath,
        args.artifactContent
      );
    },
  },

  {
    definition: {
      name: 'search_knowledge',
      description:
        'Searches across all Knowledge Items by keyword and optional tags. ' +
        'Searches titles, summaries, tags, and artifact content. ' +
        'Use this to find relevant context before answering a question.',
      schema: z.object({
        query: z.string().min(1, 'Search query is required'),
        tags: z.array(z.string()).optional().describe('Optional tag filter'),
      }),
    },
    handler: (args) => {
      const results = knowledgeManager.searchKnowledgeItems(args.query, args.tags);
      return {
        query: args.query,
        matchCount: results.length,
        matches: results.map(item => ({
          namespace: item.namespace,
          title: item.title,
          summary: item.summary,
          freshnessClass: item.freshnessClass,
          freshnessStatus: item.freshnessStatus,
        })),
      };
    },
  },
];
