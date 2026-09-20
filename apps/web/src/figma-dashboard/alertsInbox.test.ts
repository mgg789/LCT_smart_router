import { describe, expect, it } from 'vitest';
import { createDevSnapshot } from '../fixtures/dev-day';
import {
  arrivalSeconds,
  formatAlertReason,
  inboxFromSources,
  isInboxAlertKind,
  sortByArrival,
} from './alertsInbox';
import type { ToastNotification } from './toasts';

describe('ALERTS inbox', () => {
  it('hides a stale unassigned card once the request read already reports an assignment', () => {
    const snapshot = createDevSnapshot();
    const request = snapshot.requests[0];
    const alert = snapshot.alerts[0];
    if (!request || !alert) throw new Error('fixture is incomplete');
    const inbox = inboxFromSources(
      {
        ...snapshot,
        requests: [{ ...request, assignmentState: 'assigned' }],
        alerts: [{ ...alert, code: 'unassigned', requestIds: [request.id], resolvedAt: null }],
      },
      [],
    );
    expect(inbox.alerts).toEqual([]);
  });
  it('keeps equal-time alerts deterministic and appends newer alerts', () => {
    const snapshot = createDevSnapshot();
    const base = snapshot.alerts[0];
    if (!base) throw new Error('fixture needs an alert');
    const alerts = ['b', 'a'].map((id) => ({ ...base, id, createdAt: 100 }));
    const order = (items: typeof alerts) =>
      inboxFromSources({ ...snapshot, alerts: items }, []).alerts.map((item) => item.id);
    expect(order(alerts)).toEqual(['alert:a', 'alert:b']);
    expect(order([...alerts].reverse())).toEqual(['alert:a', 'alert:b']);
    expect(order([{ ...base, id: 'c', createdAt: 200 }, ...alerts])).toEqual([
      'alert:a',
      'alert:b',
      'alert:c',
    ]);
  });
  it('puts unresolved snapshot alerts above notices and sorts each block by arrival', () => {
    const snapshot = createDevSnapshot();
    const toasts: ToastNotification[] = [
      { id: 'n-old', kind: 'system', title: 'Старое', body: 'a', createdAt: 10 },
      { id: 'n-new', kind: 'chat', title: 'Новое', body: 'b', createdAt: 90 },
      { id: 'demo-alert', kind: 'alert', title: 'Лишний алерт', body: 'x', createdAt: 50 },
    ];
    const inbox = inboxFromSources(snapshot, toasts);
    expect(inbox.alerts[0]?.id).toBe('alert:alert-video');
    expect(inbox.alerts.some((item) => item.id === 'demo-alert')).toBe(false);
    expect(inbox.notices.map((item) => item.id)).toEqual(['n-new', 'n-old']);
    expect(inbox.alerts[0]?.requestId).toBe('10490');
    expect(inbox.alerts[0]?.sourceAlert).toBe(
      snapshot.alerts.find((alert) => alert.id === 'alert-video'),
    );
    expect(inbox.alerts[0]?.body.startsWith('Причина:')).toBe(true);
    expect(
      inbox.alerts.every((item) => item.id.startsWith('alert:') || item.id === 'demo-alert'),
    ).toBe(true);
  });

  it('does not duplicate a toast that already mirrors a snapshot alert', () => {
    const snapshot = createDevSnapshot();
    const inbox = inboxFromSources(snapshot, [
      {
        id: 'alert:alert-video',
        kind: 'alert',
        title: 'dup',
        body: 'dup',
        createdAt: 1,
      },
    ]);
    expect(inbox.alerts.filter((item) => item.id === 'alert:alert-video')).toHaveLength(1);
    expect(inbox.notices).toEqual([]);
  });

  it('keeps an unseen server notice dismissible without treating it as an alert', () => {
    const snapshot = createDevSnapshot();
    const source = snapshot.alerts[0];
    if (!source) throw new Error('fixture must include an alert');
    const notice = {
      ...source,
      id: 'notice-live',
      kind: 'notice' as const,
      seenAt: null,
      resolvedAt: null,
    };
    const inbox = inboxFromSources({ ...snapshot, alerts: [notice] }, []);
    expect(inbox.alerts).toEqual([]);
    expect(inbox.notices).toEqual([
      expect.objectContaining({ id: 'alert:notice-live', sourceNoticeId: 'notice-live' }),
    ]);
  });

  it('fills an empty live inbox from demo toasts so the tab can be reviewed', () => {
    const inbox = inboxFromSources(null, [], true);
    expect(inbox.alerts.length).toBeGreaterThan(0);
    expect(inbox.notices.length).toBeGreaterThan(0);
    expect(inbox.alerts.every((item) => item.title.length > 0)).toBe(true);
  });

  it('prefixes Figma reason copy and paints toast alerts like 49:5696', () => {
    expect(formatAlertReason('нет инженера')).toBe('Причина: нет инженера');
    expect(formatAlertReason('Причина: окно')).toBe('Причина: окно');
    const inbox = inboxFromSources(null, [
      {
        id: 'demo-alert',
        kind: 'alert',
        title: 'Алёрт: окно заявки',
        body: 'не укладывается',
        createdAt: 1,
        requestId: '10441',
      },
    ]);
    expect(inbox.alerts[0]?.title).toBe('окно заявки');
    expect(inbox.alerts[0]?.badge).toBe('Срочная');
    expect(inbox.alerts[0]?.requestId).toBe('10441');
    expect(inbox.alerts[0]?.sourceAlert).toBeNull();
  });

  it('keeps the «К заявке» action only when the alert names a request', () => {
    const inbox = inboxFromSources(null, [
      {
        id: 'sector-alert',
        kind: 'alert',
        title: 'Алёрт: риск SLA',
        body: '3 заявки в зоне риска',
        createdAt: 2,
      },
    ]);
    expect(inbox.alerts[0]?.requestId).toBeNull();
  });

  it('treats only alert/error as inbox alerts and normalizes ms timestamps', () => {
    expect(isInboxAlertKind('alert')).toBe(true);
    expect(isInboxAlertKind('error')).toBe(true);
    expect(isInboxAlertKind('system')).toBe(false);
    expect(arrivalSeconds(1_700_000_000_000)).toBe(1_700_000_000);
    expect(arrivalSeconds(1_700_000_000)).toBe(1_700_000_000);
    expect(
      sortByArrival([{ createdAt: 1 }, { createdAt: 3 }, { createdAt: 2 }]).map(
        (item) => item.createdAt,
      ),
    ).toEqual([3, 2, 1]);
  });
});
