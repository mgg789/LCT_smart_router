import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ToastData } from '@/shared/lib';
import { EASE_OUT, useMotionOn, useToastStore } from '@/shared/lib';
import { Toast } from '@/shared/ui';

/**
 * One notice with its own clock. The clock stops while the pointer rests on the
 * card — a dispatcher reading it should not have it pulled away mid-sentence —
 * and resumes with whatever time was left.
 */
function TimedToast({ toast }: { toast: ToastData }) {
  const dismiss = useToastStore((state) => state.dismiss);
  const navigate = useNavigate();
  const [paused, setPaused] = useState(false);
  const remaining = useRef(toast.durationMs);
  const startedAt = useRef(0);

  // A replaced notice (same id, new content) starts its time again.
  useEffect(() => {
    remaining.current = toast.durationMs;
  }, [toast]);

  useEffect(() => {
    if (paused || remaining.current === null) return;
    startedAt.current = Date.now();
    const timer = window.setTimeout(() => dismiss(toast.id), remaining.current);
    return () => {
      window.clearTimeout(timer);
      if (remaining.current !== null) {
        remaining.current = Math.max(0, remaining.current - (Date.now() - startedAt.current));
      }
    };
  }, [paused, toast, dismiss]);

  const href = toast.href;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hovering only pauses the timer; the card's own controls are real buttons.
    <div onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
      <Toast
        onClose={() => dismiss(toast.id)}
        onOpen={
          href
            ? () => {
                dismiss(toast.id);
                navigate(href);
              }
            : undefined
        }
        toast={toast}
      />
    </div>
  );
}

/**
 * Where notices appear: the top-right corner, under the header, newest on top —
 * the spot the mockup gives them (Figma 64:1395). A notice slides in from the
 * right edge, as in `apps/web`, and slides back out when its time is up or it
 * is closed; the rest of the stack closes the gap.
 */
export function ToastViewport() {
  const toasts = useToastStore((state) => state.toasts);
  const motionOn = useMotionOn();

  return (
    <section
      aria-label="Уведомления"
      aria-live="polite"
      className="pointer-events-none fixed top-[104px] right-[30px] z-50 flex flex-col gap-5"
    >
      <AnimatePresence initial={false}>
        {toasts.map((toast) => (
          <motion.div
            animate={{ opacity: 1, x: 0 }}
            className="pointer-events-auto"
            exit={motionOn ? { opacity: 0, x: 120 } : undefined}
            initial={motionOn ? { opacity: 0, x: 120 } : false}
            key={toast.id}
            layout={motionOn}
            transition={{ duration: 0.34, ease: EASE_OUT }}
          >
            <TimedToast toast={toast} />
          </motion.div>
        ))}
      </AnimatePresence>
    </section>
  );
}
