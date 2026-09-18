import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import { FIGMA_ASSETS } from './assets';
import { FigmaIcon } from './primitives';
import {
  dismissToast,
  type ToastKind,
  type ToastNotification,
  useToasts,
} from './toasts';

const TOAST_LEFT = 1465;
const TOAST_TOP = 125;
const TOAST_WIDTH = 425;
const SWIPE_DISMISS = 64;

const TOAST_ICON: Record<ToastKind, { src: string; width: number; height: number }> = {
  system: { src: FIGMA_ASSETS.toastSystem, width: 24, height: 24 },
  progress: { src: FIGMA_ASSETS.toastProgress, width: 21, height: 21 },
  ai: { src: FIGMA_ASSETS.toastAi, width: 28, height: 28 },
  chat: { src: FIGMA_ASSETS.toastChat, width: 25, height: 25 },
  route: { src: FIGMA_ASSETS.toastRoute, width: 24, height: 24 },
  alert: { src: FIGMA_ASSETS.toastAlert, width: 25, height: 25 },
};

/**
 * Right-hand toast stack. Stays mounted across sidebar tabs; only the bell hides it.
 */
export function ToastColumn({
  open,
  motionOn,
  scale,
}: {
  open: boolean;
  motionOn: boolean;
  scale: number;
}) {
  const toasts = useToasts();
  if (!open || toasts.length === 0) return null;

  return (
    <div
      data-toast-column
      className="pointer-events-none absolute z-40"
      style={{
        left: TOAST_LEFT,
        top: TOAST_TOP,
        width: TOAST_WIDTH,
        height: 1080 - TOAST_TOP - 24,
      }}
    >
      <div className="flex h-full flex-col gap-[28px] overflow-x-hidden overflow-y-auto [scrollbar-width:none]">
        <AnimatePresence initial={false}>
          {toasts.map((toast) => (
            <ToastCard key={toast.id} toast={toast} motionOn={motionOn} scale={scale} />
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}

function ToastCard({
  toast,
  motionOn,
  scale,
}: {
  toast: ToastNotification;
  motionOn: boolean;
  scale: number;
}) {
  const [offsetX, setOffsetX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const originX = useRef<number | null>(null);
  const alert = toast.kind === 'alert';
  const icon = TOAST_ICON[toast.kind];

  const beginSwipe = (clientX: number) => {
    originX.current = clientX;
    setDragging(true);
  };

  const moveSwipe = (clientX: number) => {
    if (originX.current === null) return;
    const dx = (clientX - originX.current) / Math.max(scale, 0.01);
    setOffsetX(Math.max(0, dx));
  };

  const endSwipe = (clientX: number) => {
    if (originX.current === null) return;
    const dx = (clientX - originX.current) / Math.max(scale, 0.01);
    originX.current = null;
    setDragging(false);
    if (dx < SWIPE_DISMISS) {
      setOffsetX(0);
      return;
    }
    setOffsetX(TOAST_WIDTH + 40);
    dismissToast(toast.id);
  };

  useEffect(() => {
    if (!dragging) return;
    const onMove = (event: PointerEvent) => moveSwipe(event.clientX);
    const onUp = (event: PointerEvent) => endSwipe(event.clientX);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [dragging, scale, toast.id]);

  return (
    <motion.article
      layout
      data-toast-card
      aria-label={`${toast.title}. ${toast.body || toast.etaLabel || ''}`}
      className={`pointer-events-auto relative h-[132px] w-[425px] shrink-0 overflow-hidden rounded-[20px] select-none ${
        alert ? 'bg-figma-bee' : 'bg-figma-ink'
      } ${dragging ? 'cursor-grabbing' : 'cursor-grab'}`}
      initial={motionOn ? { opacity: 0, x: 72 } : false}
      animate={{ opacity: 1, x: offsetX }}
      exit={motionOn ? { opacity: 0, x: TOAST_WIDTH, height: 0, marginBottom: 0 } : { opacity: 0 }}
      transition={dragging ? { duration: 0 } : { duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
      style={{ touchAction: 'pan-x' }}
      onPointerDown={(event) => {
        if ((event.target as HTMLElement).closest('[data-toast-close]')) return;
        if (event.button !== 0) return;
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          /* some synthetic events cannot capture */
        }
        beginSwipe(event.clientX);
      }}
    >
      <div className="absolute left-[15px] top-[10px] flex h-[42px] w-[43px] items-center justify-center rounded-[10px]">
        <FigmaIcon src={icon.src} alt="" width={icon.width} height={icon.height} />
      </div>
      <p
        className={`figma-nowrap absolute left-[68px] top-[23px] max-w-[300px] overflow-hidden font-semibold text-[20px] leading-none text-ellipsis ${
          alert ? 'text-figma-ink' : 'text-white'
        }`}
      >
        {toast.title}
      </p>
      <button
        type="button"
        data-toast-close
        aria-label="Закрыть уведомление"
        className="absolute right-[16px] top-[15px] flex size-[29px] items-center justify-center"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => dismissToast(toast.id)}
      >
        <span className="-rotate-45">
          <FigmaIcon
            src={alert ? FIGMA_ASSETS.toastCloseInk : FIGMA_ASSETS.toastClose}
            alt=""
            width={20}
            height={20}
          />
        </span>
      </button>
      {toast.kind === 'progress' ? (
        <>
          <div className="absolute left-[68px] top-[66px] h-[10px] w-[265px] overflow-hidden rounded-[13px] bg-[#727478]">
            <div
              className="h-full rounded-[13px] bg-gradient-to-r from-[#02673d] to-[#0ed280] transition-[width] duration-300 ease-out"
              style={{ width: `${toast.progress ?? 0}%` }}
            />
          </div>
          {toast.etaLabel ? (
            <p className="figma-nowrap absolute left-[68px] top-[91px] font-semibold text-[16px] leading-none text-[#838383]">
              {toast.etaLabel}
            </p>
          ) : null}
        </>
      ) : (
        <p
          className={`absolute left-[68px] top-[51px] w-[327px] font-medium text-[20px] leading-[24px] tracking-[-0.34px] ${
            alert ? 'text-[#484343]' : 'text-[#838383]'
          }`}
        >
          {toast.body}
        </p>
      )}
    </motion.article>
  );
}
