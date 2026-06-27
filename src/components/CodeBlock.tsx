import React, { useState, useCallback } from 'react';
import { copyToClipboard } from '../utils/clipboard';
import { DownloadMenu } from './DownloadMenu';

const EXT_BY_LANG: Record<string, string> = {
  tsx:'tsx', ts:'ts', js:'js', jsx:'jsx', html:'html', css:'css',
  json:'json', python:'py', py:'py', sql:'sql', bash:'sh', sh:'sh',
  yaml:'yaml', yml:'yml', md:'md', java:'java', go:'go', rs:'rs',
};
const MIME_BY_EXT: Record<string, string> = {
  ts:'text/typescript', tsx:'text/typescript', js:'text/javascript',
  jsx:'text/javascript', html:'text/html', css:'text/css',
  json:'application/json', py:'text/x-python', sql:'application/sql',
};

export const CodeBlock: React.FC<{ code: string; lang?: string; children: React.ReactNode }> = ({ code, lang = '', children }) => {
  const [copied, setCopied] = useState(false);
  const ext = EXT_BY_LANG[lang] ?? 'txt';
  const mime = MIME_BY_EXT[ext] ?? 'text/plain';
  const copy = useCallback(async () => {
    try { await copyToClipboard(code); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch {}
  }, [code]);

  return (
    <div className="relative group my-4">
      <div className="absolute right-2 top-2 flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
        {lang && <span className="text-[10px] uppercase tracking-wider text-[var(--t3)] px-1 select-none">{lang}</span>}
        <button onClick={copy} className="text-[11px] font-medium px-2 py-1 rounded-md bg-[var(--s1)] hover:bg-[var(--s2)] text-[var(--t1)]/70 hover:text-[var(--t1)] transition-colors">
          {copied ? '✓ Copied' : 'Copy'}
        </button>
        <DownloadMenu content={code} fileName={`truth-export.${ext}`} mime={mime} tone="code" />
      </div>
      <pre className="bg-[var(--s1)] p-4 rounded-xl overflow-x-auto text-[13px] font-mono">{children}</pre>
    </div>
  );
};
