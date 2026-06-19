import { Request, Response } from 'express';

/**
 * POST /api/drive/save  (path A)
 * Body: { content: string, fileName: string, mimeType?: string }
 * Wraps the existing create_drive_file workspace tool.
 */
export const driveSaveHandler = async (req: Request, res: Response, deps: any) => {
  const googleAccessToken =
    req.body.googleAccessToken ||
    (req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice(7) : undefined);

  const { content, fileName, mimeType = 'text/plain' } = req.body || {};
  if (!content || !fileName) return res.status(400).json({ error: 'content and fileName are required' });
  if (!googleAccessToken) return res.status(401).json({ error: 'Google authentication required' });

  try {
    const result = await deps.executeWorkspaceTool(
      { name: 'create_drive_file', args: { name: fileName, content, mimeType } },
      googleAccessToken
    );
    const webViewLink = result?.webViewLink || result?.link || result?.file?.webViewLink || null;
    return res.json({ ok: true, webViewLink, raw: result });
  } catch (err: any) {
    console.error('[driveSaveHandler] failed', err);
    return res.status(500).json({ error: err.message || 'Drive save failed' });
  }
};
