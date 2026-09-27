import type { RequestView } from '../api/types';
import { t } from '../i18n';
import { formatClock, moscowAt } from '../lib/time';
import { shortRequestId } from './requestsTable';

export interface TomorrowRequestRow {
  readonly id: string;
  readonly number: string;
  readonly type: string;
  readonly window: string;
  readonly windowStartAt: number;
}

/**
 * Open requests whose window starts on the Moscow day after `workDate`.
 * Morning comes first. Cancelled and draft rows stay off the end-of-day list.
 */
export function tomorrowRequestRows(
  requests: readonly Pick<
    RequestView,
    'id' | 'lifecycle' | 'windowStartAt' | 'windowEndAt' | 'workTypeTitle'
  >[],
  workDate: string,
): TomorrowRequestRow[] {
  const start = nextMoscowDay(workDate);
  const end = start + 86_400;
  return requests
    .filter(
      (request) =>
        (request.lifecycle === 'submitted' || request.lifecycle === 'in_progress') &&
        request.windowStartAt >= start &&
        request.windowStartAt < end,
    )
    .sort((left, right) => left.windowStartAt - right.windowStartAt)
    .map((request) => ({
      id: request.id,
      number: shortRequestId(request.id),
      type: request.workTypeTitle?.trim() || t('figma-dashboard.tomorrowRequests.97cc1d2f7f'),
      window: `${formatClock(request.windowStartAt)}–${formatClock(request.windowEndAt)}`,
      windowStartAt: request.windowStartAt,
    }));
}

/** Unix seconds of the next Moscow midnight after `workDate` (`YYYY-MM-DD`). */
function nextMoscowDay(workDate: string): number {
  const [yearText, monthText, dayText] = workDate.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  const iso = next.toISOString().slice(0, 10);
  return moscowAt(iso, 0, 0, 0);
}
