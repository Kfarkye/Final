/**
 * KnowledgeManager — Filesystem-based persistent memory for the agent.
 *
 * Mirrors the Antigravity IDE's Knowledge Item (KI) system:
 *   ~/.gemini/antigravity-ide/knowledge/{namespace}/
 *     ├── metadata.json
 *     ├── timestamps.json
 *     └── artifacts/*.md
 *
 * Extended with `freshnessClass` for sports data decay (ChatGPT 5.5 insight):
 *   static          → always safe to reuse
 *   slow_changing   → revalidate if > 7 days old
 *   volatile        → NEVER trust as current fact — context only
 *   analysis_snapshot → cite historically with "as of {date}" caveat
 */

import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';

// ── Types ────────────────────────────────────────────────────────────────────

export type FreshnessClass = 'static' | 'slow_changing' | 'volatile' | 'analysis_snapshot';

export interface KIMetadata {
  title: string;
  summary: string;
  freshnessClass: FreshnessClass;
  tags: string[];
  references: Array<{ type: string; value: string }>;
}

export interface KITimestamps {
  created: string;
  modified: string;
  accessed: string;
}

export interface KnowledgeItem {
  namespace: string;
  metadata: KIMetadata;
  timestamps: KITimestamps;
  artifacts: Array<{ path: string; content: string }>;
  freshnessStatus: 'fresh' | 'stale' | 'context_only' | 'historical';
}

export interface KISummary {
  namespace: string;
  title: string;
  summary: string;
  freshnessClass: FreshnessClass;
  freshnessStatus: string;
  tags: string[];
  artifactPaths: string[];
}

// ── Freshness Rules ──────────────────────────────────────────────────────────

const SLOW_CHANGING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function computeFreshnessStatus(
  freshnessClass: FreshnessClass,
  modifiedAt: string
): 'fresh' | 'stale' | 'context_only' | 'historical' {
  switch (freshnessClass) {
    case 'static':
      return 'fresh';
    case 'slow_changing': {
      const age = Date.now() - new Date(modifiedAt).getTime();
      return age > SLOW_CHANGING_MAX_AGE_MS ? 'stale' : 'fresh';
    }
    case 'volatile':
      return 'context_only'; // Never trust as current — must refresh with live tools
    case 'analysis_snapshot':
      return 'historical'; // Can cite, but only with "as of {date}" caveat
    default:
      return 'context_only';
  }
}

// ── KnowledgeManager ─────────────────────────────────────────────────────────

export class KnowledgeManager {
  private basePath: string;

  constructor(basePath: string) {
    this.basePath = basePath;
    // Ensure the base directory exists
    if (!fs.existsSync(this.basePath)) {
      fs.mkdirSync(this.basePath, { recursive: true });
    }
  }

  /**
   * List all knowledge item namespaces with summary metadata.
   * Mirrors the IDE's KI summary injection at conversation start.
   */
  listKnowledgeItems(): KISummary[] {
    const summaries: KISummary[] = [];

    try {
      const dirs = fs.readdirSync(this.basePath, { withFileTypes: true })
        .filter(d => d.isDirectory());

      for (const dir of dirs) {
        const metaPath = path.join(this.basePath, dir.name, 'metadata.json');
        const tsPath = path.join(this.basePath, dir.name, 'timestamps.json');

        if (!fs.existsSync(metaPath)) continue;

        try {
          const metadata: KIMetadata = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
          const timestamps: KITimestamps = fs.existsSync(tsPath)
            ? JSON.parse(fs.readFileSync(tsPath, 'utf-8'))
            : { created: new Date().toISOString(), modified: new Date().toISOString(), accessed: new Date().toISOString() };

          // List artifact files
          const artifactsDir = path.join(this.basePath, dir.name, 'artifacts');
          const artifactPaths = fs.existsSync(artifactsDir)
            ? fs.readdirSync(artifactsDir).filter(f => f.endsWith('.md'))
            : [];

          summaries.push({
            namespace: dir.name,
            title: metadata.title,
            summary: metadata.summary,
            freshnessClass: metadata.freshnessClass,
            freshnessStatus: computeFreshnessStatus(metadata.freshnessClass, timestamps.modified),
            tags: metadata.tags || [],
            artifactPaths,
          });
        } catch (err: any) {
          logger.warn({ msg: 'Failed to read KI metadata', namespace: dir.name, err: err.message });
        }
      }
    } catch (err: any) {
      logger.error({ msg: 'Failed to list knowledge items', err: err.message });
    }

    return summaries;
  }

