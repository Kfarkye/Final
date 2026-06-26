/**
 * TOOL TRACE — Agentic Invocation Log (v2 — Series A Polish)
 * 
 * Human-readable timeline of what the AI is doing:
 * - Plain English labels ("Querying database" not "call execute_sql")
 * - Smart arg previews that highlight what matters
 * - Animated status with elapsed time
 * - Expandable raw payload for power users
 */
import React, { useState } from 'react';
import { copyToClipboard } from '../utils/clipboard';
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

// ── Human-readable tool labels ──────────────────────────────────────────────
// Maps raw tool names to { icon, label } for non-dev readability
const TOOL_LABELS: Record<string, { icon: string; label: string; verb: string }> = {
  // Data & Queries
  execute_sql:             { icon: '🗄️', label: 'Database',       verb: 'Querying' },
  describe_spanner_table:  { icon: '📋', label: 'Schema',         verb: 'Reading' },
  get_full_schema:         { icon: '🏗️', label: 'Full Schema',    verb: 'Loading' },
  get_database_ddl:        { icon: '🏗️', label: 'Schema DDL',     verb: 'Loading' },
  list_instances:          { icon: '☁️', label: 'Cloud Instances', verb: 'Listing' },
  list_databases:          { icon: '☁️', label: 'Databases',       verb: 'Listing' },

  // Odds & Sports
  get_mlb_odds:            { icon: '📊', label: 'Live Odds',      verb: 'Fetching' },
  get_live_scores:         { icon: '⚾', label: 'Live Scores',    verb: 'Checking' },
  get_mlb_schedule:        { icon: '📅', label: 'Schedule',       verb: 'Loading' },
  get_player_stats:        { icon: '📈', label: 'Player Stats',   verb: 'Looking up' },
  get_team_stats:          { icon: '📈', label: 'Team Stats',     verb: 'Looking up' },
  get_standings:           { icon: '🏆', label: 'Standings',      verb: 'Checking' },
  get_injuries:            { icon: '🏥', label: 'Injury Report',  verb: 'Checking' },

  // Web & Research
  search_web:              { icon: '🔍', label: 'Web Search',     verb: 'Searching' },
  fetch_html:              { icon: '🌐', label: 'Web Page',       verb: 'Reading' },
  fetch_json:              { icon: '🌐', label: 'API',            verb: 'Calling' },
  fetch_markdown:          { icon: '📄', label: 'Article',        verb: 'Reading' },
  research_sources:        { icon: '📚', label: 'Research',       verb: 'Researching' },
  research_report:         { icon: '📝', label: 'Report',         verb: 'Compiling' },

  // Engineering
  write_file:              { icon: '✏️', label: 'File',           verb: 'Writing' },
  edit_file:               { icon: '🔧', label: 'File',           verb: 'Editing' },
  exec_command:            { icon: '⚡', label: 'Command',        verb: 'Running' },
  run_script:              { icon: '🚀', label: 'Script',         verb: 'Running' },
  read_file:               { icon: '📖', label: 'File',           verb: 'Reading' },
  list_directory:          { icon: '📂', label: 'Directory',      verb: 'Browsing' },

  // Admin
  request_human_secret:    { icon: '🔑', label: 'Credential',     verb: 'Requesting' },
  delegate_task:           { icon: '🤝', label: 'Delegation',     verb: 'Delegating' },
};

const DEFAULT_LABEL = { icon: '⚙️', label: 'Tool', verb: 'Running' };

function getToolDisplay(toolName: string) {
  return TOOL_LABELS[toolName] || DEFAULT_LABEL;
}

// ── Smart arg preview ───────────────────────────────────────────────────────
// Extracts the most meaningful piece from tool args for display
function smartPreview(toolName: string, argsPreview?: string): string | null {
  if (!argsPreview) return null;
  try {
    const args = JSON.parse(argsPreview);

    // SQL queries — show the query intent, not the full JSON
    if (toolName === 'execute_sql' && args.sql) {
      const sql = args.sql.trim();
      // Extract the table name and operation
      const selectMatch = sql.match(/SELECT\b[\s\S]*?\bFROM\s+(\w+)/i);
      const updateMatch = sql.match(/UPDATE\s+(\w+)/i);
      const insertMatch = sql.match(/INSERT\s+(?:INTO\s+)?(\w+)/i);
      const deleteMatch = sql.match(/DELETE\s+FROM\s+(\w+)/i);

      if (selectMatch) return `from ${selectMatch[1]}`;
      if (updateMatch) return `updating ${updateMatch[1]}`;
      if (insertMatch) return `into ${insertMatch[1]}`;
      if (deleteMatch) return `from ${deleteMatch[1]}`;
      return sql.length > 60 ? sql.slice(0, 57) + '…' : sql;
    }

    // Table description
    if (toolName === 'describe_spanner_table' && args.tableName) {
      return args.tableName;
    }

    // File operations
    if ((toolName === 'write_file' || toolName === 'edit_file' || toolName === 'read_file') && args.filePath) {
      const basename = args.filePath.split('/').pop();
      return basename;
    }

    // Command execution
    if (toolName === 'exec_command' && args.command) {
      return args.command.length > 50 ? args.command.slice(0, 47) + '…' : args.command;
    }

    // Web search
    if (toolName === 'search_web' && args.query) {
      return `"${args.query}"`;
    }

    // Delegation
    if (toolName === 'delegate_task' && args.objective) {
      return args.objective.length > 50 ? args.objective.slice(0, 47) + '…' : args.objective;
    }

    // Generic fallback: show first string value
    for (const key of Object.keys(args)) {
      if (typeof args[key] === 'string' && args[key].length > 0 && args[key].length < 60) {
        return args[key];
      }
    }
  } catch {
    // Not valid JSON, just truncate
    return argsPreview.length > 50 ? argsPreview.slice(0, 47) + '…' : argsPreview;
  }
  return null;
}

