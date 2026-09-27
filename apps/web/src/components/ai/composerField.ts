/** How many lines the composer grows before the text itself scrolls. */
export const COMPOSER_LINE_LIMIT = 8;

/** Calculates the bounded textarea height used before the composer starts scrolling. */
export function composerFieldHeight(scrollHeight: number, lineHeight: number): number {
  const safeLineHeight = Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : 24;
  const safeScrollHeight =
    Number.isFinite(scrollHeight) && scrollHeight > 0 ? scrollHeight : safeLineHeight;
  return Math.max(Math.min(safeScrollHeight, safeLineHeight * COMPOSER_LINE_LIMIT), safeLineHeight);
}

/**
 * Focuses a chat textarea when the dark composer background is clicked.
 * The send button and the field itself keep their own pointer behavior.
 */
export function focusComposer(
  event: { readonly target: EventTarget | null; preventDefault: () => void },
  field: HTMLTextAreaElement | null,
): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.closest('button, textarea')) return;
  event.preventDefault();
  field?.focus();
}

export function fitComposerField(element: HTMLTextAreaElement): void {
  element.style.height = '0px';
  const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
  const safeLineHeight = Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : 24;
  const max = safeLineHeight * COMPOSER_LINE_LIMIT;
  element.style.height = `${composerFieldHeight(element.scrollHeight, lineHeight)}px`;
  element.style.overflowY = element.scrollHeight > max + 1 ? 'auto' : 'hidden';
}
