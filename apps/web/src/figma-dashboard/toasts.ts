import { useEffect, useState } from 'react';
import type { AlertView } from '../api/types';
import { alertTitle } from '../domain/alerts';
import { t } from '../i18n';
import { factorLabel } from '../lib/reasons';

export type ToastKind = 'system' | 'progress' | 'ai' | 'chat' | 'route' | 'alert' | 'error';

export const TOAST_CARD_HEIGHT = 132;
export const TOAST_GAP = 28;
export const TOAST_STACK_TOP = 56;
export const TOAST_STACK_BOTTOM = 1047;
export const TOAST_LEFT = 1465;
export const TOAST_WIDTH = 425;
export const TOAST_EXIT_X = 520;
export const TOAST_SWIPE_COLLAPSE = 80;
/** How long one transient card stays over the interface before returning to the panel. */
export const TOAST_PEEK_MS = 4000;
/** Plan-rebuilt stays up long enough to hit the details button. */
export const TOAST_PLAN_PEEK_MS = 9000;

/**
 * macOS natural scrolling flips wheel delta versus Windows/Linux trackpads.
 */
export function invertToastSwipe(
  userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent,
  platform = typeof navigator === 'undefined' ? '' : navigator.platform,
): boolean {
  return /Mac|iPhone|iPad|iPod/.test(platform) || /Macintosh|Mac OS X/.test(userAgent);
}

/**
 * Two-finger trackpad swipe arrives as a horizontal wheel. Accumulate the
 * collapse direction (right on ordinary laptops, left on macOS).
 */
export function accumulateSwipeCollapse(
  deltaX: number,
  deltaY: number,
  accumulated: number,
  threshold = TOAST_SWIPE_COLLAPSE,
  invert = false,
): { accumulated: number; collapse: boolean } {
  if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) {
    return { accumulated: 0, collapse: false };
  }
  const signed = invert ? -deltaX : deltaX;
  if (signed <= 0 || Math.abs(deltaX) <= Math.abs(deltaY)) {
    return { accumulated: 0, collapse: false };
  }
  const next = accumulated + signed;
  if (next >= threshold) return { accumulated: 0, collapse: true };
  return { accumulated: next, collapse: false };
}

export type ToastNotification = {
  id: string;
  kind: ToastKind;
  title: string;
  body: string;
  createdAt: number;
  progress?: number;
  etaLabel?: string;
  /** Request the toast is anchored to, when the event names one («К заявке» navigation). */
  requestId?: string | null;
  /** How long a collapsed column keeps this card visible. Defaults to {@link TOAST_PEEK_MS}. */
  peekMs?: number;
  /** Oval action drawn on the card, for example «Подробнее». */
  actionLabel?: string;
};

export type ToastDraft = {
  id: string;
  kind: ToastKind;
  title: string;
  body?: string;
  createdAt?: number;
  progress?: number;
  etaLabel?: string;
  requestId?: string | null;
  peekMs?: number;
  actionLabel?: string;
};

type ToastListener = () => void;

let toasts: ToastNotification[] = [];
const dismissed = new Set<string>();
const listeners = new Set<ToastListener>();
const peekIds = new Set<string>();
const peekTimers = new Map<string, ReturnType<typeof setTimeout>>();
let columnPinned = false;

function clearPeekTimer(id: string): void {
  const timer = peekTimers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    peekTimers.delete(id);
  }
}

function clearAllPeeks(): void {
  for (const id of peekTimers.keys()) clearPeekTimer(id);
  peekIds.clear();
}

function beginPeek(toast: ToastNotification): void {
  clearAllPeeks();
  peekIds.add(toast.id);
  clearPeekTimer(toast.id);
  peekTimers.set(
    toast.id,
    setTimeout(() => {
      peekTimers.delete(toast.id);
      peekIds.delete(toast.id);
      emit();
    }, toast.peekMs ?? TOAST_PEEK_MS),
  );
}

/**
 * Bell / two-finger swipe pin the full stack. Collapsing drops any peek so
 * hidden cards do not come back with the next arrival.
 */
export function setToastColumnPinned(open: boolean): void {
  columnPinned = open;
  clearAllPeeks();
  emit();
}

