/** How many lines the composer grows before the text itself scrolls. */
export const COMPOSER_LINE_LIMIT = 5;

/**
 * Grows a chat textarea with its text, then scrolls inside a five-line cap.
 * The surrounding circles stay a fixed size; only this element changes height.
 */
export function fitComposerField(element: HTMLTextAreaElement): void {
  element.style.height = '0px';
  const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
  const max = (Number.isFinite(lineHeight) ? lineHeight : 24) * COMPOSER_LINE_LIMIT;
  const next = Math.min(element.scrollHeight, max);
  element.style.height = `${Math.max(next, lineHeight || 0)}px`;
  element.style.overflowY = element.scrollHeight > max + 1 ? 'auto' : 'hidden';
}
