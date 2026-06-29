import React, { useRef, useEffect, useState, useCallback, memo } from 'react';
import { copyToClipboard } from '../utils/clipboard';
import { Copy, Check, RotateCw, Edit2, ArrowDown } from 'lucide-react';

interface MessageActionsProps {
  content: string;
  isUser?: boolean;
  onRegenerate?: () => void;
  onEdit?: () => void;
}

const MessageActions: React.FC<MessageActionsProps> = memo(({ 
  content, 
  isUser = false, 
  onRegenerate, 
  onEdit 
}) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await copyToClipboard(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  return (
    <div className="absolute -right-2 top-3 hidden items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-950 p-1 shadow-sm group-hover:flex">
      <button
        onClick={handleCopy}
        className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300 transition-colors cursor-pointer"
        aria-label="Copy message"
        title="Copy"
      >
        {copied ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
      </button>

      {!isUser && onRegenerate && (
        <button
          onClick={onRegenerate}
          className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300 transition-colors cursor-pointer"
          aria-label="Regenerate response"
          title="Regenerate"
        >
          <RotateCw size={14} />
        </button>
      )}

      {isUser && onEdit && (
        <button
          onClick={onEdit}
          className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300 transition-colors cursor-pointer"
          aria-label="Edit message"
          title="Edit"
        >
          <Edit2 size={14} />
        </button>
      )}
    </div>
  );
});

MessageActions.displayName = 'MessageActions';

interface ChatMessageProps {
  content: string;
  isUser?: boolean;
  onRegenerate?: () => void;
  onEdit?: () => void;
}

const ChatMessage: React.FC<ChatMessageProps> = memo(({ 
  content, 
  isUser = false, 
  onRegenerate, 
  onEdit 
}) => {
  return (
    <div className="group relative animate-in fade-in slide-in-from-bottom-2 duration-300">
      <div 
        className={`
          rounded-2xl px-6 py-5 
          ${isUser 
            ? 'bg-zinc-100 text-black ml-auto max-w-[85%]' 
            : 'bg-zinc-900/50 border border-zinc-800/50 text-zinc-200 max-w-full'
          }
        `}
      >
        <div className="prose prose-neutral dark:prose-invert max-w-none leading-relaxed text-sm whitespace-pre-wrap">
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
});

ChatMessage.displayName = 'ChatMessage';

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
  inputArea?: React.ReactNode; // Replaced dead input with a layout slot
}

export const ChatLayout: React.FC<ChatLayoutProps> = ({ 
  children,
  className = '',
  isStreaming = false,
  messages = [],
  onRegenerate,
  onEdit,
  inputArea
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);
  
  // Track intentional user scroll to prevent violent yanking during streaming
  const isUserScrolledUp = useRef(false);

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    
    const isNearBottom = distanceFromBottom < 40; // 40px buffer
    isUserScrolledUp.current = !isNearBottom;
    setShowScrollButton(!isNearBottom);
  }, []);

  // Auto-scroll behavior
  useEffect(() => {
    if (scrollRef.current && !isUserScrolledUp.current) {
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        // Use instant scroll during rapid streaming to prevent animation queue lag/thrashing
        behavior: isStreaming ? 'auto' : 'smooth',
      });
    }
  }, [messages, isStreaming]);

  const scrollToBottom = () => {
    isUserScrolledUp.current = false;
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: 'smooth',
    });
  };

  return (
    <div className="flex h-screen w-full flex-col bg-black text-zinc-100 selection:bg-zinc-800 selection:text-white font-sans">
      {/* Subtle Header */}
      <div className="sticky top-0 z-10 border-b border-zinc-900 bg-black/80 px-4 py-3 backdrop-blur-xl">
        <div className="mx-auto max-w-4xl flex items-center justify-between text-xs text-zinc-500 font-medium tracking-wide">
          <span className="flex items-center gap-2 text-zinc-300">
            <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
            Truth Workspace
          </span>
          <span>Optimized for deep, readable responses</span>
        </div>
      </div>

      {/* Scrollable Message Area */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-4 pb-32 pt-8 sm:px-6 md:px-8 scroll-smooth"
      >
        <div className={`mx-auto max-w-4xl space-y-8 ${className}`}>
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
      <div className={`fixed bottom-28 right-6 z-50 transition-all duration-300 ${showScrollButton ? 'opacity-100 translate-y-0 pointer-events-auto' : 'opacity-0 translate-y-4 pointer-events-none'}`}>
        <button
          onClick={scrollToBottom}
          className="flex h-10 w-10 items-center justify-center rounded-full bg-zinc-900 border border-zinc-800 text-zinc-300 shadow-xl transition-all hover:bg-zinc-800 hover:text-white active:scale-95 cursor-pointer"
          aria-label="Scroll to bottom"
        >
          <ArrowDown size={18} />
        </button>
      </div>

      {/* Input Area Slot */}
      <div className="absolute bottom-0 w-full z-20 bg-gradient-to-t from-black via-black to-transparent pt-12 pb-6 px-4 pointer-events-none">
        <div className="mx-auto max-w-4xl pointer-events-auto">
          {inputArea || (
            <div className="p-4 border border-zinc-800 border-dashed rounded-2xl bg-zinc-950/50 text-center text-xs text-zinc-600 font-mono">
              // ChatLayout expected an inputArea prop here
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
