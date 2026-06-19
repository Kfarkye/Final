import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useLocalSave } from './attachments/useLocalSave';
import { useDriveSave } from './attachments/useDriveSave';

interface DownloadMenuProps { content: string; fileName: string; mime?: string; tone?: 'toolbar' | 'code'; }

export const DownloadMenu: React.FC<DownloadMenuProps> = ({ content, fileName, mime = 'text/plain', tone = 'toolbar' }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const local = useLocalSave();
  const drive = useDriveSave();

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onEsc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc); document.addEventListener('keydown', onEsc);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onEsc); };
  }, [open]);

  const toComputer = useCallback(async () => { setOpen(false); await local.saveText({ content, fileName, mime }); }, [local, content, fileName, mime]);
  const toDrive = useCallback(async () => { setOpen(false); await drive.saveToDrive({ content, fileName, mime }); }, [drive, content, fileName, mime]);

  const busy = local.state === 'saving' || drive.state === 'saving';
  const saved = local.state === 'saved' || drive.state === 'saved';
  const btnBase = 'text-[10px] px-2.5 py-1 rounded-md font-medium tracking-wide transition-all duration-200 flex items-center gap-1.5 cursor-pointer active:scale-95';
  const btnGhost = tone === 'toolbar'
    ? `${btnBase} bg-white/[0.04] text-white/40 hover:text-white/70 hover:bg-white/[0.08] border border-white/[0.06]`
    : 'text-[11px] font-medium px-2 py-1 rounded-md bg-white/5 hover:bg-white/10 text-white/70 hover:text-white transition-colors flex items-center gap-1.5';

  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen(v => !v)} disabled={busy} className={`${btnGhost} disabled:opacity-50`} title="Download" aria-haspopup="menu" aria-expanded={open}>
        <span>{busy ? '…' : saved ? '✓' : '⬇️'}</span>
        <span>{busy ? 'Saving' : saved ? 'Saved' : 'Download'}</span>
        <span className="opacity-50 text-[8px]">▾</span>
      </button>
      {open && (
        <div role="menu" className="absolute right-0 mt-1 z-50 min-w-[168px] rounded-lg border border-white/[0.08] bg-[#0D1117] shadow-2xl py-1 animate-[slidein_0.18s_ease]">
          <button role="menuitem" onClick={toComputer} className="w-full text-left text-[11px] px-3 py-2 text-white/70 hover:text-white hover:bg-white/[0.06] transition-colors flex items-center gap-2.5">
            <span>💻</span><span className="flex-1">To computer</span>
            {local.supportsFsAccess && <span className="text-[9px] text-white/30">choose folder</span>}
          </button>
          <button role="menuitem" onClick={toDrive} className="w-full text-left text-[11px] px-3 py-2 text-white/70 hover:text-white hover:bg-white/[0.06] transition-colors flex items-center gap-2.5">
            <span>📁</span><span className="flex-1">To Google Drive</span>
            {drive.state === 'saving' && <span className="text-[9px] text-white/30">…</span>}
          </button>
          {drive.state === 'saved' && drive.link && (
            <a href={drive.link} target="_blank" rel="noopener noreferrer" className="block text-[10px] px-3 py-1.5 text-emerald-400/80 hover:text-emerald-300 border-t border-white/[0.06] mt-1">Open in Drive →</a>
          )}
        </div>
      )}
    </div>
  );
};
