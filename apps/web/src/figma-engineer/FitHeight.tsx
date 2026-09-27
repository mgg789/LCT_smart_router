import type { ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

/** Never enlarged, and never shrunk past the point where the text stops reading. */
const MIN_FIT = 0.62;

/**
 * Shows a phone-tall screen whole inside a shorter desk pane.
 *
 * The request screens are drawn as one column about one visit. On a phone that
 * column scrolls; on a desk there is width to spare and height to spare, and
 * hiding half the visit below a fold is exactly what the desk is meant to fix.
 * So the content is laid out at the pane's width and then zoomed down until it
 * fits the pane's height.
 *
 * `zoom` rather than `transform: scale`, because zoom takes part in layout: the
 * content still measures itself against the pane and reflows into it, so the
 * text wraps to the full width rather than being drawn small and letterboxed.
 *
 * The measurement is deliberately one-way. Zooming out gives the content more
 * room, which can let it reflow shorter, which would let it zoom back in — a
 * loop that never settles. So the natural height is measured once per change at
 * zoom 1 and the ratio is taken from that.
 */
export function FitHeight({ children }: { children: ReactNode }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(1);

  const measure = useCallback(() => {
    const host = hostRef.current;
    const content = contentRef.current;
    if (!host || !content) return;

    const room = host.clientHeight;
    if (room === 0) return;

    // Read the natural height with the zoom lifted, so the ratio is taken
    // against the same layout every time rather than against the last answer.
    const previous = content.style.zoom;
    content.style.zoom = '1';
    const natural = content.scrollHeight;
    content.style.zoom = previous;

    if (natural === 0) return;
    // A couple of pixels of slack: `zoom` rounds up, and a ratio that fits
    // exactly still leaves a scrollbar over two rounded-up pixels.
    const next = Math.max(MIN_FIT, Math.min(1, (room - 4) / natural));
    setFit((current) => (Math.abs(current - next) < 0.005 ? current : next));
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    const content = contentRef.current;
    if (!host || !content || typeof ResizeObserver === 'undefined') return;

    measure();
    const observer = new ResizeObserver(() => measure());
    observer.observe(host);
    observer.observe(content);
    return () => observer.disconnect();
  }, [measure]);

  return (
    <div className="phone-desk-fit h-full" ref={hostRef}>
      <div ref={contentRef} style={{ zoom: fit }}>
        {children}
      </div>
    </div>
  );
}
