import { describe, expect, it } from 'vitest';
import type { AlertView } from '@/entities/alert';
import { RECALC_TOAST_ID } from '@/shared/lib';
import { announcementsFor } from './announcements';

function alert(over: Partial<AlertView>): AlertView {
  return {
    id: 'a1',
    kind: 'alert',
    code: 'unassigned',
    severity: 'error',
    engineerIds: [],
    requestIds: [],
    reasons: [],
    createdAt: 1_789_979_116,
    seenAt: null,
    resolvedAt: null,
    ...over,
  };
}

const nameOf = (id: string) => (id === 'e1' ? 'Бригада Соколов' : null);

describe('announcementsFor', () => {
  it('turns an alert into the yellow card that leads to its request', () => {
    const [toast] = announcementsFor(
      [alert({ requestIds: ['r-1'], reasons: [{ assignment: 'unassigned' }] })],
      nameOf,
    );

    expect(toast).toMatchObject({
      kind: 'alert',
      title: 'Алёрт: заявка не назначена',
      href: '/plan?request=r-1',
    });
    expect(toast?.body).toContain('не найдено допустимое назначение');
  });

  it('names the crew a notice is about', () => {
    const [toast] = announcementsFor(
      [alert({ kind: 'notice', code: 'engineer_line_started', engineerIds: ['e1'] })],
      nameOf,
    );

    expect(toast).toMatchObject({
      kind: 'system',
      title: 'Инженер вышел на линию',
      body: 'Бригада Соколов',
    });
  });

  it('reports a rebuilt plan on the recalculation card rather than beside it', () => {
    const [toast] = announcementsFor([alert({ kind: 'notice', code: 'plan_rebuilt' })], nameOf);

    expect(toast).toMatchObject({
      id: RECALC_TOAST_ID,
      kind: 'done',
      title: 'Перерасчёт завершён',
    });
  });

  it('sums up a burst of one kind instead of a wall of cards', () => {
    const burst = Array.from({ length: 35 }, (_, index) =>
      alert({ id: `n${index}`, kind: 'notice', code: 'engineer_line_started' }),
    );

    const toasts = announcementsFor(burst, nameOf);

    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ title: 'Инженер вышел на линию', body: 'Новых: 35' });
  });
});
