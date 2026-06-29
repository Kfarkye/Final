import React, { useRef, useEffect } from 'react';
import { useUserPreference } from '../../hooks/useUserPreference';

interface ResizableSidebarProps {
  userId?: string;
  children?: React.ReactNode;
}

export function ResizableSidebar({ userId, children }: ResizableSidebarProps) {
  const [width, setWidth] = useUserPreference('sidebar-width', 260, userId);
  const sidebarRef = useRef<HTMLElement>(null);
  const isDragging = useRef(false);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return;
      // Clamp width between 200px and 400px
      const newWidth = Math.max(200, Math.min(400, e.clientX));
      setWidth(newWidth);
    };

    const handleMouseUp = () => {
      isDragging.current = false;
      document.body.style.cursor = 'default';
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [setWidth]);

  return (
    <aside
      ref={sidebarRef}
      style={{ width: `${width}px` }}
      className="relative flex h-screen flex-shrink-0 flex-col border-r border-zinc-800 bg-zinc-950 transition-[width] duration-75 ease-out"
    >
      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-2">
        {/* Nav Links & Conversations injected via children to keep layout generic */}
        <h2 className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-2">Chats</h2>
        {children}
      </div>

      {/* Drag Handle */}
      <div
        onMouseDown={() => {
          isDragging.current = true;
          document.body.style.cursor = 'col-resize';
        }}
        className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-emerald-500/50 active:bg-emerald-500 transition-colors"
      />
    </aside>
  );
}
