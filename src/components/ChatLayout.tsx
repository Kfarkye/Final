import React, { useRef, useEffect, useState } from 'react';

interface ChatLayoutProps {
  children: React.ReactNode;
  className?: string;
  isStreaming?: boolean;
  onScrollToBottom?: () => void;
}

export const ChatLayout: React.FC<ChatLayoutProps> = ({ 
  children, 
  className = '',
  isStreaming = false,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);

  // Auto-scroll to bottom when new content arrives (especially during streaming)
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: 'smooth',
      });
    }
  }, [children, isStreaming]);

  // Show "scroll to bottom" button when user scrolls up
  const handleScroll = () => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    const isNearBottom = scrollHeight - scrollTop - clientHeight < 150;
    setShowScrollButton(!isNearBottom);
  };

  const scrollToBottom = () => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: 'smooth',
    });
  };

  return (
    <div className="flex h-screen w-full flex-col bg-background">
      {/* Subtle header for context */}
      <div className="sticky top-0 z-10 border-b border-border bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="mx-auto max-w-chat text-center text-sm text-muted-foreground">
          Truth • Long-form AI Workspace
        </div>
      </div>

      {/* Main Scrollable Chat Area */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-4 pb-24 pt-6 sm:px-6 md:px-8 custom-scrollbar"
      >
        <div 
          className={`
            mx-auto max-w-chat 
            t-prose 
            leading-reading space-y-6
            ${className}
          `}
        >
          {children}
        </div>
      </div>

      {/* Scroll-to-Bottom FAB (appears when scrolled up) */}
      {showScrollButton && (
        <button
          onClick={scrollToBottom}
          className="fixed bottom-24 right-6 z-50 rounded-full bg-primary p-3 text-primary-foreground shadow-lg transition-all hover:scale-105 active:scale-95 cursor-pointer font-bold"
          aria-label="Scroll to bottom"
        >
          ↓
        </button>
      )}

      {/* Sticky Input Bar (Premium UX) */}
      <div className="sticky bottom-0 z-20 border-t border-border bg-background/95 px-4 py-4 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="mx-auto max-w-chat">
          {/* Replace this with your actual input component */}
          <div className="flex items-center gap-2 rounded-2xl border border-border bg-muted px-4 py-3 shadow-sm">
            <input
              type="text"
              placeholder="Ask anything..."
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground text-slate-200"
            />
            <button className="rounded-xl bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 cursor-pointer transition">
              Send
            </button>
          </div>
          <p className="mt-1 text-center text-[10px] text-muted-foreground">
            Responses are optimized for long-form reading
          </p>
        </div>
      </div>
    </div>
  );
};

ChatLayout.displayName = "ChatLayout";

/** A single message block. Body text uses the tuned reading rhythm. */
interface MessageProps {
  children: React.ReactNode;
  role: "user" | "assistant";
}

export const Message: React.FC<MessageProps> = ({ children, role }) => {
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
            ? "rounded-2xl bg-muted px-4 py-3 text-slate-100 border border-border"
            : "text-slate-300",
        ].join(" ")}
      >
        {children}
      </div>
    </article>
  );
};
