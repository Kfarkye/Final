import React from 'react';
import { Users, FileText, GitCompare, Paperclip, Send } from 'lucide-react';

export type WorkspaceTab = 'compare' | 'context' | 'team';

interface ChatComposerProps {
  activeTab: WorkspaceTab;
  isPanelOpen: boolean;
  onToggleTab: (tab: WorkspaceTab) => void;
  inputVal: string;
  onChange: (val: string) => void;
  onSubmit: () => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  textareaRef?: React.RefObject<HTMLTextAreaElement>;
  isTyping?: boolean;
  attachments?: React.ReactNode;
  onAttachClick?: () => void;
}

export function ChatComposer({
  activeTab,
  isPanelOpen,
  onToggleTab,
  inputVal,
  onChange,
  onSubmit,
  onKeyDown,
  textareaRef,
  isTyping,
  attachments,
  onAttachClick
}: ChatComposerProps) {
  const tools = [
    { id: 'context', label: 'Shared Context', icon: FileText },
    { id: 'compare', label: 'Compare', icon: GitCompare },
    { id: 'team', label: 'Team', icon: Users }
  ] as const;

  return (
    <div className="shrink-0 border-t border-zinc-800 bg-zinc-950/80 p-4 backdrop-blur-md">
      <div className="mx-auto max-w-4xl">
        {/* Progressive Disclosure Triggers */}
        <div className="mb-3 flex items-center gap-2">
          {tools.map((tool) => {
            const Icon = tool.icon;
            const isActive = isPanelOpen && activeTab === tool.id;

            return (
              <button
                key={tool.id}
                onClick={() => onToggleTab(tool.id)}
                className={[
                  "flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-all duration-200",
                  isActive
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                    : "border-zinc-800 bg-zinc-900 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                ].join(" ")}
              >
                <Icon size={14} />
                {tool.label}
              </button>
            );
          })}
        </div>

        <div className="relative">
          <textarea
            ref={textareaRef}
            value={inputVal}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={isTyping}
            className="min-h-[100px] w-full resize-none rounded-xl border border-zinc-800 bg-zinc-900 p-4 pb-12 text-sm text-zinc-100 shadow-sm outline-none transition-colors focus:border-zinc-700 focus:bg-zinc-800/50"
            placeholder="Ask Truth..."
          />
          {attachments && (
            <div className="absolute top-4 right-4 max-w-[50%]">
              {attachments}
            </div>
          )}
          <div className="absolute bottom-3 left-3 flex items-center">
            {onAttachClick && (
              <button
                onClick={onAttachClick}
                className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
                title="Attach file"
              >
                <Paperclip size={18} />
              </button>
            )}
          </div>
          <div className="absolute bottom-3 right-3 flex items-center justify-end">
            <button
              onClick={onSubmit}
              disabled={isTyping || !inputVal.trim()}
              className="rounded-lg flex items-center gap-1.5 bg-white px-4 py-1.5 text-sm font-semibold text-black hover:bg-zinc-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isTyping ? <div className="h-4 w-4 rounded-full border-2 border-black border-t-transparent animate-spin" /> : <Send size={16} />}
              <span>Send</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