// ── Smart result preview ────────────────────────────────────────────────────
function smartResultPreview(toolName: string, resultPreview?: string): string | null {
  if (!resultPreview) return null;
  try {
    const result = typeof resultPreview === 'string' ? JSON.parse(resultPreview) : resultPreview;
    
    if (result?._summary) {
      // "Array of 5 items" → "5 results"
      const countMatch = result._summary.match(/(\d+)\s+items?/);
      if (countMatch) return `${countMatch[1]} results`;
    }
    if (result?.rows && Array.isArray(result.rows)) {
      return `${result.rows.length} rows`;
    }
    if (result?.rowCount != null) {
      return `${result.rowCount} rows updated`;
    }
    if (result?.error) {
      return result.error;
    }
  } catch {
    // Raw string preview
  }
  
  const s = typeof resultPreview === 'string' ? resultPreview : JSON.stringify(resultPreview);
  return s.length > 80 ? s.slice(0, 77) + '…' : s;
}

function formatDuration(ms?: number): string {
  if (ms == null) return '';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function formatElapsed(startedAt: number): string {
  return formatDuration(Date.now() - startedAt);
}

function highlightJson(jsonString: string): React.ReactNode[] {
  const lines = jsonString.split('\n');
  return lines.map((line, idx) => {
    let highlighted = line
      .replace(/(\"(?:[^\"\\]|\\.)*\")(\s*:)/g, '<span class="trace-kw">$1</span>$2')
      .replace(/(:\s*)(\"(?:[^\"\\]|\\.)*\")/g, '$1<span class="trace-str">$2</span>')
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

const ToolTraceItem: React.FC<{ entry: ToolTraceEntry }> = ({ entry }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const display = getToolDisplay(entry.tool);
  const preview = smartPreview(entry.tool, entry.argsPreview);
  const resultText = smartResultPreview(entry.tool, entry.resultPreview);

  const statusClass =
    entry.status === 'running'
      ? 'trace-running'
      : entry.status === 'error'
        ? 'trace-error'
        : 'trace-done';

  const openClass = isOpen ? 'trace-open' : '';
  const hasPayload = entry.argsPreview && entry.argsPreview !== '{}';

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

      <div
        className="trace-tool"
        onClick={() => hasPayload && setIsOpen(!isOpen)}
      >
        <span className="trace-icon">{display.icon}</span>
        <span className="trace-action">
          <span className="trace-verb">{display.verb}</span>{' '}
          {display.label}
        </span>
        {preview && <span className="trace-preview">{preview}</span>}
        {hasPayload && <span className="trace-chev">▾</span>}
      </div>

      <div className="trace-meta">
        {entry.status === 'running' ? (
          <span className="trace-label">
            <span className="trace-spinner" />
            Working…
          </span>
        ) : entry.status === 'error' ? (
          <span className="trace-label">Failed</span>
        ) : (
          <span className="trace-label">Done</span>
        )}

        {resultText && entry.status === 'success' && (
          <span className="trace-result-inline">· {resultText}</span>
        )}

        {entry.elapsedMs != null && (
          <span className="trace-dur">{formatDuration(entry.elapsedMs)}</span>
        )}
      </div>

      {entry.status === 'error' && entry.error && (
        <div className="trace-error-msg">{entry.error}</div>
      )}

      {hasPayload && (
        <div className="trace-payload">
          <div className="trace-code">
            <div className="trace-code-head">
              <span className="trace-code-lang">raw payload</span>
              <span className="trace-code-copy" onClick={handleCopy}>
                {copied ? '✓ copied' : '⧉ copy'}
              </span>
            </div>
            <pre>{highlightJson(entry.argsPreview!)}</pre>
          </div>
        </div>
      )}
    </div>
  );
};

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
