/**
 * Clipboard helpers for dispatcher fact rows. Empty and em-dash placeholders
 * are not copied — they are layout, not data.
 */
export function copyableValue(value: string | null | undefined): string | null {
  const text = value?.trim() ?? '';
  if (!text || text === '—') return null;
  return text;
}

/**
 * Writes a fact to the clipboard. Returns false when there is nothing to copy
 * or the browser blocked the write.
 */
export async function copyText(value: string | null | undefined): Promise<boolean> {
  const text = copyableValue(value);
  if (!text || typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
    return false;
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
