import React, { useMemo, useState, memo } from 'react';
import { copyToClipboard } from '../utils/clipboard';
import { ChevronRight, Copy, Check, ExternalLink } from 'lucide-react';
import './tool-trace.css';

export interface ToolTraceEntry {
  id: string;
  tool: string;
  model: string;
  status: 'running' | 'success' | 'error';
  argsPreview?: string;
  resultPreview?: string;
  error?: string;
  startedAt: number;
  elapsedMs?: number;
}

interface ToolTraceProps {
  entries: ToolTraceEntry[];
}

/* ------------------------------------------------------------------ *
 * Formatting helpers
 * ------------------------------------------------------------------ */

function formatDuration(ms?: number): string {
  if (ms == null) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}

function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function safeParse(s?: string): any {
  if (!s) return undefined;
  try { return JSON.parse(s); } catch { return undefined; }
}

/* ------------------------------------------------------------------ *
 * TRANSLATE LAYER
 * ------------------------------------------------------------------ */

interface ToolLabel {
  verb: string;
  object?: string;
  link?: string;
}

function basename(p?: string): string {
  if (!p) return '';
  return p.split('/').filter(Boolean).pop() || p;
}

function host(url?: string): { host: string; link?: string } | undefined {
  if (!url) return undefined;
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    return { host: h, link: url };
  } catch {
    return undefined;
  }
}

