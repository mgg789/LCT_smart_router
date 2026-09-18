import { useEffect, useState } from 'react';
import type { AlertView } from '../api/types';
import { factorLabel } from '../lib/reasons';

export type ToastKind = 'system' | 'progress' | 'ai' | 'chat' | 'route' | 'alert';

export type ToastNotification = {
  id: string;
  kind: ToastKind;
  title: string;
  body: string;
  createdAt: number;
  progress?: number;
  etaLabel?: string;
};

export type ToastDraft = {
  id: string;
  kind: ToastKind;
  title: string;
  body?: string;
  createdAt?: number;
  progress?: number;
  etaLabel?: string;
};

type ToastListener = () => void;

let toasts: ToastNotification[] = [];
const dismissed = new Set<string>();
const listeners = new Set<ToastListener>();

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
 * Alerts stay at the top; the rest keep arrival order.
 */
export function sortToasts(items: readonly ToastNotification[]): ToastNotification[] {
  return [...items].sort((left, right) => {
    const alertDelta = Number(right.kind === 'alert') - Number(left.kind === 'alert');
    if (alertDelta !== 0) return alertDelta;
    return left.createdAt - right.createdAt;
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

/**
 * Inserts or replaces a toast. Progress at 100% removes the card instead.
 */
export function pushToast(draft: ToastDraft): ToastNotification | null {
  dismissed.delete(draft.id);
  const next = normalizeToast(draft);
  const without = toasts.filter((item) => item.id !== draft.id);
  if (!next) {
    dismissed.add(draft.id);
    if (without.length !== toasts.length) {
      toasts = without;
      emit();
    }
    return null;
  }
  const existing = toasts.find((item) => item.id === draft.id);
  toasts = [...without, { ...next, createdAt: existing?.createdAt ?? next.createdAt }];
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
    changed = true;
  }
  if (changed) emit();
}

/** Seeds the six Figma examples once so the column can be reviewed offline. */
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
  };
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
  emit();
}
