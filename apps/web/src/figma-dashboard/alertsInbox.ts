import type { AlertView, DashboardSnapshot } from '../api/types';
import { alertTitle } from '../domain/alerts';
import { requestById } from '../domain/dashboard';
import { factorLabel } from '../lib/reasons';
import { formatClock } from '../lib/time';
import { requestUrgency } from './fromSnapshot';
import { shortRequestId } from './requestsTable';
import { DEMO_TOASTS, type ToastKind, type ToastNotification } from './toasts';

export type InboxAlertCard = {
  id: string;
  createdAt: number;
  title: string;
  body: string;
  badge: string | null;
  engineerName: string | null;
  requestId: string | null;
  primaryLabel: string | null;
  secondaryLabel: string | null;
};

export type InboxNoticeCard = {
  id: string;
  sourceNoticeId: string | null;
  createdAt: number;
  title: string;
  body: string;
  toastKind: ToastKind;
};

/**
 * Alert toasts demand a dispatcher decision; every other kind is an informational
 * notice (definition: context/39 §4.1 — an alert requires action, a notice does not).
 */
export function isInboxAlertKind(kind: ToastKind): boolean {
  return kind === 'alert' || kind === 'error';
}

/**
 * Unix seconds for sort. Live toasts may store Date.now() milliseconds.
 */
export function arrivalSeconds(at: number): number {
  return at > 1_000_000_000_000 ? Math.floor(at / 1000) : at;
}

/** Newest arrival first — same clock for alerts and notices. */
export function sortByArrival<T extends { createdAt: number }>(items: readonly T[]): T[] {
  return [...items].sort(
    (left, right) => arrivalSeconds(right.createdAt) - arrivalSeconds(left.createdAt),
  );
}

/**
 * Figma ALERTS body always starts with «Причина:».
 */
export function formatAlertReason(body: string): string {
  const text = body.trim();
  if (!text) return 'Причина: не указана';
  return text.startsWith('Причина:') ? text : `Причина: ${text}`;
}

/**
 * Builds the ALERTS inbox: unresolved snapshot alerts, then leftover alert toasts,
 * then dismissible notices. Alert toasts that already mirror a snapshot row are skipped.
 */
export function inboxFromSources(
  snapshot: DashboardSnapshot | null,
  toasts: readonly ToastNotification[],
  demoMode = false,
): { alerts: InboxAlertCard[]; notices: InboxNoticeCard[] } {
  const snapshotAlerts = snapshot?.alerts ?? [];
  const openAlerts = snapshotAlerts.filter(
    (alert) => alert.kind !== 'notice' && alert.resolvedAt === null,
  );
  const openNotices = snapshotAlerts.filter(
    (alert) => alert.kind === 'notice' && alert.seenAt === null,
  );
  const sourceToasts =
    demoMode && snapshot === null && toasts.length === 0 ? demoInboxToasts() : toasts;
  const covered = new Set(snapshotAlerts.map((alert) => `alert:${alert.id}`));
  const alerts = sortByArrival([
    ...(snapshot ? openAlerts.map((alert) => alertCardFromSnapshot(snapshot, alert)) : []),
    ...sourceToasts
      .filter(
        (toast) => snapshot === null && isInboxAlertKind(toast.kind) && !covered.has(toast.id),
      )
      .map(alertCardFromToast),
  ]);
  const notices = sortByArrival([
    ...openNotices.map((notice) => ({
      id: `alert:${notice.id}`,
      sourceNoticeId: notice.id,
      createdAt: notice.createdAt,
      title:
        alertTitle(notice.code) === notice.code
          ? factorLabel(notice.code)
          : alertTitle(notice.code),
      body: notice.reasons.filter(Boolean).join(' · ') || factorLabel(notice.code),
      toastKind: 'system' as const,
    })),
    ...sourceToasts
      .filter((toast) => !isInboxAlertKind(toast.kind) && !covered.has(toast.id))
      .map((toast) => ({
        id: toast.id,
        sourceNoticeId: null,
        createdAt: toast.createdAt,
        title: toast.title,
        body: toast.body || toast.etaLabel || '',
        toastKind: toast.kind,
      })),
  ]);
  return { alerts, notices };
}

/** Review copies when the live snapshot and toast store are both empty. */
function demoInboxToasts(): ToastNotification[] {
  return DEMO_TOASTS.map((draft) => ({
    id: draft.id,
    kind: draft.kind,
    title: draft.title,
    body: draft.body ?? draft.etaLabel ?? '',
    createdAt: draft.createdAt ?? 0,
    progress: draft.progress,
    etaLabel: draft.etaLabel,
  }));
}

function alertCardFromSnapshot(snapshot: DashboardSnapshot, alert: AlertView): InboxAlertCard {
  const request = alert.requestIds[0] ? requestById(snapshot, alert.requestIds[0]) : null;
  const engineer = alert.engineerIds[0]
    ? (snapshot.engineers.find((item) => item.id === alert.engineerIds[0]) ?? null)
    : null;
  const lunch = alert.code.includes('LUNCH');
  const unassigned =
    !lunch &&
    Boolean(
      request &&
        (request.assignmentState === 'unassigned' ||
          request.assignmentState === 'pending' ||
          alert.code.includes('UNASSIGNED') ||
          alert.code.includes('NO_SKILL') ||
          alert.code.includes('NO_FEASIBLE') ||
          alert.code.includes('NO_AVAILABLE')),
    );
  return {
    id: `alert:${alert.id}`,
    createdAt: alert.createdAt,
    title:
      request && unassigned
        ? `Заявка № ${shortRequestId(request.id)} без назначения`
        : alertTitle(alert.code) === alert.code
          ? factorLabel(alert.code)
          : alertTitle(alert.code),
    body: formatAlertReason(alert.reasons.filter(Boolean).join(' · ') || factorLabel(alert.code)),
    badge:
      request && requestUrgency(request).tone !== 'neutral'
        ? requestUrgency(request).label
        : `Результат в ${formatClock(alert.createdAt)}`,
    engineerName: engineer?.displayName ?? null,
    requestId: request?.id ?? null,
    primaryLabel: lunch ? 'Оставить без обеда' : request ? 'К заявке' : null,
    secondaryLabel: lunch
      ? 'Исключить заявку'
      : request
        ? unassigned
          ? 'Сменить окно'
          : 'Изменить условия'
        : null,
  };
}

function alertCardFromToast(toast: ToastNotification): InboxAlertCard {
  return {
    id: toast.id,
    createdAt: toast.createdAt,
    title: toast.title.replace(/^Алёрт:\s*/u, ''),
    body: formatAlertReason(toast.body),
    badge: 'Срочная',
    engineerName: null,
    requestId: toast.requestId ?? null,
    primaryLabel: toast.requestId ? 'К заявке' : null,
    secondaryLabel: 'Сменить окно',
  };
}
