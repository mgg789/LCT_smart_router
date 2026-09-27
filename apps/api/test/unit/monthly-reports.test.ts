import assert from 'node:assert/strict';
import test from 'node:test';
import { FixedClock } from '../../src/common/time';
import {
  assertMonth,
  MonthlyReportsService,
  reportKey,
} from '../../src/notifications/monthly-reports.service';

const NOW = Math.floor(Date.parse('2026-09-22T12:00:00+03:00') / 1000);

class FakeDb {
  readonly state = new Map<string, unknown>();
  readonly intents = new Set<string>();
  rewardRows: unknown[] = [];
  engineerRows: { id: string; displayName: string; archivedAt: bigint | null }[] = [];
  appState = {
    findUnique: async ({ where: { key } }: { where: { key: string } }) =>
      this.state.has(key) ? { key, value: this.state.get(key) } : null,
    create: async ({ data }: { data: { key: string; value: unknown } }) => {
      this.state.set(data.key, data.value);
      return data;
    },
    upsert: async ({
      where: { key },
      create,
      update,
    }: {
      where: { key: string };
      create: { key: string; value: unknown };
      update: { value?: unknown };
    }) => {
      if (!this.state.has(key)) this.state.set(key, create.value);
      else if ('value' in update) this.state.set(key, update.value);
      return { key, value: this.state.get(key) };
    },
    findMany: async () => [],
  };
  engineerReward = { findMany: async () => this.rewardRows };
  requestFact = { findMany: async () => [] };
  request = { findMany: async () => [] };
  liveRequestState = { findMany: async () => [] };
  dayRows: { engineerId: string; workDate: string; shiftStartAt: bigint; shiftEndAt: bigint }[] =
    [];
  engineerDay = { findMany: async () => this.dayRows };
  engineer = {
    findMany: async () => this.engineerRows,
  };
  liveWorkday = { findMany: async () => [], findFirst: async () => null };
  accountRole = { findMany: async () => [{ accountId: 'dispatcher-1' }] };
}

function service(db: FakeDb, notifications = true): MonthlyReportsService {
  const clock = new FixedClock(NOW);
  const mail = {
    record: async (_tx: unknown, _now: number, input: { businessEventKey: string }) => {
      if (notifications) db.intents.add(input.businessEventKey);
    },
  };
  const uow = { run: async <T>(fn: (tx: FakeDb) => Promise<T>) => fn(db) };
  return new MonthlyReportsService(db as never, uow as never, clock, mail as never);
}

test('monthly month validation rejects impossible and future months', () => {
  assert.throws(() => assertMonth('2026-13', '2026-09'));
  assert.throws(() => assertMonth('2026-10', '2026-09'));
  assertMonth('2026-09', '2026-09');
  assert.equal(reportKey('2026-08'), 'reports.monthly.2026-08');
});

test('catchup initializes cursor on first install and catches one closed month after restart', async () => {
  // The operator's shell may run with DEMO_STAND=true for the demo contour; this
  // test's mail expectations are for an ordinary machine, so pin the flag here.
  const previous = process.env.DEMO_STAND;
  delete process.env.DEMO_STAND;
  try {
    const db = new FakeDb();
    db.state.set('reports.monthly.cursor', { version: 1, month: '2026-07' });
    const report = await service(db).catchUp();
    assert.deepEqual(report.months, ['2026-07', '2026-08']);
    assert.ok(db.state.has('reports.monthly.2026-08'));
    assert.equal(db.intents.size, 2);
    assert.deepEqual((await service(db).catchUp()).months, []);
    assert.equal(db.intents.size, 2);
  } finally {
    if (previous === undefined) delete process.env.DEMO_STAND;
    else process.env.DEMO_STAND = previous;
  }
});

test('first install only initializes the current-month cursor', async () => {
  const db = new FakeDb();
  assert.deepEqual((await service(db).catchUp()).months, []);
  assert.deepEqual(db.state.get('reports.monthly.cursor'), { version: 1, month: '2026-09' });
});

test('demo stand catchup freezes data but does not enqueue mail', async () => {
  const previous = process.env.DEMO_STAND;
  process.env.DEMO_STAND = 'true';
  try {
    const db = new FakeDb();
    db.state.set('reports.monthly.cursor', { version: 1, month: '2026-07' });
    await service(db).catchUp();
    assert.ok(db.state.has('reports.monthly.2026-08'));
    assert.equal(db.intents.size, 0);
  } finally {
    if (previous === undefined) delete process.env.DEMO_STAND;
    else process.env.DEMO_STAND = previous;
  }
});

test('monthly aggregation includes more than fifty ledger rows', async () => {
  const db = new FakeDb();
  db.rewardRows = Array.from({ length: 51 }, (_, index) => ({
    engineerId: `engineer-${index}`,
    points: 10,
    category: 'arrival',
    awardedAt: BigInt(NOW),
    engineer: { id: `engineer-${index}`, displayName: `Engineer ${index}` },
  }));
  const report = await service(db).read('2026-09');
  assert.equal(report.engineers.length, 51);
  assert.equal(report.totals.earnedPoints, 510);
});

test('monthly comparison includes engineers who made no voluntary marks', async () => {
  const db = new FakeDb();
  db.engineerRows = [
    { id: 'a', displayName: 'Алексей', archivedAt: null },
    { id: 'b', displayName: 'Мария', archivedAt: null },
  ];
  db.rewardRows = [{ engineerId: 'a', points: 40, category: 'arrival', awardedAt: BigInt(NOW) }];
  const report = await service(db).read('2026-09');
  assert.equal(report.totals.engineerCount, 2);
  assert.equal(report.totals.teamAverage, 20);
  assert.equal(report.engineers.find((row) => row.engineerId === 'a')?.ratio, 2);
  assert.equal(report.engineers.find((row) => row.engineerId === 'b')?.points, 0);
  assert.equal(report.engineers.find((row) => row.engineerId === 'b')?.ratio, 0);
});

test('monthly activity retains recorded zero-completion days and excludes future shifts', async () => {
  const db = new FakeDb();
  db.dayRows = [
    {
      engineerId: 'a',
      workDate: '2026-09-21',
      shiftStartAt: BigInt(NOW - 86400),
      shiftEndAt: BigInt(NOW - 86400 + 3600),
    },
    {
      engineerId: 'a',
      workDate: '2026-09-23',
      shiftStartAt: BigInt(NOW + 86400),
      shiftEndAt: BigInt(NOW + 86400 + 3600),
    },
  ];
  const report = await service(db).read('2026-09');
  assert.deepEqual(report.analytics?.dailySeries, [{ workDate: '2026-09-21', completed: 0 }]);
  assert.equal(report.analytics?.team.recordedWorkdays, 1);
});
