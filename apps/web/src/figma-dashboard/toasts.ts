import { useEffect, useState } from 'react';
import type { AlertView } from '../api/types';
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
/** How long a peek card stays after the column was collapsed. Progress ignores this. */
export const TOAST_PEEK_MS = 4000;

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
};

type ToastListener = () => void;

let toasts: ToastNotification[] = [];
const dismissed = new Set<string>();
const listeners = new Set<ToastListener>();
const peekIds = new Set<string>();
const peekTimers = new Map<string, ReturnType<typeof setTimeout>>();
let columnPinned = true;

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
  peekIds.add(toast.id);
  clearPeekTimer(toast.id);
  if (toast.kind === 'progress') return;
  peekTimers.set(
    toast.id,
    setTimeout(() => {
      peekTimers.delete(toast.id);
      peekIds.delete(toast.id);
      emit();
    }, TOAST_PEEK_MS),
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
export function visibleToastsForColumn(): ToastNotification[] {
  const all = getToasts();
  if (columnPinned) return all.slice(0, visibleToastLimit());
  return all.filter((item) => peekIds.has(item.id)).slice(0, visibleToastLimit());
}

/**
 * Demo copies from Figma NOTIFICATIONS (49:6790). Alerts still sort first.
 */
export const DEMO_TOASTS: readonly ToastDraft[] = [
  {
    id: 'demo-system',
    kind: 'system',
    title: 'Системное сообщение',
    body: 'Очень полезное системное сообщение для диспетчера',
    createdAt: 1,
  },
  {
    id: 'demo-progress',
    kind: 'progress',
    title: 'Пересчет маршрутов',
    progress: 34,
    etaLabel: 'Осталось 2 минуты',
    createdAt: 2,
  },
  {
    id: 'demo-ai',
    kind: 'ai',
    title: 'Сообщение от AI',
    body: 'Заявка №1077 «IP-телефония», окно 13:00–15:00, срочная. По результату 11:42 она...',
    createdAt: 3,
  },
  {
    id: 'demo-chat',
    kind: 'chat',
    title: 'Сообщение от Игорь...',
    body: 'Заявка №1077 «IP-телефония», окно 13:00–15:00, срочная. По результату 11:42 она...',
    createdAt: 4,
  },
  {
    id: 'demo-route',
    kind: 'route',
    title: 'Перерасчет завершен',
    body: 'Перерасчет выполнен за 1876мс',
    createdAt: 5,
  },
  {
    id: 'demo-alert',
    kind: 'alert',
    title: 'Алёрт: непокрытие заявок',
    body: 'Выбранная политика покрывает на 4 заявки меньше, чем прошлая',
    createdAt: 6,
    requestId: '18754',
  },
  {
    id: 'demo-system-2',
    kind: 'system',
    title: 'Системное сообщение',
    body: 'План опубликован. Сравнение политик можно пересчитать без смены активного.',
    createdAt: 7,
  },
  {
    id: 'demo-route-2',
    kind: 'route',
    title: 'Маршрут обновлён',
    body: 'Бригада 2 получила новый порядок остановок после пересчёта.',
    createdAt: 8,
  },
  {
    id: 'demo-alert-window',
    kind: 'alert',
    title: 'Алёрт: окно заявки',
    body: 'Заявка №86160 не укладывается в окно 11:27–13:27 при текущем порядке смены.',
    createdAt: 9,
    requestId: '86160',
  },
  {
    id: 'demo-alert-skill',
    kind: 'alert',
    title: 'Алёрт: нет навыка',
    body: 'На «подключение» в восточном секторе свободно только 2 бригады, 5 заявок без назначения.',
    createdAt: 10,
    requestId: '50104',
  },
  {
    id: 'demo-alert-lunch',
    kind: 'system',
    title: 'Обед сдвинут',
    body: 'Бригаде Соколова обед перенесён на 13:00, заявка №1077 стартует после него.',
    createdAt: 11,
  },
  {
    id: 'demo-alert-sla',
    kind: 'alert',
    title: 'Алёрт: риск SLA',
    body: '3 срочные заявки выходят за расчётное окно при политике «Полное покрытие».',
    createdAt: 12,
    requestId: '74198',
  },
  {
    id: 'demo-chat-2',
    kind: 'chat',
    title: 'Сообщение от Петрова',
    body: 'На адресе Самаркандский бульвар нет доступа в подъезд, клиент спускается.',
    createdAt: 13,
  },
  {
    id: 'demo-ai-2',
    kind: 'ai',
    title: 'Сообщение от AI',
    body: 'Бригада Мельников ближе на 8 минут к заявке №1024, чем текущее назначение.',
    createdAt: 14,
  },
  {
    id: 'demo-system-3',
    kind: 'system',
    title: 'Системное сообщение',
    body: 'Загружен пакет восточного округа: 48 заявок, 7 бригад.',
    createdAt: 15,
  },
  {
    id: 'demo-route-3',
    kind: 'route',
    title: 'Перерасчет завершен',
    body: 'Политика «Быстрее» сократила пробег на 14 км, 1 заявка осталась без назначения.',
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
    const weight = (kind: ToastKind) => Number(kind === 'alert' || kind === 'error');
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
  return items;
}

/**
 * Inserts or replaces a toast. Progress at 100% removes the card instead.
 */
export function pushToast(draft: ToastDraft): ToastNotification | null {
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
export function dismissToast(id: string): void {
  dismissed.add(id);
  clearPeekTimer(id);
  peekIds.delete(id);
  const next = toasts.filter((item) => item.id !== id);
  if (next.length === toasts.length) return;
  toasts = next;
  emit();
}

/** Adds missing drafts without touching already-visible or dismissed cards. */
export function upsertNewToasts(drafts: readonly ToastDraft[]): void {
  let changed = false;
  for (const draft of drafts) {
    if (dismissed.has(draft.id) || toasts.some((item) => item.id === draft.id)) continue;
    const next = normalizeToast(draft);
    if (!next) continue;
    toasts = [...toasts, next];
    if (!columnPinned) beginPeek(next);
    changed = true;
  }
  if (changed) emit();
}

/** Seeds Figma examples plus extra demo alerts/notices for the inbox review. */
export function seedDemoToasts(): void {
  upsertNewToasts(DEMO_TOASTS);
}

/** Maps an open snapshot alert onto a yellow alert toast. */
export function toastFromAlert(alert: AlertView): ToastDraft {
  return {
    id: `alert:${alert.id}`,
    kind: 'alert',
    title: `Алёрт: ${factorLabel(alert.code)}`,
    body: alert.reasons[0] ?? factorLabel(alert.code),
    createdAt: alert.createdAt,
    requestId: alert.requestIds[0] ?? null,
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
    title: 'Ошибка входа',
    body,
  });
}

/** Maps a day event onto a dark system toast. */
export function toastFromEvent(event: { id: string; at: number; text: string }): ToastDraft {
  return {
    id: `event:${event.id}`,
    kind: 'system',
    title: 'Системное сообщение',
    body: event.text,
    createdAt: event.at,
  };
}

/** Test-only: wipe the module store between cases. */
export function resetToastsForTests(): void {
  toasts = [];
  dismissed.clear();
  columnPinned = true;
  clearAllPeeks();
  emit();
}
