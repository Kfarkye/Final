import React from 'react';

interface WorkspaceModeToggleProps {
  mode: 'google' | 'git';
  onToggle: (mode: 'google' | 'git') => void;
}

export default function WorkspaceModeToggle({ mode, onToggle }: WorkspaceModeToggleProps) {
  return (
    <div className="px-6 pt-5 pb-1 flex-shrink-0 bg-black flex flex-col gap-3">
      <div className="flex bg-[var(--s2)] rounded-lg p-0.5 border border-[var(--b1)] text-[10px] uppercase font-bold tracking-wider">
        <button
          onClick={() => onToggle('git')}
          className={`flex-1 py-1.5 rounded-md transition-all font-sans ${mode === 'git' ? 'bg-[var(--t-text-primary)] text-[var(--bg)] font-extrabold shadow-sm' : 'text-[var(--t4)] hover:text-[var(--t3)]'}`}
        >
          Git Repo
        </button>
        <button
          onClick={() => onToggle('google')}
          className={`flex-1 py-1.5 rounded-md transition-all font-sans ${mode === 'google' ? 'bg-[var(--t-text-primary)] text-[var(--bg)] font-extrabold shadow-sm' : 'text-[var(--t4)] hover:text-[var(--t3)]'}`}
        >
          Google Apps
        </button>
      </div>
    </div>
  );
}
