import React, { useMemo, memo, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import { SecureIframe } from './SecureIframe';
import { TruthArtifactPreview } from './TruthArtifactPreview';
import { MlbOddsDashboard } from './MlbOddsDashboard';

interface MimeRendererProps {
  content: string;
  className?: string;
  onError?: (error: Error, context: string) => void;
}

const DEFAULT_SANDBOX: string[] = ['allow-scripts', 'allow-forms', 'allow-popups'];

// ── Sanitize schema ─────────────────────────────────────────────────────
// FIX #1: iframe is allowed ONLY with an https src. `srcDoc` is intentionally
// NOT permitted — it executes arbitrary markup inside the frame and is a real
// XSS surface even with sandboxing. `sandbox` is NOT author-controllable here;
// it is always enforced by SecureIframe at render time.
const customSanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames || []), 'iframe'],
  attributes: {
    ...defaultSchema.attributes,
    iframe: [
      ['src', /^https:\/\//],
      'title',
      'width',
      'height',
      'className',
      // 'srcDoc' removed — do not allow inline iframe documents.
      // 'sandbox' removed — enforced by SecureIframe, never trusted from input.
    ],
  },
} as const;

// ── Base64 helpers ──────────────────────────────────────────────────────
// FIX #3: handle both standard base64 and URL-safe base64 (-, _) + repadding.
export function normalizeBase64(input: string): string {
  let s = input.replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const remainder = s.length % 4;
  if (remainder === 2) s += '==';
  else if (remainder === 3) s += '=';
  else if (remainder === 1) throw new Error('Invalid Base64 length');
  return s;
}

export function decodeBase64UTF8(str: string): string {
  try {
    const cleaned = normalizeBase64(str);
    const binary = atob(cleaned);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    throw new Error('Invalid Base64 or UTF-8 payload');
  }
}

// FIX #2: matches multi-line payloads ([\s\S] instead of .) so base64 blobs
// containing newlines are parsed instead of rejected.
export const DATA_URI_RE = /^data:([^;,]+)(?:;([^,]+))?,([\s\S]*)$/;

// FIX #4: only auto-fence content that is unambiguously a serialized JSON
// object/array (multi-line or structurally nested). A flat single-line array
// like [1,2,3] from ordinary user text is left untouched to avoid surprising
// reformatting.
export function maybeWrapJson(content: string): string {
  const trimmed = content.trim();
  const looksWrapped =
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'));
  if (!looksWrapped) return content;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return content; // not valid JSON
  }

  // Only reformat when it's genuinely structured: an object, or an array/object
  // that is either multi-line or contains nested structures. This keeps short
  // inline arrays (e.g. "[1,2,3]") as plain text.
  const isStructured =
    (typeof parsed === 'object' && parsed !== null) &&
    (trimmed.includes('\n') ||
      Object.values(parsed as Record<string, unknown>).some(
        (v) => typeof v === 'object' && v !== null,
      ));

  return isStructured ? '```json\n' + trimmed + '\n```' : content;
}

// ── Hydration helper ────────────────────────────────────────────────────
// FIX #5: recursively detect block-level descendants so we never render a
// <div>/<pre> (incl. artifact previews surfaced via pre()) inside a <p>.
export function containsBlockDescendant(children: React.ReactNode): boolean {
  return React.Children.toArray(children).some((child) => {
    if (!React.isValidElement(child)) return false;
    if (typeof child.type === 'string' && (child.type === 'div' || child.type === 'pre')) {
      return true;
    }
    const grandChildren = (child.props as any)?.children;
    return grandChildren ? containsBlockDescendant(grandChildren) : false;
  });
}

