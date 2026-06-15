import React, { useRef, useEffect, useState } from 'react';

interface MessageActionsProps {
  content: string;
  isUser?: boolean;
  onRegenerate?: () => void;
  onEdit?: () => void;
}

const MessageActions: React.FC<MessageActionsProps> = ({ 
  content, 
  isUser = false, 
  onRegenerate, 
  onEdit 
}) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  return (
    <div className="absolute -right-2 top-3 hidden items-center gap-1 rounded-lg border bg-background p-1 shadow-sm group-hover:flex">
      <button
        onClick={handleCopy}
        className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors cursor-pointer"
        aria-label="Copy message"
        title="Copy"
      >
        {copied ? '✓' : '⎘'}
      </button>

      {!isUser && onRegenerate && (
        <button
          onClick={onRegenerate}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors cursor-pointer"
          aria-label="Regenerate response"
          title="Regenerate"
        >
          ⟳
        </button>
      )}

      {isUser && onEdit && (
        <button
          onClick={onEdit}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors cursor-pointer"
          aria-label="Edit message"
          title="Edit"
        >
          ✎
        </button>
      )}
    </div>
  );
};

interface ChatMessageProps {
  content: string;
  isUser?: boolean;
  onRegenerate?: () => void;
  onEdit?: () => void;
}

const ChatMessage: React.FC<ChatMessageProps> = ({ 
  content, 
  isUser = false, 
  onRegenerate, 
  onEdit 
}) => {
  return (
    <div className="group relative">
      <div 
        className={`
          rounded-2xl px-6 py-5 
          ${isUser 
            ? 'bg-primary text-primary-foreground ml-auto max-w-[85%]' 
            : 'bg-muted'
          }
        `}
      >
        <div className="prose prose-neutral dark:prose-invert leading-relaxed">
          {content}
        </div>
      </div>

      <MessageActions 
        content={content} 
        isUser={isUser} 
        onRegenerate={onRegenerate} 
        onEdit={onEdit} 
      />
    </div>
  );
};

interface ChatLayoutProps {
  children?: React.ReactNode;
  className?: string;
  isStreaming?: boolean;
  messages?: Array<{
    id: string;
    content: string;
    isUser: boolean;
  }>;
  onRegenerate?: (messageId: string) => void;
  onEdit?: (messageId: string) => void;
}

export const ChatLayout: React.FC<ChatLayoutProps> = ({ 
  children,
  className = '',
  isStreaming = false,
  messages = [],
  onRegenerate,
  onEdit,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);

  // Auto-scroll behavior (especially during streaming)
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: 'smooth',
      });
    }
  }, [messages, children, isStreaming]);

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
      {/* Subtle Header */}
      <div className="sticky top-0 z-10 border-b bg-background/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto max-w-chat text-center text-sm text-muted-foreground">
          Truth • Long-form AI Workspace
        </div>
      </div>

      {/* Scrollable Message Area */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-4 pb-28 pt-8 sm:px-6 md:px-8"
      >
        <div className={`mx-auto max-w-chat space-y-6 ${className}`}>
          {messages.length > 0 ? (
            messages.map((msg) => (
              <ChatMessage
                key={msg.id}
                content={msg.content}
                isUser={msg.isUser}
                onRegenerate={onRegenerate ? () => onRegenerate(msg.id) : undefined}
                onEdit={onEdit ? () => onEdit(msg.id) : undefined}
              />
            ))
          ) : (
            children
          )}
        </div>
      </div>

      {/* Scroll to Bottom Button */}
      {showScrollButton && (
        <button
          onClick={scrollToBottom}
          className="fixed bottom-28 right-6 z-50 flex h-10 w-10 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-all hover:scale-105 active:scale-95 cursor-pointer"
          aria-label="Scroll to bottom"
        >
          ↓
        </button>
      )}

      {/* Sticky Input Bar */}
      <div className="sticky bottom-0 z-20 border-t bg-background/95 px-4 py-4 backdrop-blur">
        <div className="mx-auto max-w-chat">
          <div className="flex items-center gap-2 rounded-2xl border bg-muted px-4 py-3 shadow-sm">
            <input
              type="text"
              placeholder="Ask anything..."
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
            <button className="rounded-xl bg-primary px-5 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 cursor-pointer">
              Send
            </button>
          </div>
          <p className="mt-1.5 text-center text-[10px] text-muted-foreground">
            Optimized for deep, readable responses
          </p>
        </div>
      </div>
    </div>
  );
};