/** Whether the dispatcher currently pinned the toast column open. */
export function isToastColumnPinned(): boolean {
  return columnPinned;
}

/**
 * Cards actually drawn: the full stack when pinned, otherwise only peeks.
 */
/** A progress card that has sat on screen for a minute leaves the column. */
export const PROGRESS_TOAST_LIFE_MS = 60_000;

export function isParkedProgress(toast: ToastNotification, now = Date.now()): boolean {
  return toast.kind === 'progress' && now - toast.createdAt >= PROGRESS_TOAST_LIFE_MS;
}

export function visibleToastsForColumn(now = Date.now()): ToastNotification[] {
  const all = getToasts().filter((item) => !isParkedProgress(item, now));
  if (columnPinned) return all;
  return all
    .filter((item) => item.kind === 'progress' || peekIds.has(item.id))
    .slice(0, visibleToastLimit());
}

/**
 * Demo copies from Figma NOTIFICATIONS (49:6790). Alerts still sort first.
 */
export const DEMO_TOASTS: readonly ToastDraft[] = [
  {
    id: 'demo-system',
    kind: 'system',
    title: t('figma-dashboard.toasts.31e2fed780'),
    body: t('figma-dashboard.toasts.bd13e2fda8'),
    createdAt: 1,
  },
  {
    id: 'demo-progress',
    kind: 'progress',
    title: t('figma-dashboard.toasts.3a4398f316'),
    progress: 34,
    etaLabel: t('figma-dashboard.toasts.317b7b2f87'),
    createdAt: 2,
  },
  {
    id: 'demo-ai',
    kind: 'ai',
    title: t('figma-dashboard.toasts.864d7998db'),
    body: t('figma-dashboard.toasts.f2e7570442'),
    createdAt: 3,
  },
  {
    id: 'demo-chat',
    kind: 'chat',
    title: t('figma-dashboard.toasts.92c6eefacd'),
    body: t('figma-dashboard.toasts.f2e7570442'),
    createdAt: 4,
  },
  {
    id: 'demo-route',
    kind: 'route',
    title: t('figma-dashboard.toasts.3ba80b36c2'),
    body: t('figma-dashboard.toasts.ba10b7210f'),
    createdAt: 5,
  },
  {
    id: 'demo-alert',
    kind: 'alert',
    title: t('figma-dashboard.toasts.38fd090346'),
    body: t('figma-dashboard.toasts.7cd33064da'),
    createdAt: 6,
    requestId: '18754',
  },
  {
    id: 'demo-system-2',
    kind: 'system',
    title: t('figma-dashboard.toasts.31e2fed780'),
    body: t('figma-dashboard.toasts.23b8864f49'),
    createdAt: 7,
  },
  {
    id: 'demo-route-2',
    kind: 'route',
    title: t('figma-dashboard.toasts.c19b16eaf4'),
    body: t('figma-dashboard.toasts.907e49c0b0'),
    createdAt: 8,
  },
  {
    id: 'demo-alert-window',
    kind: 'alert',
    title: t('figma-dashboard.toasts.23714eaf9a'),
    body: t('figma-dashboard.toasts.8d90d0d7b9'),
    createdAt: 9,
    requestId: '86160',
  },
  {
    id: 'demo-alert-skill',
    kind: 'alert',
    title: t('figma-dashboard.toasts.72bd38a8b2'),
    body: t('figma-dashboard.toasts.7d55956a42'),
    createdAt: 10,
    requestId: '50104',
  },
  {
    id: 'demo-alert-lunch',
    kind: 'system',
    title: t('figma-dashboard.toasts.34d8132a67'),
    body: t('figma-dashboard.toasts.0e4bb59b00'),
    createdAt: 11,
  },
  {
    id: 'demo-alert-sla',
    kind: 'alert',
    title: t('figma-dashboard.toasts.b256c3ff97'),
    body: t('figma-dashboard.toasts.6109f55914'),
    createdAt: 12,
    requestId: '74198',
  },
  {
    id: 'demo-chat-2',
    kind: 'chat',
    title: t('figma-dashboard.toasts.993c6a7ca2'),
    body: t('figma-dashboard.toasts.621708c219'),
    createdAt: 13,
  },
  {
    id: 'demo-ai-2',
    kind: 'ai',
    title: t('figma-dashboard.toasts.864d7998db'),
    body: t('figma-dashboard.toasts.51da6b4307'),
    createdAt: 14,
  },
  {
    id: 'demo-system-3',
    kind: 'system',
    title: t('figma-dashboard.toasts.31e2fed780'),
    body: t('figma-dashboard.toasts.cf0a1624c6'),
    createdAt: 15,
  },
  {
    id: 'demo-route-3',
    kind: 'route',
    title: t('figma-dashboard.toasts.3ba80b36c2'),
    body: t('figma-dashboard.toasts.9855b9764d'),
    createdAt: 16,
  },
];