  /**
   * Get a full knowledge item with all artifacts.
   */
  getKnowledgeItem(namespace: string): KnowledgeItem | null {
    const nsDir = path.join(this.basePath, namespace);
    const metaPath = path.join(nsDir, 'metadata.json');
    const tsPath = path.join(nsDir, 'timestamps.json');

    if (!fs.existsSync(metaPath)) return null;

    try {
      const metadata: KIMetadata = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      const timestamps: KITimestamps = fs.existsSync(tsPath)
        ? JSON.parse(fs.readFileSync(tsPath, 'utf-8'))
        : { created: new Date().toISOString(), modified: new Date().toISOString(), accessed: new Date().toISOString() };

      // Update access timestamp
      timestamps.accessed = new Date().toISOString();
      fs.writeFileSync(tsPath, JSON.stringify(timestamps, null, 2));

      // Read all artifacts
      const artifactsDir = path.join(nsDir, 'artifacts');
      const artifacts: Array<{ path: string; content: string }> = [];

      if (fs.existsSync(artifactsDir)) {
        const walkDir = (dir: string, prefix: string = '') => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
              walkDir(path.join(dir, entry.name), relPath);
            } else if (entry.name.endsWith('.md')) {
              artifacts.push({
                path: relPath,
                content: fs.readFileSync(path.join(dir, entry.name), 'utf-8'),
              });
            }
          }
        };
        walkDir(artifactsDir);
      }

      return {
        namespace,
        metadata,
        timestamps,
        artifacts,
        freshnessStatus: computeFreshnessStatus(metadata.freshnessClass, timestamps.modified),
      };
    } catch (err: any) {
      logger.error({ msg: 'Failed to read knowledge item', namespace, err: err.message });
      return null;
    }
  }

  /**
   * Write or update a knowledge item.
   * The LLM calls this to proactively save insights.
   */
  writeKnowledgeItem(
    namespace: string,
    metadata: Partial<KIMetadata>,
    artifactPath?: string,
    artifactContent?: string
  ): { success: boolean; error?: string } {
    try {
      const nsDir = path.join(this.basePath, namespace);
      const metaPath = path.join(nsDir, 'metadata.json');
      const tsPath = path.join(nsDir, 'timestamps.json');

      // Create namespace directory
      fs.mkdirSync(path.join(nsDir, 'artifacts'), { recursive: true });

      // Read or create metadata
      let existing: KIMetadata = fs.existsSync(metaPath)
        ? JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
        : { title: namespace, summary: '', freshnessClass: 'static' as FreshnessClass, tags: [], references: [] };

      // Merge updates
      if (metadata.title) existing.title = metadata.title;
      if (metadata.summary) existing.summary = metadata.summary;
      if (metadata.freshnessClass) existing.freshnessClass = metadata.freshnessClass;
      if (metadata.tags) existing.tags = [...new Set([...(existing.tags || []), ...metadata.tags])];
      if (metadata.references) existing.references = [...(existing.references || []), ...metadata.references];

      fs.writeFileSync(metaPath, JSON.stringify(existing, null, 2));

      // Update timestamps
      const now = new Date().toISOString();
      const timestamps: KITimestamps = fs.existsSync(tsPath)
        ? JSON.parse(fs.readFileSync(tsPath, 'utf-8'))
        : { created: now, modified: now, accessed: now };
      timestamps.modified = now;
      timestamps.accessed = now;
      fs.writeFileSync(tsPath, JSON.stringify(timestamps, null, 2));

      // Write artifact if provided
      if (artifactPath && artifactContent) {
        const fullArtifactPath = path.join(nsDir, 'artifacts', artifactPath);
        fs.mkdirSync(path.dirname(fullArtifactPath), { recursive: true });
        fs.writeFileSync(fullArtifactPath, artifactContent);
      }

      logger.info({ msg: 'Knowledge item written', namespace, artifactPath });
      return { success: true };
    } catch (err: any) {
      logger.error({ msg: 'Failed to write knowledge item', namespace, err: err.message });
      return { success: false, error: err.message };
    }
  }

  /**
   * Search knowledge items by query string across summaries and artifact content.
   */
  searchKnowledgeItems(query: string, tags?: string[]): KISummary[] {
    const allItems = this.listKnowledgeItems();
    const queryLower = query.toLowerCase();
    const tagSet = tags ? new Set(tags.map(t => t.toLowerCase())) : null;

    return allItems.filter(item => {
      // Tag filter
      if (tagSet && !item.tags.some(t => tagSet.has(t.toLowerCase()))) {
        return false;
      }

      // Text search across title, summary, and tags
      const searchable = [item.title, item.summary, ...item.tags].join(' ').toLowerCase();
      if (searchable.includes(queryLower)) return true;

      // Deep search: check artifact content
      const nsDir = path.join(this.basePath, item.namespace, 'artifacts');
      if (fs.existsSync(nsDir)) {
        for (const file of item.artifactPaths) {
          try {
            const content = fs.readFileSync(path.join(nsDir, file), 'utf-8').toLowerCase();
            if (content.includes(queryLower)) return true;
          } catch { /* skip unreadable */ }
        }
      }

      return false;
    });
  }

  /**
   * Generate compact KI summaries for system prompt injection.
   * Mirrors the IDE's knowledge_items injection block.
   */
  getKnowledgeSummaries(): string {
    const items = this.listKnowledgeItems();
    if (items.length === 0) return '';

    const FRESHNESS_LABELS: Record<string, string> = {
      fresh: '✅ Current',
      stale: '⚠️ May be outdated — verify before citing',
      context_only: '🔒 Context only — MUST verify with live tools before any claims',
      historical: '📚 Historical snapshot — cite with "as of" date only',
    };

    const lines = items.map(item => {
      const label = FRESHNESS_LABELS[item.freshnessStatus] || '❓ Unknown';
      return `- **${item.title}** [${item.namespace}] (${label})\n  ${item.summary}\n  Artifacts: ${item.artifactPaths.join(', ') || 'none'}`;
    });

    return [
      'The following Knowledge Items are available from persistent memory.',
      'CRITICAL: Check the freshness status before citing any KI as current fact.',
      'Items marked "Context only" or "Historical" must NOT be presented as current truth.',
      '',
      ...lines,
    ].join('\n');
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────

const KNOWLEDGE_DIR = path.resolve(process.cwd(), 'data', 'knowledge');
export const knowledgeManager = new KnowledgeManager(KNOWLEDGE_DIR);
