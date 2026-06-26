/**
 * clipboard.ts — Safe clipboard utility that works on both HTTP and HTTPS.
 *
 * `navigator.clipboard` requires a secure context (HTTPS or localhost).
 * On plain HTTP, it's undefined and calls to writeText() throw:
 *   "Cannot read properties of undefined (reading 'writeText')"
 *
 * This utility falls back to the legacy document.execCommand('copy') approach.
 */

export async function copyToClipboard(text: string): Promise<boolean> {
  // Prefer modern Clipboard API (requires secure context)
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to legacy method
    }
  }

  // Legacy fallback: create a temporary textarea and use execCommand
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    // Position off-screen to avoid flash
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '-9999px';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const success = document.execCommand('copy');
    document.body.removeChild(textarea);
    return success;
  } catch {
    console.warn('[clipboard] Copy failed — neither Clipboard API nor execCommand available');
    return false;
  }
}