function emit(): void {
  for (const listener of listeners) listener();
}

/** Clamps a live progress value into the 0–100 range the bar accepts. */
export function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/**
 * How many cards fit between the stack top and the main content bottom edge.
 */
export function visibleToastLimit(): number {
  const span = TOAST_STACK_BOTTOM - TOAST_STACK_TOP;
  return Math.max(1, Math.floor((span + TOAST_GAP) / (TOAST_CARD_HEIGHT + TOAST_GAP)));
}

/**
 * Alerts stay at the top; newer cards come first so a peek lands at the head.
 */
export function sortToasts(items: readonly ToastNotification[]): ToastNotification[] {
  return [...items].sort((left, right) => {
    const weight = (kind: ToastKind) =>
      kind === 'progress' ? 2 : kind === 'alert' || kind === 'error' ? 1 : 0;
    const alertDelta = weight(right.kind) - weight(left.kind);
    if (alertDelta !== 0) return alertDelta;
    return right.createdAt - left.createdAt;
  });
}

function normalizeToast(draft: ToastDraft): ToastNotification | null {
  const progress = draft.kind === 'progress' ? clampProgress(draft.progress ?? 0) : undefined;
  if (progress !== undefined && progress >= 100) return null;
  return {
    id: draft.id,
    kind: draft.kind,
    title: draft.title,
    body: draft.body ?? '',
    createdAt: draft.createdAt ?? Date.now(),
    progress,
    etaLabel: draft.kind === 'progress' ? draft.etaLabel : undefined,
    requestId: draft.requestId ?? null,
    peekMs: draft.peekMs,
    actionLabel: draft.actionLabel,
  };
}

/** Current toast stack, alerts first. */
export function getToasts(): ToastNotification[] {
  return sortToasts(toasts);
}

