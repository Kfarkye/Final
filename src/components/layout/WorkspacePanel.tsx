import React from 'react';
import { X } from 'lucide-react';
import { WorkspaceTab } from './ChatComposer';

interface WorkspacePanelProps {
  open: boolean;
  tab: WorkspaceTab;
  onTabChange: (tab: WorkspaceTab) => void;
  onClose: () => void;
  children?: React.ReactNode;
}

export function WorkspacePanel({
  open,
  tab,
  onTabChange,
  onClose,
  children
}: WorkspacePanelProps) {
  return (
    <aside
      className={[
        "flex h-screen flex-col border-l border-zinc-800 bg-zinc-950 transition-all duration-300 ease-in-out shrink-0",
        open ? "w-[400px] translate-x-0 opacity-100" : "w-0 translate-x-full opacity-0 overflow-hidden"
      ].join(" ")}
    >
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-zinc-800 px-5 py-4">
        <h2 className="text-sm font-semibold text-zinc-100">Workspace Tools</h2>
        <button
          onClick={onClose}
          className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 transition-colors"
          aria-label="Close workspace panel"
        >
          <X size={16} />
        </button>
      </div>

      {/* Tabs */}
      <div className="flex shrink-0 border-b border-zinc-800 px-2">
        {(['context', 'compare', 'team'] as const).map((t) => (
          <button
            key={t}
            onClick={() => onTabChange(t)}
            className={[
              "relative px-4 py-2.5 text-xs font-medium capitalize tracking-wider transition-colors",
              tab === t ? "text-zinc-100" : "text-zinc-500 hover:text-zinc-300"
            ].join(" ")}
          >
            {t}
            {tab === t && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-emerald-500" />
            )}
          </button>
        ))}
      </div>

      {/* Content Area */}
      <div className="flex-1 overflow-y-auto bg-zinc-950/50">
        {children}
      </div>
    </aside>
  );
}
