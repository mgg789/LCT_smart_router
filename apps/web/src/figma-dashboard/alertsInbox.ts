import type { AlertView, DashboardSnapshot } from '../api/types';
import { alertTitle } from '../domain/alerts';
import { requestById } from '../domain/dashboard';
import { t } from '../i18n';
import { factorLabel } from '../lib/reasons';
import { formatClock } from '../lib/time';
import { requestUrgency } from './fromSnapshot';
import { shortRequestId } from './requestsTable';
import { DEMO_TOASTS, type ToastKind, type ToastNotification } from './toasts';

/**
 * Inbox rows are `alert:<id>`. The resolve API looks the row up by the bare id.
 */
export function dispatchAlertId(cardId: string): string {
  return cardId.startsWith('alert:') ? cardId.slice('alert:'.length) : cardId;
}

export type InboxAlertCard = {
  sourceAlert: AlertView | null;
  id: string;
  createdAt: number;
  title: string;
  body: string;
  badge: string | null;
  engineerName: string | null;
  requestId: string | null;
};

export type InboxNoticeCard = {
  id: string;
  sourceNoticeId: string | null;
  /** Every notice this card stands for, including the ones folded into it. */
  repeatedNoticeIds?: readonly string[];
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
  if (!text) return t('figma-dashboard.alertsInbox.5b7075c8fc');
  return text.startsWith(t('figma-dashboard.alertsInbox.449f62a839'))
    ? text
    : t('figma-dashboard.alertsInbox.78fcf07634', { value0: text });
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
    (alert) =>
      alert.kind !== 'notice' &&
      alert.resolvedAt === null &&
      // Independent dashboard reads can straddle an assignment transaction.
      // Never offer an obsolete unassigned action for already assigned work.
      !(
        alert.code === 'unassigned' &&
        alert.requestIds.length > 0 &&
        snapshot &&
        alert.requestIds.every((id) => {
          const request = requestById(snapshot, id);
          return (
            request && (request.assignmentState === 'assigned' || request.lifecycle !== 'submitted')
          );
        })
      ),
  );
  const openNotices = snapshotAlerts.filter(
    (alert) => alert.kind === 'notice' && alert.seenAt === null,
  );
  const sourceToasts =
    demoMode && snapshot === null && toasts.length === 0 ? demoInboxToasts() : toasts;
  const covered = new Set(snapshotAlerts.map((alert) => `alert:${alert.id}`));
  const alerts = [
    ...(snapshot ? openAlerts.map((alert) => alertCardFromSnapshot(snapshot, alert)) : []),
    ...sourceToasts
      .filter(
        (toast) => snapshot === null && isInboxAlertKind(toast.kind) && !covered.has(toast.id),
      )
      .map(alertCardFromToast),
  ].sort(
    (a, b) => arrivalSeconds(a.createdAt) - arrivalSeconds(b.createdAt) || a.id.localeCompare(b.id),
  );
  const notices = collapseRepeats(
    sortByArrival([
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
    ]),
  );
  return { alerts, notices };
}

/**
 * Folds a run of identical notices into the newest of them.
 *
 * Every replan files its own «План перестроился», so a busy few minutes left the
 * dispatcher five cards with the same two lines to dismiss one at a time. Only the
 * wording is compared, so two notices that say different things both stay; the folded
 * ones travel with the survivor and are marked seen together with it.
 */
function collapseRepeats(notices: InboxNoticeCard[]): InboxNoticeCard[] {
  const newest = new Map<string, InboxNoticeCard>();
  const folded = new Map<string, string[]>();
  for (const notice of notices) {
    const key = `${notice.toastKind}|${notice.title}|${notice.body}`;
    const seen = newest.get(key);
    const ids = folded.get(key) ?? [];
    if (notice.sourceNoticeId) ids.push(notice.sourceNoticeId);
    folded.set(key, ids);
    if (!seen || arrivalSeconds(notice.createdAt) >= arrivalSeconds(seen.createdAt)) {
      newest.set(key, notice);
    }
  }
  return notices
    .filter((notice) => newest.get(`${notice.toastKind}|${notice.title}|${notice.body}`) === notice)
    .map((notice) => ({
      ...notice,
      repeatedNoticeIds: folded.get(`${notice.toastKind}|${notice.title}|${notice.body}`) ?? [],
    }));
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
  const unassigned =
    alert.code === 'unassigned' ||
    ['UNASSIGNED', 'NO_SKILL', 'NO_FEASIBLE', 'NO_AVAILABLE'].some((code) =>
      alert.code.includes(code),
    );
  return {
    id: `alert:${alert.id}`,
    sourceAlert: alert,
    createdAt: alert.createdAt,
    title:
      request && unassigned
        ? t('figma-dashboard.alertsInbox.8283fa678b', { value0: shortRequestId(request.id) })
        : alertTitle(alert.code) === alert.code
          ? factorLabel(alert.code)
          : alertTitle(alert.code),
    body: formatAlertReason(alert.reasons.filter(Boolean).join(' · ') || factorLabel(alert.code)),
    badge:
      request && requestUrgency(request).tone !== 'neutral'
        ? requestUrgency(request).label
        : t('figma-dashboard.alertsInbox.26f6469881', { value0: formatClock(alert.createdAt) }),
    engineerName: engineer?.displayName ?? null,
    requestId: request?.id ?? null,
  };
}

function alertCardFromToast(toast: ToastNotification): InboxAlertCard {
  return {
    id: toast.id,
    sourceAlert: null,
    createdAt: toast.createdAt,
    title: toast.title.replace(/^Алёрт:\s*/u, ''),
    body: formatAlertReason(toast.body),
    badge: t('figma-dashboard.alertsInbox.7d27aa7f9c'),
    engineerName: null,
    requestId: toast.requestId ?? null,
  };
}
