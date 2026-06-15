import React from 'react';

interface WorkspaceModeToggleProps {
  mode: 'google' | 'git';
  onToggle: (mode: 'google' | 'git') => void;
}

export default function WorkspaceModeToggle({ mode, onToggle }: WorkspaceModeToggleProps) {
  return (
    <div className="px-6 pt-5 pb-1 flex-shrink-0 bg-black flex flex-col gap-3">
      <div className="flex bg-zinc-950 rounded-lg p-0.5 border border-zinc-900 text-[10px] uppercase font-bold tracking-wider">
        <button
          onClick={() => onToggle('git')}
          className={`flex-1 py-1.5 rounded-md transition-all font-sans ${mode === 'git' ? 'bg-zinc-100 text-black font-extrabold shadow-sm' : 'text-zinc-500 hover:text-zinc-300'}`}
        >
          Git Repo
        </button>
        <button
          onClick={() => onToggle('google')}
          className={`flex-1 py-1.5 rounded-md transition-all font-sans ${mode === 'google' ? 'bg-zinc-100 text-black font-extrabold shadow-sm' : 'text-zinc-500 hover:text-zinc-300'}`}
        >
          Google Apps
        </button>
      </div>
    </div>
  );
}
