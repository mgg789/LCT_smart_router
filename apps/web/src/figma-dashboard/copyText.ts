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
  if (!text) return false;
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Some embedded browsers deny clipboard.writeText — fall through.
  }
  if (typeof document === 'undefined') return false;
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.left = '-9999px';
  document.body.appendChild(field);
  field.select();
  const ok = document.execCommand('copy');
  document.body.removeChild(field);
  return ok;
}