/** Subscribe to stack changes. Returns an unsubscribe. */
export function subscribeToasts(listener: ToastListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Live toast stack for Figma chrome. Survives tab switches. */
export function useToasts(): ToastNotification[] {
  const [items, setItems] = useState(getToasts);
  useEffect(() => subscribeToasts(() => setItems(getToasts())), []);
  return items;
}

/** Cards the column should paint right now (pinned stack or transient peeks). */
export function useVisibleColumnToasts(): ToastNotification[] {
  const [items, setItems] = useState(visibleToastsForColumn);
  useEffect(() => subscribeToasts(() => setItems(visibleToastsForColumn())), []);
  useEffect(() => {
    const timer = window.setInterval(() => setItems(visibleToastsForColumn()), 5_000);
    return () => window.clearInterval(timer);
  }, []);
  return items;
}

/**
 * Inserts or replaces a toast. Progress at 100% removes the card instead.
 */
const progressHeld = new Set<string>();

/** Lets the next episode of a progress toast appear after the dispatcher closed the last one. */
export function releaseProgressHold(id: string): void {
  progressHeld.delete(id);
  dismissed.delete(id);
}

export function pushToast(draft: ToastDraft): ToastNotification | null {
  if (draft.kind === 'progress' && progressHeld.has(draft.id)) return null;
  dismissed.delete(draft.id);
  const next = normalizeToast(draft);
  const without = toasts.filter((item) => item.id !== draft.id);
  if (!next) {
    dismissed.add(draft.id);
    clearPeekTimer(draft.id);
    peekIds.delete(draft.id);
    if (without.length !== toasts.length) {
      toasts = without;
      emit();
    }
    return null;
  }
  const existing = toasts.find((item) => item.id === draft.id);
  toasts = [...without, { ...next, createdAt: existing?.createdAt ?? next.createdAt }];
  if (!existing && !columnPinned) beginPeek(next);
  emit();
  return next;
}

/**
 * Patches a hanging toast. Sending progress: 100 dismisses a progress card.
 */
export function updateToast(
  id: string,
  patch: Partial<Pick<ToastDraft, 'title' | 'body' | 'progress' | 'etaLabel'>>,
): ToastNotification | null {
  const current = toasts.find((item) => item.id === id);
  if (!current) return null;
  return pushToast({
    ...current,
    ...patch,
    progress: patch.progress ?? current.progress,
    etaLabel: patch.etaLabel ?? current.etaLabel,
  });
}

/** Removes one toast. Silent if the id is already gone. */
/** Drops every card except a live progress toast. */
export function dismissAllToasts(): void {
  const kept = toasts.filter((item) => item.kind === 'progress');
  for (const item of toasts) {
    if (item.kind === 'progress') continue;
    dismissed.add(item.id);
    clearPeekTimer(item.id);
    peekIds.delete(item.id);
  }
  if (kept.length === toasts.length) return;
  toasts = kept;
  emit();
}

export function dismissToast(id: string): void {
  if (toasts.some((item) => item.id === id && item.kind === 'progress')) progressHeld.add(id);
  dismissed.add(id);
  clearPeekTimer(id);
  peekIds.delete(id);
  const next = toasts.filter((item) => item.id !== id);
  if (next.length === toasts.length) return;
  toasts = next;
  emit();
}

/** Adds missing drafts without touching already-visible or dismissed cards. */
export function upsertNewToasts(drafts: readonly ToastDraft[], peek = true): void {
  let changed = false;
  for (const draft of drafts) {
    if (dismissed.has(draft.id) || toasts.some((item) => item.id === draft.id)) continue;
    const next = normalizeToast(draft);
    if (!next) continue;
    toasts = [...toasts, next];
    if (peek && !columnPinned) beginPeek(next);
    changed = true;
  }
  if (changed) emit();
}

/** Seeds Figma examples plus extra demo alerts/notices for the inbox review. */
export function seedDemoToasts(): void {
  upsertNewToasts(DEMO_TOASTS, false);
}

/** Keeps informational notices distinct from actionable yellow alert toasts. */
export function toastFromAlert(alert: AlertView): ToastDraft {
  const notice = alert.kind === 'notice';
  const label = alertTitle(alert.code);
  const title = label === alert.code ? factorLabel(alert.code) : label;
  return {
    id: `alert:${alert.id}`,
    kind: notice ? (alert.code === 'plan_rebuilt' ? 'route' : 'system') : 'alert',
    title: notice ? title : t('figma-dashboard.toasts.5c26e49bfe', { value0: title }),
    body:
      alert.code === 'plan_rebuilt'
        ? t('figma-dashboard.toasts.abbe406797')
        : (alert.reasons[0] ?? title),
    createdAt: alert.createdAt,
    requestId: alert.requestIds[0] ?? null,
    ...(alert.code === 'plan_rebuilt'
      ? { peekMs: TOAST_PLAN_PEEK_MS, actionLabel: t('figma-dashboard.toasts.59589fe2a5') }
      : {}),
  };
}

/**
 * Login and other blocking failures use the alert card painted danger-red.
 * @param body Short Russian explanation shown under the title.
 */
export function pushAuthErrorToast(body: string): void {
  pushToast({
    id: 'auth-error',
    kind: 'error',
    title: t('figma-dashboard.toasts.4ebf918cfa'),
    body,
  });
}

/** Maps a day event onto a dark system toast. */
export function toastFromEvent(event: { id: string; at: number; text: string }): ToastDraft {
  return {
    id: `event:${event.id}`,
    kind: 'system',
    title: t('figma-dashboard.toasts.31e2fed780'),
    body: event.text,
    createdAt: event.at,
  };
}

/** Test-only: wipe the module store between cases. */
export function resetToastsForTests(): void {
  toasts = [];
  dismissed.clear();
  progressHeld.clear();
  columnPinned = false;
  clearAllPeeks();
  emit();
}
