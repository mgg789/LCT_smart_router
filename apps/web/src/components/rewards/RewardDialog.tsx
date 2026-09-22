import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { type ReactNode, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

const reveal = { duration: 0.32, ease: [0.22, 1, 0.36, 1] as const };

/**
 * Points and shift-result dialog.
 *
 * The native dialog keeps focus trapping and Escape. The card and the dimmed
 * page are a separate layer, so opening and closing both animate; the dialog
 * frame itself cannot.
 */
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
    const node = dialog.current;
    if (!node || !open || node.open) return;
    node.showModal();
  }, [open]);
  if (typeof document === 'undefined') return null;
  return createPortal(
    <dialog
      ref={dialog}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      aria-labelledby={titleId}
      className="fixed inset-0 m-0 h-dvh max-h-none w-screen max-w-none border-0 bg-transparent p-0 text-figma-ink backdrop:bg-transparent"
    >
      <AnimatePresence onExitComplete={() => dialog.current?.close()}>
        {open ? (
          <motion.div
            className="flex h-full items-center justify-center p-4"
            initial={reduced ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={reduced ? undefined : { opacity: 0 }}
            transition={reduced ? { duration: 0 } : reveal}
          >
            <button
              type="button"
              aria-label="Закрыть"
              className="absolute inset-0 bg-figma-ink/60"
              onClick={onClose}
            />
            <motion.div
              initial={reduced ? false : { opacity: 0, y: 18, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={reduced ? undefined : { opacity: 0, y: 12, scale: 0.98 }}
              transition={reduced ? { duration: 0 } : reveal}
              className="relative z-[1] max-h-[90dvh] w-[min(94vw,720px)] overflow-auto rounded-3xl bg-figma-canvas shadow-[0_16px_40px_rgba(15,16,20,0.28)]"
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
          </motion.div>
        ) : null}
      </AnimatePresence>
    </dialog>,
    document.body,
  );
}