function clip(s: string, n: number): string {
  s = s.trim().replace(/\s+/g, ' ');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function translateTool(tool: string, argsPreview?: string): ToolLabel {
  const args = safeParse(argsPreview) ?? {};

  switch (tool) {
    case 'execute_sql': {
      const sql = String(args.sql || '').trim();
      const table = sql.match(/(?:FROM|UPDATE|INTO|JOIN)\s+`?(\w+)`?/i)?.[1];
      const isCount = /^\s*SELECT\s+COUNT/i.test(sql) || /\bCOUNT\s*\(/i.test(sql.slice(0, 40));
      const isCte = /^\s*WITH\b/i.test(sql);
      if (/^\s*UPDATE/i.test(sql)) return { verb: 'Updated', object: table };
      if (/^\s*INSERT/i.test(sql)) return { verb: 'Inserted into', object: table };
      if (/^\s*DELETE/i.test(sql)) return { verb: 'Deleted from', object: table };
      if (isCount) return { verb: 'Counted', object: table ?? 'rows' };
      if (isCte) return { verb: 'Analyzed', object: table ?? 'query' };
      if (/^\s*SELECT/i.test(sql)) return { verb: 'Queried', object: table ?? 'database' };
      return { verb: 'Ran query', object: table };
    }
    case 'describe_spanner_table': return { verb: 'Inspected', object: `${args.tableName || 'table'} schema` };
    case 'get_full_schema':
    case 'get_database_ddl': return { verb: 'Mapped', object: 'database schema' };
    case 'list_instances': return { verb: 'Listed', object: 'Spanner instances' };
    case 'list_databases': return { verb: 'Listed', object: 'databases' };
    case 'batch_write': return { verb: 'Bulk-loaded', object: args.tableName };
    case 'execute_ddl': return { verb: 'Applied', object: 'schema migration' };
    case 'create_database': return { verb: 'Created database', object: args.databaseId };

    case 'generate_embeddings': return { verb: 'Generated', object: 'embeddings' };
    case 'backfill_embeddings': return { verb: 'Backfilled', object: `${args.sport || 'all'} embeddings` };
    case 'create_vector_index': return { verb: 'Built', object: 'vector index' };
    case 'resolve_entity': return { verb: 'Resolved', object: `"${clip(String(args.query || ''), 28)}"` };
    case 'resolve_question': return { verb: 'Parsed', object: 'question entities' };
    case 'detect_sport': return { verb: 'Detected', object: 'sport' };
    case 'seed_entity_aliases': return { verb: 'Seeded', object: 'aliases' };

    case 'search_web':
    case 'google_search': return { verb: 'Searched', object: `"${clip(String(args.query || ''), 36)}"` };
    case 'browser_navigate':
    case 'fetch_html':
    case 'fetch_markdown':
    case 'fetch_readable':
    case 'fetch_text':
    case 'extract_page': {
      const h = host(args.url || args.urls?.[0]);
      return h ? { verb: 'Read', object: h.host, link: h.link } : { verb: 'Read', object: 'page' };
    }
    case 'fetch_json':
    case 'http_request': {
      const h = host(args.url);
      return h ? { verb: 'Fetched', object: h.host, link: h.link } : { verb: 'Fetched', object: 'data' };
    }
    case 'browser_screenshot': return { verb: 'Captured', object: 'screenshot' };
    case 'browser_extract_table': return { verb: 'Extracted', object: 'tables' };
    case 'browser_click': return { verb: 'Clicked', object: clip(String(args.selector || 'element'), 28) };
    case 'browser_fill': return { verb: 'Filled', object: clip(String(args.selector || 'field'), 28) };
    case 'browser_evaluate': return { verb: 'Evaluated', object: 'page script' };

    case 'read_file':
    case 'read_source_file': return { verb: 'Read', object: basename(args.filePath || args.path) || 'file' };
    case 'write_file':
    case 'write_staged_file': return { verb: 'Wrote', object: basename(args.filePath) || 'file' };
    case 'edit_file': return { verb: 'Edited', object: basename(args.filePath) || 'file' };
    case 'list_directory':
    case 'list_source_directory': return { verb: 'Listed', object: args.path || 'directory' };
    case 'grep':
    case 'search_source_code': return { verb: 'Searched code for', object: `"${clip(String(args.pattern || args.query || ''), 28)}"` };
    case 'run_tsc': return { verb: 'Type-checked', object: 'project' };
    case 'run_tests': return { verb: 'Ran', object: 'tests' };
    case 'exec_command': return { verb: 'Ran', object: clip(String(args.command || 'command'), 40) };
    case 'run_script':
    case 'execute_javascript': return { verb: 'Executed', object: 'script' };
    case 'resolve_youtube_media': return { verb: 'Finding videos:', object: `"${(args.query || '').slice(0, 30)}"` };
    case 'run_git_status':
    case 'git_branch_ops': return { verb: 'Ran', object: `git ${args.operation || 'status'}` };
    case 'get_git_diff': return { verb: 'Diffed', object: 'changes' };
    case 'view_git_commits': return { verb: 'Read', object: 'commit history' };
    case 'undo_operation': return { verb: 'Reverted', object: 'change' };

    case 'deploy_truth_cloudbuild':
    case 'deploy_staged_mcp': return { verb: 'Deployed', object: args.serviceName || args.imageTag || 'build' };
    case 'trigger_build': return { verb: 'Started', object: 'build' };
    case 'list_builds': return { verb: 'Read', object: 'build history' };
    case 'get_build_log': return { verb: 'Read', object: 'build log' };
    case 'list_staged_files': return { verb: 'Listed', object: 'staged files' };
    case 'read_staged_file': return { verb: 'Read', object: basename(args.filePath) || 'staged file' };

    case 'forge_mcp_endpoint': return { verb: 'Forged', object: args.mcpServerId || 'endpoint' };
    case 'register_runtime_tool': return { verb: 'Registered', object: args.name || 'tool' };
    case 'unregister_tool': return { verb: 'Removed', object: args.name || 'tool' };
    case 'list_registered_tools': return { verb: 'Listed', object: 'tools' };
    case 'call_tool': return { verb: 'Invoked', object: args.toolName || 'tool' };

    case 'get_mlb_odds': return { verb: 'Pulled', object: 'MLB odds' };
    case 'get_mlb_scores':
    case 'get_live_scores': return { verb: 'Pulled', object: 'live scores' };
    case 'get_mlb_schedule': return { verb: 'Pulled', object: 'schedule' };
    case 'get_mlb_player_splits': return { verb: 'Pulled', object: 'player splits' };
    case 'get_mlb_bvp': return { verb: 'Pulled', object: 'batter-vs-pitcher' };
    case 'get_game_environment': return { verb: 'Checked', object: 'game environment' };
    case 'search_mlb_player': return { verb: 'Found', object: clip(String(args.name || 'player'), 28) };
    case 'query_truth_ledger': return { verb: 'Queried', object: 'Truth ledger' };

    case 'request_human_secret': return { verb: 'Requested', object: args.secretId || 'credential' };
    case 'searchDrive': return { verb: 'Searched', object: 'Drive' };
    case 'readDriveFile': return { verb: 'Read', object: 'Drive file' };
    case 'createDriveFile': return { verb: 'Created', object: args.name || 'Drive file' };
    case 'searchEmail': return { verb: 'Searched', object: 'email' };
    case 'sendEmail': return { verb: 'Drafted', object: 'email' };
    case 'createEvent': return { verb: 'Created', object: 'calendar event' };
    case 'get_current_time': return { verb: 'Checked', object: 'time' };
    case 'analyze_image': return { verb: 'Analyzed', object: 'image' };
    case 'delegate_task': return { verb: 'Delegated', object: clip(String(args.objective || 'task'), 36) };

    default: {
      const words = tool.replace(/_/g, ' ').trim();
      const pretty = words.charAt(0).toUpperCase() + words.slice(1);
      return { verb: pretty };
    }
  }
}

/* ------------------------------------------------------------------ *
 * RESULT METRIC LAYER
 * ------------------------------------------------------------------ */

function deriveMetric(tool: string, resultPreview?: string): string | undefined {
  if (!resultPreview) return undefined;
  const r = safeParse(resultPreview);

  if (r && typeof r === 'object' && !Array.isArray(r)) {
    if (typeof r.rowCount === 'number') return `${formatCount(r.rowCount)} ${r.rowCount === 1 ? 'row' : 'rows'}`;
    if (Array.isArray(r.rows)) return `${formatCount(r.rows.length)} ${r.rows.length === 1 ? 'row' : 'rows'}`;
    if (Array.isArray(r.columns)) return `${r.columns.length} cols`;
    if (typeof r.matchCount === 'number') return `${formatCount(r.matchCount)} ${r.matchCount === 1 ? 'match' : 'matches'}`;
    if (Array.isArray(r.matches)) return `${formatCount(r.matches.length)} ${r.matches.length === 1 ? 'match' : 'matches'}`;
    if (Array.isArray(r.results)) return `${formatCount(r.results.length)} ${r.results.length === 1 ? 'result' : 'results'}`;
    if (Array.isArray(r.entries)) return `${formatCount(r.entries.length)} items`;
    if (Array.isArray(r.diagnostics)) {
      const n = r.diagnostics.length;
      return n === 0 ? 'clean' : `${n} ${n === 1 ? 'error' : 'errors'}`;
    }
    if (typeof r.errorCount === 'number') return r.errorCount === 0 ? 'clean' : `${r.errorCount} errors`;
    if (typeof r.totalLines === 'number') return `${formatCount(r.totalLines)} lines`;
    if (typeof r.sizeBytes === 'number') return formatBytes(r.sizeBytes);
    if (typeof r.processed === 'number') return `${formatCount(r.processed)} processed`;
    if (typeof r.count === 'number') return `${formatCount(r.count)}`;
    if (r.exists === true && tool.includes('file')) return 'found';
    if (r.exists === false && tool.includes('file')) return 'not found';
  }

  if (Array.isArray(r)) {
    return `${formatCount(r.length)} ${r.length === 1 ? 'item' : 'items'}`;
  }

  return undefined;
}

/* ------------------------------------------------------------------ *
 * SECURITY LAYER: Escape HTML to prevent XSS in dangerouslySetInnerHTML
 * ------------------------------------------------------------------ */
function escapeHtml(unsafe: string) {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/* ------------------------------------------------------------------ *
 * JSON syntax highlight (payload disclosure)
 * ------------------------------------------------------------------ */

function highlightJson(jsonString: string): React.ReactNode[] {
  const safeJson = escapeHtml(jsonString);
  const lines = safeJson.split('\n');
  
  return lines.map((line, idx) => {
    const highlighted = line
      .replace(/("(?:[^"\\]|\\.)*")(\s*:)/g, '<span class="trace-kw">$1</span>$2')
      .replace(/(:\s*)("(?:[^"\\]|\\.)*")/g, '$1<span class="trace-str">$2</span>')
      .replace(/(:\s*)(true|false|null)/g, '$1<span class="trace-kw">$2</span>')
      .replace(/(:\s*)([-0-9.]+)([,\s}\]]|$)/g, '$1<span class="trace-num">$2</span>$3');

    return (
      <span
        key={idx}
        className="trace-ln"
        data-n={idx + 1}
        dangerouslySetInnerHTML={{ __html: highlighted || ' ' }}
      />
    );
  });
}

/* ------------------------------------------------------------------ *
 * Render
 * ------------------------------------------------------------------ */

const ToolTraceItem: React.FC<{ entry: ToolTraceEntry }> = memo(({ entry }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const { verb, object, link } = useMemo(
    () => translateTool(entry.tool, entry.argsPreview),
    [entry.tool, entry.argsPreview],
  );

  const metric = useMemo(
    () => (entry.status === 'success' ? deriveMetric(entry.tool, entry.resultPreview) : undefined),
    [entry.tool, entry.resultPreview, entry.status],
  );

  const statusClass =
    entry.status === 'running'
      ? 'trace-running'
      : entry.status === 'error'
        ? 'trace-error'
        : 'trace-done';

  const openClass = isOpen ? 'trace-open' : '';
  const hasPayload = entry.argsPreview && entry.argsPreview !== '{}';

  // Lazy evaluate syntax highlighting to prevent main-thread lockups on large payloads
  const highlightedPayload = useMemo(() => {
    if (!isOpen || !hasPayload || !entry.argsPreview) return null;
    return highlightJson(entry.argsPreview);
  }, [isOpen, hasPayload, entry.argsPreview]);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (entry.argsPreview) {
      copyToClipboard(entry.argsPreview);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <div className={`trace-turn ${statusClass} ${openClass}`}>
      <div className="trace-node" />

      <div className="trace-tool" onClick={() => setIsOpen(!isOpen)}>
        <span className="trace-verb">{verb}</span>
        {object && <span className="trace-object">{object}</span>}
        {link && (
          <a
            className="trace-link ml-1.5 inline-flex items-center text-zinc-500 hover:text-zinc-300"
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            aria-label="Open source"
          >
            <ExternalLink size={12} />
          </a>
        )}

        <span className="trace-spacer" />

        {/* live status / result metric on the right edge */}
        {entry.status === 'running' && <span className="trace-pill trace-pill-live">working</span>}
        {entry.status === 'success' && metric && <span className="trace-pill trace-pill-ok">{metric}</span>}
        {entry.status === 'error' && <span className="trace-pill trace-pill-err">failed</span>}

        {entry.elapsedMs != null && (
          <span className="trace-dur">{formatDuration(entry.elapsedMs)}</span>
        )}
        <span className="trace-chev ml-2 text-zinc-600">
          <ChevronRight size={14} className={`transition-transform duration-200 ${isOpen ? 'rotate-90' : ''}`} />
        </span>
      </div>

      {/* progressive disclosure */}
      <div className="trace-payload">
        {entry.status === 'error' && entry.error && (
          <div className="trace-error-msg">{entry.error}</div>
        )}

        {entry.status === 'success' && entry.resultPreview && (
          <div className="trace-result-preview" title={entry.resultPreview}>
            → {entry.resultPreview.length > 160
              ? entry.resultPreview.slice(0, 160) + '…'
              : entry.resultPreview}
          </div>
        )}

        {hasPayload && isOpen && (
          <div className="trace-code">
            <div className="trace-code-head flex items-center justify-between">
              <span className="trace-code-lang font-mono text-[10px] text-zinc-500 uppercase tracking-wider">json</span>
              <button 
                className="trace-code-copy flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500 hover:text-zinc-300 transition-colors"
                onClick={handleCopy}
              >
                {copied ? <><Check size={12} className="text-emerald-500" /> copied</> : <><Copy size={12} /> copy</>}
              </button>
            </div>
            <pre>{highlightedPayload}</pre>
          </div>
        )}
      </div>
    </div>
  );
});

ToolTraceItem.displayName = 'ToolTraceItem';

export const ToolTrace: React.FC<ToolTraceProps> = ({ entries }) => {
  if (!entries || entries.length === 0) return null;

  return (
    <div className="trace-log">
      {entries.map((entry) => (
        <ToolTraceItem key={entry.id} entry={entry} />
      ))}
    </div>
  );
};

export default ToolTrace;
