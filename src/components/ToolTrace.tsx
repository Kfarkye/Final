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

const ToolTraceItem: React.FC<{ entry: ToolTraceEntry }> = ({ entry }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [copied, setCopied] = useState(false);

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
        <span className="trace-verb">call</span>
        {entry.tool}
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
