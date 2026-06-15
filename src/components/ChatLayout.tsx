import { type ReactNode, forwardRef } from "react";

type Measure = "narrow" | "default" | "wide";

const MEASURE_MAP: Record<Measure, string> = {
  narrow: "max-w-prose-narrow",
  default: "max-w-prose",
  wide: "max-w-prose-wide",
};

interface ChatLayoutProps {
  children: ReactNode;
  /** Reading measure (line length). Default ~68ch. */
  measure?: Measure;
  className?: string;
}

/**
 * Central chat surface.
 * Linear, single-column flow optimized for long-form AI reading —
 * replaces the legacy multi-column masonry grid.
 */
export const ChatLayout = forwardRef<HTMLDivElement, ChatLayoutProps>(
  ({ children, measure = "default", className = "" }, ref) => {
    return (
      <main
        ref={ref}
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        aria-label="Conversation"
        className="flex flex-1 flex-col items-center overflow-y-auto px-4 py-8 sm:px-6"
      >
        <div
          className={`w-full ${MEASURE_MAP[measure]} flex flex-col gap-msg-gap ${className}`}
        >
          {children}
        </div>
      </main>
    );
  }
);

ChatLayout.displayName = "ChatLayout";

/** A single message block. Body text uses the tuned reading rhythm. */
interface MessageProps {
  children: ReactNode;
  role: "user" | "assistant";
}

export function Message({ children, role }: MessageProps) {
  const isUser = role === "user";
  return (
    <article
      aria-label={isUser ? "Your message" : "Assistant message"}
      className={isUser ? "self-end" : "self-stretch"}
    >
      <div
        className={[
          "t-prose",
          "leading-reading space-y-4",
          isUser
            ? "rounded-2xl bg-slate-100 px-4 py-3 dark:bg-slate-800 text-slate-900 dark:text-slate-100"
            : "text-slate-700 dark:text-slate-300",
        ].join(" ")}
      >
        {children}
      </div>
    </article>
  );
}
