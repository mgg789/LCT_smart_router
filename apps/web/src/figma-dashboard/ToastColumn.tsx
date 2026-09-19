import { motion } from 'framer-motion';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { FIGMA_ASSETS } from './assets';
import { FigmaIcon } from './primitives';
import {
  TOAST_CARD_HEIGHT,
  TOAST_EXIT_X,
  TOAST_GAP,
  TOAST_LEFT,
  TOAST_STACK_TOP,
  TOAST_WIDTH,
  accumulateSwipeCollapse,
  dismissToast,
  invertToastSwipe,
  type ToastKind,
  type ToastNotification,
  useVisibleColumnToasts,
} from './toasts';

const SWIPE_DISMISS = 64;
const STACK_EASE = [0.22, 1, 0.36, 1] as const;
const STRIDE = TOAST_CARD_HEIGHT + TOAST_GAP;

const TOAST_ICON: Record<ToastKind, { src: string; width: number; height: number }> = {
  system: { src: FIGMA_ASSETS.toastSystem, width: 24, height: 24 },
  progress: { src: FIGMA_ASSETS.toastProgress, width: 24, height: 24 },
  ai: { src: FIGMA_ASSETS.toastAi, width: 28, height: 28 },
  chat: { src: FIGMA_ASSETS.toastChat, width: 25, height: 25 },
  route: { src: FIGMA_ASSETS.toastRoute, width: 24, height: 24 },
  alert: { src: FIGMA_ASSETS.toastAlert, width: 25, height: 25 },
  error: { src: FIGMA_ASSETS.toastAlert, width: 25, height: 25 },
};

type ToastGhost = {
  id: string;
  toast: ToastNotification;
  top: number;
  startX: number;
};

/**
 * Right-hand toast stack. Swipe/close travel past the artboard edge, not a clip box.
 */
export function ToastColumn({
  open,
  motionOn,
  scale,
  onCollapse,
}: {
  open: boolean;
  motionOn: boolean;
  scale: number;
  onCollapse: () => void;
}) {
  const visible = useVisibleColumnToasts();
  const shown = open || visible.length > 0;
  const [ghosts, setGhosts] = useState<ToastGhost[]>([]);
  const wheelX = useRef(0);
  const wheelReset = useRef<number | null>(null);
  const onCollapseRef = useRef(onCollapse);
  onCollapseRef.current = onCollapse;

  useEffect(() => {
    if (!shown) {
      wheelX.current = 0;
      return;
    }
    const onWheel = (event: WheelEvent) => {
      const overCard = (event.target as HTMLElement | null)?.closest?.('[data-toast-card]');
      if (!overCard) return;
      const next = accumulateSwipeCollapse(
        event.deltaX,
        event.deltaY,
        wheelX.current,
        undefined,
        invertToastSwipe(),
      );
      wheelX.current = next.accumulated;
      if (next.collapse) {
        event.preventDefault();
        onCollapseRef.current();
      } else if (next.accumulated > 0) {
        event.preventDefault();
      }
      if (wheelReset.current !== null) window.clearTimeout(wheelReset.current);
      wheelReset.current = window.setTimeout(() => {
        wheelX.current = 0;
      }, 180);
    };
    window.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => {
      window.removeEventListener('wheel', onWheel, true);
      if (wheelReset.current !== null) window.clearTimeout(wheelReset.current);
    };
  }, [shown]);

  const beginLeave = (toast: ToastNotification, top: number, startX: number) => {
    setGhosts((current) =>
      current.some((item) => item.id === toast.id)
        ? current
        : [...current, { id: toast.id, toast, top, startX }],
    );
    dismissToast(toast.id);
  };

  return (
    <motion.div
      data-toast-column
      className="pointer-events-none absolute inset-0 z-[80] overflow-visible"
      initial={false}
      animate={{ x: shown ? 0 : TOAST_EXIT_X }}
      transition={motionOn ? { duration: 0.34, ease: STACK_EASE } : { duration: 0 }}
    >
      {visible.map((toast, index) => {
        const top = TOAST_STACK_TOP + index * STRIDE;
        return (
          <ToastCard
            key={toast.id}
            toast={toast}
            top={top}
            motionOn={motionOn}
            scale={scale}
            interactive={shown}
            onLeave={(startX) => beginLeave(toast, top, startX)}
          />
        );
      })}
      {ghosts.map((ghost) => (
        <ToastFace
          key={`ghost-${ghost.id}`}
          toast={ghost.toast}
          top={ghost.top}
          x={ghost.startX}
          leaving
          motionOn={motionOn}
          onLeft={() => setGhosts((current) => current.filter((item) => item.id !== ghost.id))}
        />
      ))}
    </motion.div>
  );
}

