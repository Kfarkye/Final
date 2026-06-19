import { useState, useCallback } from 'react';

export type DriveSaveState = 'idle' | 'saving' | 'saved' | 'error';
interface DriveSaveArgs { content: string; fileName: string; mime?: string; }

/** POST /api/drive/save -> calls create_drive_file server-side (path A). */
export function useDriveSave() {
  const [state, setState] = useState<DriveSaveState>('idle');
  const [link, setLink] = useState<string | null>(null);

  const saveToDrive = useCallback(async ({ content, fileName, mime = 'text/plain' }: DriveSaveArgs) => {
    setState('saving'); setLink(null);
    try {
      const res = await fetch('/api/drive/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ content, fileName, mimeType: mime }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Drive save failed: ${res.status}`);
      }
      const { webViewLink } = await res.json();
      setLink(webViewLink ?? null); setState('saved');
      setTimeout(() => setState('idle'), 2500); return true;
    } catch (e) {
      console.error('[useDriveSave] failed', e);
      setState('error'); setTimeout(() => setState('idle'), 3000); return false;
    }
  }, []);

  return { state, link, saveToDrive };
}
