/**
 * TOOL TRACE — Agentic Invocation Log
 * 
 * Renders a Clearspace-style timeline of tool calls with:
 * - Pulsing nodes (running), solid green (done), red (error)
 * - Vertical connector lines between calls
 * - Expandable JSON payloads with syntax highlighting
 * - Duration badges and result previews
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

function formatDuration(ms?: number): string {
  if (ms == null) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function highlightJson(jsonString: string): React.ReactNode[] {
  const lines = jsonString.split('\n');
  return lines.map((line, idx) => {
    let highlighted = line
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

/** Translates raw tool name + args into natural language + optional link */
function translateTool(tool: string, argsPreview?: string): { label: string; link?: string } {
  let args: any = {};
  try { if (argsPreview) args = JSON.parse(argsPreview); } catch {}

  switch (tool) {
    case 'execute_sql': {
      const sql = (args.sql || '').trim();
      const table = sql.match(/(?:FROM|UPDATE|INTO|JOIN)\s+(\w+)/i)?.[1];
      if (table) {
        if (/^\s*SELECT/i.test(sql)) return { label: `Pulling up ${table}` };
        if (/^\s*UPDATE/i.test(sql)) return { label: `Updating ${table}` };
        if (/^\s*INSERT/i.test(sql)) return { label: `Adding to ${table}` };
        if (/^\s*DELETE/i.test(sql)) return { label: `Cleaning up ${table}` };
      }
      return { label: 'Looking something up' };
    }
    case 'describe_spanner_table':
      return { label: `Checking ${args.tableName || 'table'} structure` };
    case 'get_full_schema':
      return { label: 'Getting the lay of the land' };
    case 'get_database_ddl':
      return { label: 'Mapping out the database' };
    case 'search_web':
      return { label: `Looking up "${args.query || ''}"` };
    case 'fetch_html':
    case 'fetch_markdown':
    case 'fetch_readable':
    case 'fetch_text':
    case 'extract_page': {
      const url = args.url || args.urls?.[0] || '';
      try {
        const hostname = new URL(url).hostname.replace('www.', '');
        return { label: `Checking ${hostname}`, link: url };
      } catch {
        return { label: 'Reading a page' };
      }
    }
    case 'fetch_json':
    case 'http_request': {
      const url = args.url || '';
      try {
        const hostname = new URL(url).hostname.replace('www.', '');
        return { label: `Hitting ${hostname}`, link: url };
      } catch {
        return { label: 'Grabbing some data' };
      }
    }
    case 'write_file': {
      const name = (args.filePath || args.path || '').split('/').pop() || 'a file';
      return { label: `Writing ${name}` };
    }
    case 'edit_file': {
      const name = (args.filePath || args.path || '').split('/').pop() || 'a file';
      return { label: `Tweaking ${name}` };
    }
    case 'read_file': {
      const name = (args.filePath || args.path || '').split('/').pop() || 'a file';
      return { label: `Reading ${name}` };
    }
    case 'exec_command':
    case 'run_script': {
      const cmd = args.command || args.script || '';
      const short = cmd.length > 40 ? cmd.slice(0, 37) + '…' : cmd;
      return { label: short ? `Running ${short}` : 'Running something' };
    }
    case 'get_mlb_odds':
      return { label: 'Grabbing the latest odds' };
    case 'get_live_scores':
      return { label: 'Checking the scores' };
    case 'get_mlb_schedule':
      return { label: 'Pulling up the schedule' };
    case 'delegate_task':
      return { label: `Handing off: ${(args.objective || '').slice(0, 40)}` };
    case 'request_human_secret':
      return { label: 'Need a credential from you' };
    case 'list_instances':
      return { label: 'Scanning cloud instances' };
    case 'list_databases':
      return { label: 'Checking available databases' };
    default:
      return { label: tool.replace(/_/g, ' ') };
  }
}

const ToolTraceItem: React.FC<{ entry: ToolTraceEntry }> = ({ entry }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const { label, link } = translateTool(entry.tool, entry.argsPreview);

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
        onClick={() => setIsOpen(!isOpen)}
      >
        {label}
        {link && (
          <a
            className="trace-link"
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
          >↗</a>
        )}
        {entry.elapsedMs != null && (
          <span className="trace-dur">{formatDuration(entry.elapsedMs)}</span>
        )}
        <span className="trace-chev">▾</span>
      </div>

      {/* Everything below is progressive disclosure */}
      <div className="trace-payload">
        <div className="trace-meta">
          <span className="trace-label">
            {entry.status === 'running'
              ? 'running'
              : entry.status === 'error'
                ? 'failed'
                : 'completed'}
          </span>
        </div>

        {entry.status === 'error' && entry.error && (
          <div className="trace-error-msg">{entry.error}</div>
        )}

        {entry.status === 'success' && entry.resultPreview && (
          <div className="trace-result-preview" title={entry.resultPreview}>
            → {entry.resultPreview.length > 120
              ? entry.resultPreview.slice(0, 120) + '…'
              : entry.resultPreview}
          </div>
        )}

        {hasPayload && (
          <div className="trace-code">
            <div className="trace-code-head">
              <span className="trace-code-lang">json</span>
              <span className="trace-code-copy" onClick={handleCopy}>
                {copied ? '✓ copied' : '⧉ copy'}
              </span>
            </div>
            <pre>{highlightJson(entry.argsPreview!)}</pre>
          </div>
        )}
      </div>
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
