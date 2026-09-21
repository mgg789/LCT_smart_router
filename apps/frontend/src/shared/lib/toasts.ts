import { create } from 'zustand';

/**
 * The six notices the mockup draws (Figma 147:934): a system message, a route
 * recalculation under way, a message from the assistant, a message from a
 * person, a finished recalculation, and an alert — the one in accent yellow.
 */
export type ToastKind = 'system' | 'progress' | 'ai' | 'chat' | 'done' | 'alert';

export interface Toast {
  id: string;
  kind: ToastKind;
  title: string;
  body?: string;
  /**
   * `progress` only: how far along, `0…1`, or `null` when nobody knows — the
   * bar then runs without claiming a share.
   */
  progress?: number | null;
  /** How long it stays on screen; `null` keeps it until it is replaced or closed. */
  durationMs: number | null;
  /** Where clicking the notice takes the dispatcher, if anywhere. */
  href?: string;
}

/**
 * The one notice about the plan being recalculated. Everything that reports on
 * a recalculation — its start, a rebuilt plan — writes to this id, so there is
 * never more than one such card on screen.
 */
export const RECALC_TOAST_ID = 'recalc';

/** How long a notice stays, as in `apps/web` (`TOAST_PEEK_MS`). */
export const TOAST_DURATION_MS = 4_000;
/** More than this and the oldest make room; a burst must not wall off the screen. */
export const TOAST_LIMIT = 4;

interface ToastState {
  toasts: Toast[];
  /** Adds a notice, or replaces the one with the same id — a recalculation finishing, say. */
  push: (toast: Omit<Toast, 'durationMs'> & { durationMs?: number | null }) => void;
  dismiss: (id: string) => void;
  clear: () => void;
}

export const useToastStore = create<ToastState>()((set) => ({
  toasts: [],
  push: (toast) =>
    set((state) => {
      const next: Toast = { durationMs: TOAST_DURATION_MS, ...toast };
      const rest = state.toasts.filter((item) => item.id !== next.id);
      // Newest on top; the oldest leave first when there are too many.
      return { toasts: [next, ...rest].slice(0, TOAST_LIMIT) };
    }),
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((item) => item.id !== id) })),
  clear: () => set({ toasts: [] }),
}));

/** Shorthand for code outside React: `notify({...})`. */
export function notify(toast: Parameters<ToastState['push']>[0]): void {
  useToastStore.getState().push(toast);
}
