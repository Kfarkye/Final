import { useState, useCallback } from 'react';
import { FileAttachment } from './types';

const supportsFsAccess =
  typeof window !== 'undefined' && 'showSaveFilePicker' in window;

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

interface SaveTextArgs { content: string; fileName: string; mime?: string; }

/** Single source of truth for local saves: OS folder picker w/ download fallback. */
export function useLocalSave() {
  const [state, setState] = useState<SaveState>('idle');
  const flash = useCallback((next: SaveState, resetMs = 1800) => {
    setState(next);
    if (next === 'saved' || next === 'error') setTimeout(() => setState('idle'), resetMs);
  }, []);

  const saveText = useCallback(async ({ content, fileName, mime = 'text/plain' }: SaveTextArgs) => {
    setState('saving');
    const ext = fileName.split('.').pop() ?? 'txt';
    try {
      if (supportsFsAccess) {
        const handle = await (window as any).showSaveFilePicker({
          suggestedName: fileName,
          types: [{ description: ext.toUpperCase(), accept: { [mime]: ['.' + ext] } }],
        });
        const w = await handle.createWritable(); await w.write(content); await w.close();
      } else {
        const url = URL.createObjectURL(new Blob([content], { type: mime }));
        const a = document.createElement('a'); a.href = url; a.download = fileName;
        document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
      }
      flash('saved'); return true;
    } catch (e: any) {
      if (e?.name === 'AbortError') { setState('idle'); return false; }
      console.error('[useLocalSave] saveText failed', e); flash('error'); return false;
    }
  }, [flash]);

  const saveAttachment = useCallback(async (att: FileAttachment) => {
    setState('saving');
    const ext = att.name.split('.').pop() ?? 'bin';
    const mime = att.type || 'application/octet-stream';
    try {
      if (supportsFsAccess) {
        const handle = await (window as any).showSaveFilePicker({
          suggestedName: att.name,
          types: [{ description: ext.toUpperCase(), accept: { [mime]: ['.' + ext] } }],
        });
        const w = await handle.createWritable(); await w.write(att.file); await w.close();
      } else {
        const a = document.createElement('a'); a.href = att.dataUrl; a.download = att.name;
        document.body.appendChild(a); a.click(); a.remove();
      }
      flash('saved'); return true;
    } catch (e: any) {
      if (e?.name === 'AbortError') { setState('idle'); return false; }
      console.error('[useLocalSave] saveAttachment failed', e); flash('error'); return false;
    }
  }, [flash]);

  return { state, saveText, saveAttachment, supportsFsAccess };
}
