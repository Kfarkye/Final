import React, { IframeHTMLAttributes, useState, useEffect, useRef } from 'react';

interface IframeAction {
  label: string;
  icon: string;
  onClick: () => void;
}

interface SecureIframeProps extends IframeHTMLAttributes<HTMLIFrameElement> {
  title: string;
  sandboxOptions?: string[];
  actions?: IframeAction[];
  srcDoc?: string;
}

/**
 * Extract <title> from HTML content for dynamic labeling
 */
function extractTitle(html?: string): string | null {
  if (!html) return null;
  const match = html.match(/<title>(.*?)<\/title>/i);
  return match?.[1]?.trim() || null;
}

export function SecureIframe({ 
  title, 
  sandboxOptions = ['allow-scripts', 'allow-same-origin', 'allow-forms'], 
  className = '',
  actions = [],
  srcDoc,
  ...props 
}: SecureIframeProps) {
  const sandboxConfig = sandboxOptions.join(' ');
  const [expanded, setExpanded] = useState(false);
  const [iframeHeight, setIframeHeight] = useState(520);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Dynamic title: pull from <title> tag, fall back to prop
  const dynamicTitle = extractTitle(srcDoc) || title;

  // Listen for resize messages from the iframe
  useEffect(() => {
    const handleMessage = (e: MessageEvent) => {
      if (e.data?.type === 'resize_html' && e.data?.height) {
        setIframeHeight(Math.max(200, Math.min(e.data.height + 20, expanded ? 2400 : 700)));
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [expanded]);

  // Inject resize observer into srcDoc
  const enhancedSrcDoc = srcDoc ? srcDoc.replace(
    '</body>',
    `<script>
      if (window.ResizeObserver) {
        new ResizeObserver(function() {
          window.parent.postMessage({ type: 'resize_html', height: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight) }, '*');
        }).observe(document.body);
      }
      window.parent.postMessage({ type: 'resize_html', height: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight) }, '*');
    </script></body>`
  ) : undefined;

  return (
    <div className={`relative w-full overflow-hidden rounded-2xl border border-white/[0.08] shadow-2xl bg-[#0B0F19] ${className}`}
         style={{ boxShadow: '0 8px 40px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.04)' }}
    >
      {/* ── Premium Header ── */}
      <div className="px-4 py-2.5 border-b border-white/[0.06] bg-[#0D1117] flex items-center justify-between">
        {/* Left: dots + title */}
        <div className="flex gap-2 items-center min-w-0">
          <div className="flex gap-1.5 mr-2 shrink-0">
            <div className="w-[10px] h-[10px] rounded-full bg-[#FF5F57]" style={{ boxShadow: '0 0 4px rgba(255,95,87,0.3)' }}></div>
            <div className="w-[10px] h-[10px] rounded-full bg-[#FEBC2E]" style={{ boxShadow: '0 0 4px rgba(254,188,46,0.3)' }}></div>
            <div className="w-[10px] h-[10px] rounded-full bg-[#28C840]" style={{ boxShadow: '0 0 4px rgba(40,200,64,0.3)' }}></div>
          </div>
          <span className="text-[11px] font-medium text-white/50 tracking-wide truncate">{dynamicTitle}</span>
        </div>

        {/* Right: actions */}
        <div className="flex gap-1 items-center shrink-0">
          {actions.map((action, i) => (
            <button
              key={i}
              onClick={action.onClick}
              className={`text-[10px] px-2.5 py-1 rounded-md font-medium tracking-wide transition-all duration-200 flex items-center gap-1.5 cursor-pointer active:scale-95 ${
                action.label === 'Deploy' 
                  ? 'bg-blue-500/15 text-blue-400 hover:bg-blue-500/25 border border-blue-500/20 hover:border-blue-500/40'
                  : action.label === 'Deploying…'
                  ? 'bg-amber-500/10 text-amber-400/70 border border-amber-500/15 cursor-wait'
                  : action.label === 'Open Page'
                  ? 'bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 border border-emerald-500/20 hover:border-emerald-500/40'
                  : action.label === 'Failed'
                  ? 'bg-red-500/10 text-red-400 border border-red-500/20'
                  : 'bg-white/[0.04] text-white/40 hover:text-white/70 hover:bg-white/[0.08] border border-white/[0.06]'
              }`}
              title={action.label}
            >
              <span className="text-[11px]">{action.icon}</span>
              <span>{action.label}</span>
            </button>
          ))}

          {/* Expand/collapse */}
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-[10px] px-2 py-1 rounded-md text-white/30 hover:text-white/60 hover:bg-white/[0.06] border border-transparent hover:border-white/[0.06] transition-all duration-200 cursor-pointer active:scale-95"
            title={expanded ? 'Collapse' : 'Expand'}
          >
            {expanded ? '⊟' : '⊞'}
          </button>
        </div>
      </div>

      {/* ── Iframe Content ── */}
      <div 
        className="w-full bg-white transition-all duration-300 ease-out overflow-hidden"
        style={{ height: expanded ? Math.max(iframeHeight, 600) : Math.min(iframeHeight, 520) }}
      >
        <iframe 
          ref={iframeRef}
          title={dynamicTitle}
          sandbox={sandboxConfig}
          loading="lazy"
          referrerPolicy="no-referrer"
          allow="camera 'none'; microphone 'none'; geolocation 'none'; payment 'none'; usb 'none'"
          className="w-full h-full border-none block"
          style={{ colorScheme: 'light' }}
          srcDoc={enhancedSrcDoc}
          {...props} 
        />
      </div>

      {/* ── Bottom accent line ── */}
      <div className="h-[2px] w-full bg-gradient-to-r from-transparent via-blue-500/20 to-transparent" />
    </div>
  );
}
