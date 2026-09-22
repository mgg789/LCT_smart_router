import { motion, useReducedMotion } from 'framer-motion';
import { type ReactNode, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

/** Native modal supplies focus trapping, Escape and focus restoration across both app shells. */
export function RewardDialog({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const reduced = useReducedMotion();
  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);
  if (typeof document === 'undefined') return null;
  return createPortal(
    <dialog
      ref={dialog}
      onCancel={onClose}
      onClose={onClose}
      aria-labelledby={titleId}
      className="m-auto max-h-[90dvh] w-[min(94vw,720px)] overflow-auto rounded-3xl border-0 bg-figma-canvas p-0 text-figma-ink shadow-2xl backdrop:bg-figma-ink/60"
    >
      {open ? (
        <motion.div
          initial={reduced ? false : { opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
        >
          <div className="flex items-center justify-between gap-4 px-6 pt-6">
            <p className="font-murs text-lg">NAVIX</p>
            <button
              type="button"
              aria-label="Закрыть итоги"
              onClick={onClose}
              className="rounded-full bg-figma-ink/10 px-4 py-2 text-sm font-semibold"
            >
              Закрыть
            </button>
          </div>
          <div className="p-6 sm:p-8">
            <h2 id={titleId} className="mb-6 font-murs text-3xl">
              {title}
            </h2>
            {children}
          </div>
        </motion.div>
      ) : null}
    </dialog>,
    document.body,
  );
}
