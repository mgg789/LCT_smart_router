import type { AlertView } from '@/entities/alert';
import {
  ALERT_ACTION_LABELS,
  alertReason,
  alertReasonText,
  alertTitle,
  isOpenAlert,
  isUnseenNotice,
} from '@/entities/alert';
import { formatTime } from '@/shared/lib';

export interface InboxAlertCard {
  id: string;
  title: string;
  /** «Причина: …» — the drawing always opens the body this way. */
  body: string;
  engineerName: string | null;
  badge: string;
  requestId: string | null;
  /** The decisions the server offers, named; none of them is wired yet. */
  actionLabels: string[];
}

export interface InboxNoticeCard {
  id: string;
  code: string;
  title: string;
  body: string;
}

export interface Inbox {
  alerts: InboxAlertCard[];
  notices: InboxNoticeCard[];
}

interface Lookup {
  engineerName: (id: string) => string | null;
  request: (id: string) => { id: string; priority: 'normal' | 'urgent' } | null;
}

function capitalise(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

/** The drawing opens every alert body with «Причина:». */
export function formatAlertReason(text: string): string {
  const body = text.trim();
  if (!body) return 'Причина: не указана';
  return body.startsWith('Причина:') ? body : `Причина: ${body}`;
}

/**
 * What a notice says. Most carry only a reference (a result id, say), so when
 * no reason can be put into words the body states who and when — both facts of
 * the notice itself, not a phrase made up for it.
 */
function noticeBody(notice: AlertView, lookup: Lookup): string {
  const lines = notice.reasons.map(alertReasonText).filter((line): line is string => Boolean(line));
  if (lines.length > 0) return lines.join(' · ');
  const name = notice.engineerIds[0] ? lookup.engineerName(notice.engineerIds[0]) : null;
  return name ? `${name} · ${formatTime(notice.createdAt)}` : `В ${formatTime(notice.createdAt)}`;
}

/**
 * The Alerts section, as `apps/web` builds it (Figma 49:5629 / 49:5696): alerts
 * that still wait for a decision first, then notices the dispatcher has not
 * hidden, each list newest first.
 *
 * An alert is open until it is resolved — reading it does not close it; a
 * notice leaves the list once it is marked seen.
 */
export function buildInbox(alerts: AlertView[], lookup: Lookup): Inbox {
  const newestFirst = (left: AlertView, right: AlertView) => right.createdAt - left.createdAt;

  return {
    alerts: alerts
      .filter(isOpenAlert)
      .sort(newestFirst)
      .map((alert) => {
        const request = alert.requestIds[0] ? lookup.request(alert.requestIds[0]) : null;
        const unassigned = alert.code === 'unassigned' && request !== null;
        return {
          id: alert.id,
          title: capitalise(
            unassigned && request
              ? `Заявка № ${request.id.slice(0, 8)} без назначения`
              : alertTitle(alert),
          ),
          body: formatAlertReason(alertReason(alert)),
          engineerName: alert.engineerIds[0] ? lookup.engineerName(alert.engineerIds[0]) : null,
          badge:
            request?.priority === 'urgent'
              ? 'Срочная'
              : `Результат в ${formatTime(alert.createdAt)}`,
          requestId: request?.id ?? null,
          actionLabels: (alert.actions ?? []).map(
            (action) => ALERT_ACTION_LABELS[action] ?? action,
          ),
        };
      }),
    notices: alerts
      .filter(isUnseenNotice)
      .sort(newestFirst)
      .map((notice) => ({
        id: notice.id,
        code: notice.code,
        title: capitalise(alertTitle(notice)),
        body: noticeBody(notice, lookup),
      })),
  };
}
