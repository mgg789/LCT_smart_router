import { describe, expect, it } from 'vitest';
import type { AlertView } from '@/entities/alert';
import { buildInbox, formatAlertReason } from './inbox';

function alert(over: Partial<AlertView>): AlertView {
  return {
    id: 'a1',
    kind: 'alert',
    code: 'unassigned',
    severity: 'error',
    engineerIds: [],
    requestIds: [],
    reasons: [],
    actions: [],
    createdAt: 1_789_979_116,
    seenAt: null,
    resolvedAt: null,
    ...over,
  };
}

const lookup = {
  engineerName: (id: string) => (id === 'e1' ? 'Бригада Соколов' : null),
  request: (id: string) =>
    id === '7ceced3e-263c'
      ? { id, priority: 'urgent' as const }
      : { id, priority: 'normal' as const },
};

describe('buildInbox', () => {
  it('names an unassigned request by its short number and says why in words', () => {
    const inbox = buildInbox(
      [
        alert({
          requestIds: ['12345678-abcd'],
          reasons: [{ assignment: 'unassigned' }],
          actions: ['reschedule', 'move_window'],
        }),
      ],
      lookup,
    );

    expect(inbox.alerts[0]).toMatchObject({
      title: 'Заявка № 12345678 без назначения',
      body: 'Причина: Для заявки не найдено допустимое назначение. Нужно изменить условия или добавить инженера.',
      requestId: '12345678-abcd',
      actionLabels: ['На другой день', 'Сменить окно'],
    });
  });

  it('marks an urgent request on the badge, otherwise gives the time of the result', () => {
    const inbox = buildInbox(
      [alert({ id: 'u', requestIds: ['7ceced3e-263c'] }), alert({ id: 'n', requestIds: ['x'] })],
      lookup,
    );

    expect(inbox.alerts.find((card) => card.id === 'u')?.badge).toBe('Срочная');
    expect(inbox.alerts.find((card) => card.id === 'n')?.badge).toMatch(/^Результат в \d\d:\d\d$/);
  });

  it('keeps a read alert open until it is resolved', () => {
    const inbox = buildInbox(
      [alert({ id: 'read', seenAt: 1 }), alert({ id: 'closed', resolvedAt: 2 })],
      lookup,
    );

    expect(inbox.alerts.map((card) => card.id)).toEqual(['read']);
  });

  it('lists notices apart, and drops one once it is hidden', () => {
    const inbox = buildInbox(
      [
        alert({ id: 'n1', kind: 'notice', code: 'plan_rebuilt', reasons: [{ resultId: 'r' }] }),
        alert({ id: 'n2', kind: 'notice', code: 'plan_rebuilt', seenAt: 5 }),
      ],
      lookup,
    );

    expect(inbox.alerts).toHaveLength(0);
    expect(inbox.notices.map((card) => card.id)).toEqual(['n1']);
    expect(inbox.notices[0]?.title).toBe('План перестроился');
  });

  it('tells who and when for a notice whose reasons cannot be put into words', () => {
    const inbox = buildInbox(
      [alert({ kind: 'notice', code: 'engineer_line_started', engineerIds: ['e1'] })],
      lookup,
    );

    expect(inbox.notices[0]?.body).toMatch(/^Бригада Соколов · \d\d:\d\d$/);
  });

  it('puts the newest first', () => {
    const inbox = buildInbox(
      [alert({ id: 'old', createdAt: 1 }), alert({ id: 'new', createdAt: 2 })],
      lookup,
    );

    expect(inbox.alerts.map((card) => card.id)).toEqual(['new', 'old']);
  });
});

describe('formatAlertReason', () => {
  it('opens every body with «Причина:» exactly once', () => {
    expect(formatAlertReason('нет инженера')).toBe('Причина: нет инженера');
    expect(formatAlertReason('Причина: нет инженера')).toBe('Причина: нет инженера');
    expect(formatAlertReason('  ')).toBe('Причина: не указана');
  });
});
