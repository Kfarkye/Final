import React, { useMemo, memo, useState, useCallback } from 'react';
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


// ── Main MimeRenderer ───────────────────────────────────────────────────

const customSanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames || []), 'iframe'],
  attributes: {
    ...defaultSchema.attributes,
    iframe: [
      ['src', /^https:\/\//],
      'srcDoc',
      'title',
      'width',
      'height',
      'className',
      'sandbox',
    ],
  },
} as const;

function decodeBase64UTF8(str: string): string {
  try {
    const cleaned = str.replace(/\s/g, '');
    const binary = atob(cleaned);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    throw new Error('Invalid Base64 or UTF-8 payload');
  }
}

const MimeRendererComponent = memo(function MimeRenderer({
  content,
  className,
  onError,
}: MimeRendererProps) {
  const reportError = (err: unknown, context: string) => {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(`[MimeRenderer] ${context}`, error);
    onError?.(error, context);
  };

  // Data URI handling
  if (content.trim().startsWith('data:')) {
    const match = content.trim().match(/^data:([^;,]+)(?:;([^,]+))?,(.*)$/);
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
            const className = childProps.className || '';
            const lang = /language-(\w+)/.exec(className)?.[1] || '';
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
             const childArray = React.Children.toArray(children);
             const hasDivOrPre = childArray.some((child) => {
               if (React.isValidElement(child)) {
                 if (typeof child.type === 'string') {
                   return child.type === 'div' || child.type === 'pre';
                 }
               }
               return false;
             });
             // Avoid <pre> inside <p> or <div> inside <p> to prevent hydration errors.
             if (hasDivOrPre) {
               return <div className="mb-4 leading-relaxed" {...props}>{children}</div>;
             }
             return <p className="mb-4 leading-relaxed" {...props}>{children}</p>;
          },
          ul({ node, ...props }: any) {
             return <ul className="list-disc pl-6 mb-4 space-y-2 opacity-90" {...props} />
          },
          ol({ node, ...props }: any) {
             return <ol className="list-decimal pl-6 mb-4 space-y-2 opacity-90" {...props} />
          },
          h1({ node, ...props }: any) {
             return <h1 className="text-2xl font-serif font-medium mt-8 mb-4 border-b border-white/10 pb-2" {...props} />
          },
          h2({ node, ...props }: any) {
             return <h2 className="text-xl font-serif font-medium mt-6 mb-3" {...props} />
          },
          h3({ node, ...props }: any) {
             return <h3 className="text-lg font-medium mt-5 mb-2 opacity-90" {...props} />
          }
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});

export { MimeRendererComponent as MimeRenderer };
