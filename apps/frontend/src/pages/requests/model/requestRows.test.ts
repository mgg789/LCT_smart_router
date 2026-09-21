import { describe, expect, it } from 'vitest';
import type { EngineerView } from '@/entities/engineer';
import type { PlanView } from '@/entities/plan';
import type { RequestView } from '@/entities/request';
import { buildRequestRows, filterRows, sortRows } from './requestRows';

function request(over: Partial<RequestView> & { id: string }): RequestView {
  return {
    version: 1,
    lifecycle: 'submitted',
    assignmentState: 'assigned',
    addressText: 'Москва, ул.Керченская, д. 10',
    region: 'east',
    lat: 55.7,
    lon: 37.7,
    needsGeocoding: false,
    geocodeQuality: null,
    workType: 'convergence',
    workTypeTitle: 'Конвергенция абонента',
    requiredSkill: 'connection',
    requiredEquipment: null,
    normProfileCode: null,
    normativeTravelDurationSec: null,
    technicalDurationSec: null,
    documentationDurationSec: null,
    serviceDurationSec: null,
    actualDurationSec: null,
    durationVarianceSec: null,
    windowStartAt: 1_000,
    windowEndAt: 2_000,
    priority: 'normal',
    contactName: null,
    problemText: null,
    createdAt: 1,
    submittedAt: 1,
    startedAt: null,
    expectedCompletionAt: null,
    continuationAvailableAt: null,
    overrunDetectedAt: null,
    completedAt: null,
    cancelledAt: null,
    ...over,
  };
}

const ENGINEERS = [
  { id: 'e1', displayName: 'Бригада Соколов' },
  { id: 'e2', displayName: 'Бригада Матвеев' },
] as EngineerView[];

const PLAN = {
  revision: 1,
  origin: 'auto',
  planAsOf: 1,
  appliedAt: 1,
  routes: [],
  assignments: [
    { requestId: 'a', status: 'assigned', engineerId: 'e1', reasons: [] },
    { requestId: 'b', status: 'unassigned', engineerId: null, reasons: [] },
  ],
} as PlanView;

describe('buildRequestRows', () => {
  it('names the crew from the applied plan', () => {
    const rows = buildRequestRows([request({ id: 'a' })], PLAN, ENGINEERS);

    expect(rows[0]?.engineerName).toBe('Бригада Соколов');
  });

  it('leaves the crew empty for work nobody was given', () => {
    const rows = buildRequestRows(
      [request({ id: 'b', assignmentState: 'unassigned' })],
      PLAN,
      ENGINEERS,
    );

    expect(rows[0]?.engineerName).toBeNull();
    expect(rows[0]?.statusTone).toBe('attention');
    expect(rows[0]?.statusTitle).toBe('Без назначения');
  });

  it('keeps "waiting for a calculation" distinct from "unassigned"', () => {
    const rows = buildRequestRows(
      [request({ id: 'c', assignmentState: 'pending' })],
      PLAN,
      ENGINEERS,
    );

    expect(rows[0]?.statusTitle).toBe('Ждёт расчёта');
  });

  it('drops cancelled work from the day', () => {
    const rows = buildRequestRows([request({ id: 'x', lifecycle: 'cancelled' })], PLAN, ENGINEERS);

    expect(rows).toHaveLength(0);
  });
});

describe('filterRows', () => {
  const rows = buildRequestRows(
    [
      request({ id: 'a', addressText: 'Москва, ул.Керченская, д. 10' }),
      request({
        id: 'b',
        addressText: 'Москва, пр-кт.Волгоградский, д. 128',
        workTypeTitle: 'IP-телефония',
      }),
    ],
    PLAN,
    ENGINEERS,
  );

  it('matches on the address', () => {
    expect(filterRows(rows, 'керченская')).toHaveLength(1);
  });

  it('matches on the service', () => {
    expect(filterRows(rows, 'телефон')).toHaveLength(1);
  });

  it('matches on the crew', () => {
    expect(filterRows(rows, 'соколов')).toHaveLength(1);
  });

  it('returns everything for an empty query', () => {
    expect(filterRows(rows, '   ')).toHaveLength(2);
  });
});

describe('sortRows', () => {
  it('puts what needs attention first when sorting by status', () => {
    const rows = buildRequestRows(
      [
        request({ id: 'done', lifecycle: 'completed' }),
        request({ id: 'b', assignmentState: 'unassigned' }),
        request({ id: 'a' }),
      ],
      PLAN,
      ENGINEERS,
    );

    expect(sortRows(rows, 'status').map((row) => row.statusTone)).toEqual([
      'attention',
      'neutral',
      'done',
    ]);
  });

  it('orders by the start of the window by default', () => {
    const rows = buildRequestRows(
      [request({ id: 'late', windowStartAt: 5_000 }), request({ id: 'early', windowStartAt: 100 })],
      PLAN,
      ENGINEERS,
    );

    expect(sortRows(rows, 'window').map((row) => row.windowStartAt)).toEqual([100, 5_000]);
  });
});
