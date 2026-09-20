import { describe, expect, it } from 'vitest';
import { createDevSnapshot } from '../fixtures/dev-day';
import { arrivalSeconds, formatAlertReason, inboxFromSources, isInboxAlertKind, sortByArrival } from './alertsInbox';
import type { ToastNotification } from './toasts';

describe('ALERTS inbox', () => {
  it('puts unresolved snapshot alerts above notices and sorts each block by arrival', () => {
    const snapshot = createDevSnapshot();
    const toasts: ToastNotification[] = [
      { id: 'n-old', kind: 'system', title: 'Старое', body: 'a', createdAt: 10 },
      { id: 'n-new', kind: 'chat', title: 'Новое', body: 'b', createdAt: 90 },
      { id: 'demo-alert', kind: 'alert', title: 'Лишний алерт', body: 'x', createdAt: 50 },
    ];
    const inbox = inboxFromSources(snapshot, toasts);
    expect(inbox.alerts[0]?.id).toBe('alert:alert-video');
    expect(inbox.alerts.some((item) => item.id === 'demo-alert')).toBe(true);
    expect(inbox.notices.map((item) => item.id)).toEqual(['n-new', 'n-old']);
    expect(inbox.alerts[0]?.requestId).toBe('10490');
    expect(inbox.alerts[0]?.primaryLabel).toBe('К заявке');
    expect(inbox.alerts[0]?.body.startsWith('Причина:')).toBe(true);
    expect(inbox.alerts.every((item) => item.id.startsWith('alert:') || item.id === 'demo-alert')).toBe(true);
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

  it('fills an empty live inbox from demo toasts so the tab can be reviewed', () => {
    const inbox = inboxFromSources(null, []);
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
    expect(inbox.alerts[0]?.primaryLabel).toBe('К заявке');
    expect(inbox.alerts[0]?.secondaryLabel).toBe('Сменить окно');
  });

  it('keeps the «К заявке» action only when the alert names a request', () => {
    const inbox = inboxFromSources(null, [
      { id: 'sector-alert', kind: 'alert', title: 'Алёрт: риск SLA', body: '3 заявки в зоне риска', createdAt: 2 },
    ]);
    expect(inbox.alerts[0]?.requestId).toBeNull();
    expect(inbox.alerts[0]?.primaryLabel).toBeNull();
  });

  it('treats only alert/error as inbox alerts and normalizes ms timestamps', () => {
    expect(isInboxAlertKind('alert')).toBe(true);
    expect(isInboxAlertKind('error')).toBe(true);
    expect(isInboxAlertKind('system')).toBe(false);
    expect(arrivalSeconds(1_700_000_000_000)).toBe(1_700_000_000);
    expect(arrivalSeconds(1_700_000_000)).toBe(1_700_000_000);
    expect(sortByArrival([{ createdAt: 1 }, { createdAt: 3 }, { createdAt: 2 }]).map((item) => item.createdAt)).toEqual([
      3, 2, 1,
    ]);
  });
});
