import React from 'react';
import { ResizableSidebar } from './ResizableSidebar';
import { ChatComposer, WorkspaceTab } from './ChatComposer';
import { WorkspacePanel } from './WorkspacePanel';

interface AppLayoutProps {
  userId?: string;
  headerContent?: React.ReactNode;
  sidebarContent: React.ReactNode;
  children: React.ReactNode; // The main message feed
  composerProps: React.ComponentProps<typeof ChatComposer>;
  workspaceContent: React.ReactNode;
  isPanelOpen: boolean;
  activeTab: WorkspaceTab;
  onTabChange: (tab: WorkspaceTab) => void;
  onClosePanel: () => void;
}

export function AppLayout({
  userId,
  headerContent,
  sidebarContent,
  children,
  composerProps,
  workspaceContent,
  isPanelOpen,
  activeTab,
  onTabChange,
  onClosePanel
}: AppLayoutProps) {
  return (
    <div className="flex h-screen w-full overflow-hidden bg-black text-zinc-100 font-sans">
      {/* Left Sidebar (Adjustable & Persistent) */}
      <ResizableSidebar userId={userId}>
        {sidebarContent}
      </ResizableSidebar>

      {/* Center Chat Area */}
      <main className="flex min-w-0 flex-1 flex-col relative bg-[#0a0a0f]">
        {/* Ambient depth */}
        <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden" aria-hidden="true">
          <div className="absolute -top-[40%] -left-[20%] w-[60vw] h-[60vw] rounded-full bg-[var(--t1)]/[0.015] blur-[120px]" />
          <div className="absolute -bottom-[30%] -right-[10%] w-[50vw] h-[50vw] rounded-full bg-[var(--t1)]/[0.01] blur-[120px]" />
        </div>

        {/* Header */}
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-zinc-800 bg-zinc-950/80 px-4 backdrop-blur-md relative z-10">
          {headerContent || <h1 className="text-sm font-semibold">Project Alpha</h1>}
        </header>

        {/* Message Feed */}
        <div className="flex-1 overflow-y-auto p-4 relative z-10 scroll-smooth">
          {children}
        </div>

        {/* Composer with Progressive Disclosure Triggers */}
        <div className="relative z-10">
          <ChatComposer {...composerProps} />
        </div>
      </main>

      {/* Right Workspace Panel (Persistent) */}
      <WorkspacePanel
        open={isPanelOpen}
        tab={activeTab}
        onTabChange={onTabChange}
        onClose={onClosePanel}
      >
        {workspaceContent}
      </WorkspacePanel>
    </div>
  );
}
