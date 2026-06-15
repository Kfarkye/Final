import React from 'react';
import { getFileIcon } from './getFileIcon';

interface FileChipProps {
  id: string;
  name: string;
  size: number;
  type: string;
  onRemove: (id: string) => void;
}

const formatSize = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
};

export const FileChip: React.FC<FileChipProps> = ({ id, name, size, type, onRemove }) => {
  return (
    <div
      className="inline-flex items-center gap-2 pl-2.5 pr-1.5 py-1 rounded-md border border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100/80 dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-200 dark:hover:bg-slate-800/80 transition-all duration-150 shadow-sm max-w-[220px] group select-none"
      role="listitem"
    >
      {/* Dynamic Render Icon */}
      {getFileIcon(type, name)}

      {/* Meta Container */}
      <div className="flex flex-col min-w-0 flex-1 leading-tight">
        <span 
          className="text-xs font-semibold truncate text-slate-800 dark:text-slate-100" 
          title={name}
        >
          {name}
        </span>
        <span className="text-[9px] text-slate-400 dark:text-slate-500 font-medium">
          {formatSize(size)}
        </span>
      </div>

      {/* Delete Trigger */}
      <button
        type="button"
        onClick={() => onRemove(id)}
        className="p-1 rounded text-slate-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/30 transition-all duration-150 focus:outline-none focus:ring-1 focus:ring-rose-500"
        aria-label={`Remove file ${name}`}
      >
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
};