// ── Main MimeRenderer ───────────────────────────────────────────────────
const MimeRendererComponent = memo(function MimeRenderer({
  content,
  className,
  onError,
}: MimeRendererProps) {
  const reportError = useCallback(
    (err: unknown, context: string) => {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(`[MimeRenderer] ${context}`, error);
      onError?.(error, context);
    },
    [onError],
  );

  // Data URI handling
  if (content.trim().startsWith('data:')) {
    const match = content.trim().match(DATA_URI_RE);
    if (!match) {
      return <div className="text-red-500 text-xs p-3">Invalid data URI</div>;
    }

    const mimeType = match[1];
    const isBase64 = (match[2] || '').toLowerCase().includes('base64');
    const rawData = match[3];

    const getDecoded = (): string => {
      try {
        return isBase64 ? decodeBase64UTF8(rawData) : decodeURIComponent(rawData);
      } catch (e) {
        reportError(e, 'decode');
        throw e;
      }
    };

    try {
      if (mimeType === 'application/vnd.google-apps.mail') {
        const email = JSON.parse(getDecoded());
        const date = !isNaN(parseInt(email.date))
          ? new Date(parseInt(email.date)).toLocaleString()
          : '';

        return (
          <div className="w-full bg-white text-zinc-900 overflow-hidden rounded-xl border shadow-xl my-6">
            <div className="bg-zinc-100 px-5 py-4 border-b">
              <div className="font-serif text-xl font-medium">{email.subject}</div>
              <div className="text-sm text-zinc-600 flex justify-between mt-3">
                <span>From: <span className="font-medium text-zinc-800">{email.from}</span></span>
                {date && <span className="text-xs text-zinc-500">{date}</span>}
              </div>
            </div>
            <div className="p-6 text-sm whitespace-pre-wrap">{email.snippet}</div>
            <div className="bg-zinc-50 px-5 py-3 border-t flex justify-end">
              <a
                href={`https://mail.google.com/mail/u/0/#inbox/${encodeURIComponent(email.id || '')}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs font-semibold uppercase tracking-wider text-blue-600"
              >
                Open in Gmail →
              </a>
            </div>
          </div>
        );
      }

      if (mimeType.startsWith('application/vnd.google-apps.')) {
        const doc = JSON.parse(getDecoded());
        return (
          <div className="my-6 w-full space-y-3">
            <div className="text-xs font-semibold uppercase tracking-wider bg-zinc-900/50 p-2.5 rounded inline-flex">
              {doc.name}
            </div>
            <SecureIframe
              src={doc.link}
              title={doc.name}
              sandboxOptions={['allow-scripts', 'allow-same-origin', 'allow-popups', 'allow-forms']}
            />
          </div>
        );
      }

      if (mimeType.startsWith('image/')) return <img src={content.trim()} alt="" className="max-w-full rounded-lg" />;
      if (mimeType.startsWith('video/')) return <video controls src={content.trim()} className="max-w-full rounded-lg" />;
      if (mimeType.startsWith('audio/')) return <audio controls src={content.trim()} className="w-full" />;

      return (
        <div className="my-6">
          <SecureIframe src={content.trim()} title="MIME File" sandboxOptions={DEFAULT_SANDBOX} />
        </div>
      );
    } catch (e) {
      reportError(e, 'mime-render');
      return <div className="text-red-500 text-xs p-3 border border-red-500/20 rounded">Failed to render content</div>;
    }
  }

  // Markdown path
  const finalContent = useMemo(() => maybeWrapJson(content), [content]);

  return (
    <div className={`markdown-body w-full ${className || ''}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, customSanitizeSchema]]}
        components={{
          pre({ node, children, ...props }: any) {
            const childArray = React.Children.toArray(children);
            const first = childArray[0] as React.ReactElement;
            const childProps = (first?.props as any) || {};
            const cls = childProps.className || '';
            const lang = /language-([\w-]+)/.exec(cls)?.[1] || '';
            const codeContent = String(childProps.children || '').replace(/\n$/, '');

            if (lang === 'html' || lang === 'iframe') {
              return <TruthArtifactPreview html={codeContent} />;
            }
            if (lang === 'mlb-odds-dashboard') {
              return <MlbOddsDashboard />;
            }
            return (
              <pre className="bg-white/5 p-4 rounded-xl overflow-x-auto text-[13px] font-mono my-4" {...props}>
                {first}
              </pre>
            );
          },
          code({ className, children, ...props }: any) {
            const isBlock = props['data-is-block'];
            return isBlock ? (
              <code className={className} {...props}>{children}</code>
            ) : (
              <code className={`bg-white/10 rounded px-1.5 py-0.5 text-[0.85em] font-mono ${className || ''}`} {...props}>
                {children}
              </code>
            );
          },
          iframe(props: any) {
            return (
              <div className="my-6">
                <SecureIframe {...props} sandboxOptions={DEFAULT_SANDBOX} />
              </div>
            );
          },
          a: (props) => <a target="_blank" rel="noopener noreferrer" className="text-blue-400 underline" {...props} />,
          p({ node, children, ...props }: any) {
            // FIX #5: recursive block-descendant check avoids <div>/<pre> in <p>.
            if (containsBlockDescendant(children)) {
              return <div className="mb-4 leading-relaxed" {...props}>{children}</div>;
            }
            return <p className="mb-4 leading-relaxed" {...props}>{children}</p>;
          },
          ul: ({ node, ...props }: any) => <ul className="list-disc pl-6 mb-4 space-y-2 opacity-90" {...props} />,
          ol: ({ node, ...props }: any) => <ol className="list-decimal pl-6 mb-4 space-y-2 opacity-90" {...props} />,
          h1: ({ node, ...props }: any) => <h1 className="text-2xl font-serif font-medium mt-8 mb-4 border-b border-white/10 pb-2" {...props} />,
          h2: ({ node, ...props }: any) => <h2 className="text-xl font-serif font-medium mt-6 mb-3" {...props} />,
          h3: ({ node, ...props }: any) => <h3 className="text-lg font-medium mt-5 mb-2 opacity-90" {...props} />,
        }}
      >
        {finalContent}
      </ReactMarkdown>
    </div>
  );
});

export { MimeRendererComponent as MimeRenderer };
