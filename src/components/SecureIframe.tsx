import React, { IframeHTMLAttributes, useState, useEffect, useRef } from 'react';

interface IframeAction {
  label: string;
  icon: string;
  onClick: () => void;
}

interface SecureIframeProps extends IframeHTMLAttributes<HTMLIFrameElement> {
  src?: string;
  className?: string;
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

      // ── Fetch Proxy Handler ──
      // When the iframe sends a fetch_proxy request, we perform the actual fetch
      // from the parent context (same-origin) and send the result back.
      if (e.data?.type === 'fetch_proxy' && e.data?.requestId && iframeRef.current?.contentWindow) {
        const { requestId, url, method, headers, body } = e.data;
        window.fetch(url, { method, headers, body: body || undefined })
          .then(async (res) => {
            const responseBody = await res.json().catch(() => ({}));
            iframeRef.current?.contentWindow?.postMessage({
              type: 'fetch_proxy_response',
              requestId,
              status: res.status,
              body: responseBody,
            }, '*');
          })
          .catch((err) => {
            iframeRef.current?.contentWindow?.postMessage({
              type: 'fetch_proxy_response',
              requestId,
              error: err.message,
            }, '*');
          });
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [expanded]);

  // Inject resize observer + fetch bridge into srcDoc
  // srcDoc iframes have an opaque (null) origin, so fetch('/api/...') always fails.
  // This bridge lets the iframe call window.parent.postMessage({ type: 'fetch_proxy', ... })
  // and the parent (which IS same-origin) performs the actual fetch and sends the result back.
  const enhancedSrcDoc = srcDoc ? srcDoc.replace(
    '</body>',
    `<script>
      // ── Resize Observer ──
      if (window.ResizeObserver) {
        new ResizeObserver(function() {
          window.parent.postMessage({ type: 'resize_html', height: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight) }, '*');
        }).observe(document.body);
      }
      window.parent.postMessage({ type: 'resize_html', height: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight) }, '*');

      // ── Fetch Proxy Bridge ──
      // Overrides window.fetch so that relative URL calls (e.g. fetch('/api/models'))
      // are forwarded to the parent window, which performs the real fetch.
      (function() {
        var _nativeFetch = window.fetch;
        var _pendingRequests = {};
        var _requestId = 0;

        window.addEventListener('message', function(e) {
          if (e.data && e.data.type === 'fetch_proxy_response' && _pendingRequests[e.data.requestId]) {
            var pending = _pendingRequests[e.data.requestId];
            delete _pendingRequests[e.data.requestId];
            if (e.data.error) {
              pending.reject(new Error(e.data.error));
            } else {
              pending.resolve(new Response(JSON.stringify(e.data.body), {
                status: e.data.status || 200,
                headers: { 'Content-Type': 'application/json' }
              }));
            }
          }
        });

        window.fetch = function(url, opts) {
          // Only proxy relative URLs and same-origin API calls
          if (typeof url === 'string' && (url.startsWith('/') || url.startsWith(window.location.origin))) {
            var id = ++_requestId;
            return new Promise(function(resolve, reject) {
              _pendingRequests[id] = { resolve: resolve, reject: reject };
              window.parent.postMessage({
                type: 'fetch_proxy',
                requestId: id,
                url: url,
                method: (opts && opts.method) || 'GET',
                headers: (opts && opts.headers) || {},
                body: (opts && opts.body) || null
              }, '*');
            });
          }
          return _nativeFetch.apply(this, arguments);
        };
      })();
    </script></body>`
  ) : undefined;

  return (
    <div className={`relative w-full overflow-hidden rounded-2xl border border-[var(--b1)] shadow-2xl bg-[#0B0F19] ${className}`}
         style={{ boxShadow: '0 8px 40px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.04)' }}
    >
      {/* ── Premium Header ── */}
      <div className="px-4 py-2.5 border-b border-[var(--b1)] bg-[#0D1117] flex items-center justify-between">
        {/* Left: dots + title */}
        <div className="flex gap-2 items-center min-w-0">
          <div className="flex gap-1.5 mr-2 shrink-0">
            <div className="w-[10px] h-[10px] rounded-full bg-[#FF5F57]" style={{ boxShadow: '0 0 4px rgba(255,95,87,0.3)' }}></div>
            <div className="w-[10px] h-[10px] rounded-full bg-[#FEBC2E]" style={{ boxShadow: '0 0 4px rgba(254,188,46,0.3)' }}></div>
            <div className="w-[10px] h-[10px] rounded-full bg-[#28C840]" style={{ boxShadow: '0 0 4px rgba(40,200,64,0.3)' }}></div>
          </div>
          <span className="text-[11px] font-medium text-[var(--t2)] tracking-wide truncate">{dynamicTitle}</span>
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
                  : 'bg-[var(--s1)] text-[var(--t3)] hover:text-[var(--t1)]/70 hover:bg-[var(--s1)] border border-[var(--b1)]'
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
            className="text-[10px] px-2 py-1 rounded-md text-[var(--t1)]/30 hover:text-[var(--t2)] hover:bg-[var(--s1)] border border-transparent hover:border-[var(--b1)] transition-all duration-200 cursor-pointer active:scale-95"
            title={expanded ? 'Collapse' : 'Expand'}
          >
            {expanded ? '⊟' : '⊞'}
          </button>
        </div>
      </div>

      {/* ── Iframe Content ── */}
      <div 
        className="w-full bg-[var(--t1)] transition-all duration-300 ease-out overflow-hidden"
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