function ToastCard({
  toast,
  top,
  motionOn,
  scale,
  interactive,
  onLeave,
}: {
  toast: ToastNotification;
  top: number;
  motionOn: boolean;
  scale: number;
  interactive: boolean;
  onLeave: (startX: number) => void;
}) {
  const [offsetX, setOffsetX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const originX = useRef<number | null>(null);
  const left = useRef(false);

  const leave = (startX: number) => {
    if (left.current) return;
    left.current = true;
    onLeave(startX);
  };

  const beginSwipe = (clientX: number) => {
    if (!interactive || left.current) return;
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
    leave(dx);
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
    <ToastFace
      toast={toast}
      top={top}
      x={offsetX}
      dragging={dragging}
      motionOn={motionOn}
      interactive={interactive}
      onClose={() => leave(offsetX)}
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
    />
  );
}

function ToastFace({
  toast,
  top,
  x,
  dragging = false,
  leaving = false,
  motionOn,
  interactive = false,
  onClose,
  onLeft,
  onPointerDown,
}: {
  toast: ToastNotification;
  top: number;
  x: number;
  dragging?: boolean;
  leaving?: boolean;
  motionOn: boolean;
  interactive?: boolean;
  onClose?: () => void;
  onLeft?: () => void;
  onPointerDown?: (event: ReactPointerEvent<HTMLElement>) => void;
}) {
  const alert = toast.kind === 'alert';
  const danger = toast.kind === 'error';
  const icon = TOAST_ICON[toast.kind];

  return (
    <motion.article
      data-toast-card={leaving ? undefined : true}
      aria-hidden={leaving || undefined}
      aria-label={leaving ? undefined : `${toast.title}. ${toast.body || toast.etaLabel || ''}`}
      className={`absolute h-[132px] w-[425px] overflow-hidden rounded-[20px] select-none ${
        leaving ? 'pointer-events-none' : 'pointer-events-auto'
      } ${danger ? 'bg-figma-danger' : alert ? 'bg-figma-bee' : 'bg-figma-ink'} ${
        dragging ? 'cursor-grabbing' : interactive ? 'cursor-grab' : ''
      }`}
      initial={leaving ? { x, top, left: TOAST_LEFT, opacity: 1 } : motionOn ? { opacity: 0, y: 28, top, left: TOAST_LEFT, x: 0 } : { top, left: TOAST_LEFT, x: 0 }}
      animate={leaving ? { x: TOAST_EXIT_X, top, left: TOAST_LEFT, opacity: 1 } : { opacity: 1, x, y: 0, top, left: TOAST_LEFT }}
      transition={
        leaving
          ? { duration: motionOn ? 0.32 : 0, ease: STACK_EASE }
          : dragging
            ? { x: { duration: 0 }, top: { duration: 0.32, ease: STACK_EASE }, y: { duration: 0.32, ease: STACK_EASE } }
            : { duration: 0.32, ease: STACK_EASE }
      }
      style={{ width: TOAST_WIDTH, touchAction: 'pan-x' }}
      onPointerDown={onPointerDown}
      onAnimationComplete={() => {
        if (leaving) onLeft?.();
      }}
    >
      <div className="absolute left-[15px] top-[8px] flex h-[42px] w-[43px] items-center justify-center rounded-[10px]">
        <FigmaIcon
          src={icon.src}
          alt=""
          width={icon.width}
          height={icon.height}
          className={danger ? 'brightness-0 invert' : undefined}
        />
      </div>
      <p
        className={`figma-nowrap absolute left-[68px] top-[19px] max-w-[300px] overflow-hidden font-semibold text-[20px] leading-none text-ellipsis ${
          danger || !alert ? 'text-white' : 'text-figma-ink'
        }`}
      >
        {toast.title}
      </p>
      {leaving ? null : (
      <button
        type="button"
        data-toast-close
        aria-label="Закрыть уведомление"
        className="absolute right-[16px] top-[13px] flex size-[29px] items-center justify-center transition-transform duration-150 hover:scale-110 hover:rotate-90"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => onClose?.()}
      >
        <span className="-rotate-45">
          <FigmaIcon
            src={alert && !danger ? FIGMA_ASSETS.toastCloseInk : FIGMA_ASSETS.toastClose}
            alt=""
            width={20}
            height={20}
            className={danger ? 'brightness-0 invert' : undefined}
          />
        </span>
      </button>
      )}
      {toast.kind === 'progress' ? (
        <>
          <div className="absolute left-[68px] top-[62px] h-[10px] w-[265px] overflow-hidden rounded-[13px] bg-[#727478]">
            <div
              className="h-full rounded-[13px] bg-gradient-to-r from-[#02673d] to-[#0ed280] transition-[width] duration-300 ease-out"
              style={{ width: `${toast.progress ?? 0}%` }}
            />
          </div>
          {toast.etaLabel ? (
            <p className="figma-nowrap absolute left-[68px] top-[88px] font-semibold text-[16px] leading-none text-[#838383]">
              {toast.etaLabel}
            </p>
          ) : null}
        </>
      ) : (
        <p
          className={`absolute left-[68px] top-[48px] w-[327px] font-medium text-[18px] leading-[22px] tracking-[-0.3px] ${
            danger ? 'text-white' : alert ? 'text-[#484343]' : 'text-[#838383]'
          }`}
        >
          {toast.body}
        </p>
      )}
    </motion.article>
  );
}
