import type { AlertView } from '@/entities/alert';
import { alertReason, alertTitle } from '@/entities/alert';
import type { ToastData } from '@/shared/lib';
import { formatTime, RECALC_TOAST_ID } from '@/shared/lib';

/** Past this many of one kind in a single poll, they arrive as one summary notice. */
const BURST = 2;

type Announcement = Omit<ToastData, 'durationMs'>;

function linkFor(alert: AlertView): string {
  const request = alert.requestIds[0];
  return request ? `/plan?request=${encodeURIComponent(request)}` : '/alerts';
}

/**
 * Turns the alerts that appeared since the last poll into notices.
 *
 * An alert — something waiting for a decision — becomes the yellow card and
 * leads to the request it is about. A notice becomes an ink card. A burst of
 * one kind (the whole roster going on the line at the start of the day) comes
 * as one summary instead of a wall of identical cards.
 *
 * `nameOf` resolves a crew for notices about one; nothing is invented when it
 * cannot.
 */
export function announcementsFor(
  fresh: AlertView[],
  nameOf: (engineerId: string) => string | null,
): Announcement[] {
  const byCode = new Map<string, AlertView[]>();
  for (const alert of fresh) {
    const key = `${alert.kind ?? 'alert'}:${alert.code}`;
    byCode.set(key, [...(byCode.get(key) ?? []), alert]);
  }

  const out: Announcement[] = [];
  for (const group of byCode.values()) {
    const first = group[0];
    if (!first) continue;
    const isAlert = first.kind !== 'notice';

    if (group.length > BURST) {
      out.push({
        id: `burst:${first.code}:${first.id}`,
        kind: isAlert ? 'alert' : first.code === 'plan_rebuilt' ? 'done' : 'system',
        title: isAlert ? `Алёрт: ${alertTitle(first).toLowerCase()}` : alertTitle(first),
        body: `Новых: ${group.length}`,
        href: '/alerts',
      });
      continue;
    }

    for (const alert of group) {
      const name = alert.engineerIds[0] ? nameOf(alert.engineerIds[0]) : null;
      if (isAlert) {
        out.push({
          id: `alert:${alert.id}`,
          kind: 'alert',
          title: `Алёрт: ${alertTitle(alert).toLowerCase()}`,
          body: alertReason(alert),
          href: linkFor(alert),
        });
      } else if (alert.code === 'plan_rebuilt') {
        // A rebuilt plan shares the recalculation's id, so it replaces the
        // «Пересчёт маршрутов» card instead of stacking a second one beside it.
        out.push({
          id: RECALC_TOAST_ID,
          kind: 'done',
          title: 'Перерасчёт завершён',
          body: `Новый план применён в ${formatTime(alert.createdAt)}`,
          href: '/plan',
        });
      } else {
        out.push({
          id: `alert:${alert.id}`,
          kind: 'system',
          title: alertTitle(alert),
          body: name ?? undefined,
          href: '/alerts',
        });
      }
    }
  }
  return out;
}
