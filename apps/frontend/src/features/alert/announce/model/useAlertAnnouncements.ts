import { useEffect, useRef } from 'react';
import { useAlerts } from '@/entities/alert';
import { useEngineers } from '@/entities/engineer';
import { notify, RECALC_TOAST_ID, useToastStore } from '@/shared/lib';
import { announcementsFor } from './announcements';

/**
 * Pops a notice for every alert that appears while the dispatcher works.
 *
 * What is already there on the first read is not news: it sits on the Alerts
 * section, and announcing it would bury the screen at every sign-in — the rule
 * `apps/web` follows too. Only rows that arrive after that first read are
 * announced, each once.
 */
export function useAlertAnnouncements(): void {
  const alerts = useAlerts();
  const engineers = useEngineers();
  const known = useRef<Set<string> | null>(null);

  useEffect(() => {
    const list = alerts.data?.alerts;
    if (!list) return;

    if (known.current === null) {
      known.current = new Set(list.map((alert) => alert.id));
      return;
    }

    const seen = known.current;
    const fresh = list.filter(
      (alert) => !seen.has(alert.id) && alert.resolvedAt === null && alert.seenAt === null,
    );
    for (const alert of list) seen.add(alert.id);
    if (fresh.length === 0) return;

    const names = new Map(
      (engineers.data?.engineers ?? []).map((engineer) => [engineer.id, engineer.displayName]),
    );
    for (const toast of announcementsFor(fresh, (id) => names.get(id) ?? null)) {
      // The recalculation card may already say it finished — and how long it
      // took, which this notice cannot know. Do not trade that for less.
      const finished = useToastStore
        .getState()
        .toasts.some((item) => item.id === RECALC_TOAST_ID && item.kind === 'done');
      if (toast.id === RECALC_TOAST_ID && finished) continue;
      notify(toast);
    }
  }, [alerts.data, engineers.data]);
}
