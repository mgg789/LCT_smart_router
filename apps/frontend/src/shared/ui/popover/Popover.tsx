import type { ReactNode } from 'react';
import { useEffect, useId, useRef } from 'react';
import { cn } from '../../lib/cn';

export interface PopoverProps {
  onClose: () => void;
  title: string;
  children: ReactNode;
  /**
   * Icon of the close control. The mockup puts the trigger's own icon here, so
   * the 43px circle reads as the button the dispatcher just pressed.
   */
  closeIcon: ReactNode;
  closeLabel?: string;
  className?: string;
}

/**
 * White card that drops from a header control: 363px wide, 27px radius, title in
 * Murs Gothic 20px and a 43px dark close circle pinned 4px from the top-right.
 *
 * Closing on Escape and on a click outside is part of the component — a popover
 * the dispatcher cannot dismiss would sit on top of the day.
 *
 * Mounted means visible: the parent mounts it only while it is open, so a closed
 * panel costs nothing and its queries do not run. Where it lands is the parent's
 * business — each trigger anchors its own panel over itself.
 */
export function Popover({
  onClose,
  title,
  children,
  closeIcon,
  closeLabel = 'Закрыть',
  className,
}: PopoverProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const onPointerDown = (event: MouseEvent) => {
      const panel = panelRef.current;
      if (!panel) return;
      // The trigger lives outside the panel; it toggles on its own click.
      if (
        !panel.contains(event.target as Node) &&
        !panel.parentElement?.contains(event.target as Node)
      ) {
        onClose();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [onClose]);

  return (
    <div
      aria-labelledby={titleId}
      className={cn('absolute z-20 w-[363px] rounded-[27px] bg-surface p-4 shadow-xl', className)}
      ref={panelRef}
      role="dialog"
    >
      <div className="flex items-start justify-between">
        <h2 className="pt-[3px] font-display text-[20px] text-ink" id={titleId}>
          {title}
        </h2>
        <button
          aria-label={closeLabel}
          className="-mt-3 -mr-3 flex size-[43px] shrink-0 items-center justify-center rounded-full bg-ink text-white"
          onClick={onClose}
          type="button"
        >
          {closeIcon}
        </button>
      </div>
      <div className="mt-[14px]">{children}</div>
    </div>
  );
}
