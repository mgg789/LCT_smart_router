import assert from 'node:assert/strict';
import { it } from 'node:test';
import { businessNow } from '../../src/orchestrator/live/business-clock';
import type { Tx } from '../../src/persistence';

function txWithDays(days: unknown[]): Tx {
  return {
    liveWorkday: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        days.find((day) => {
          const row = day as { status: string; workDate: string };
          if (where.status && row.status !== where.status) return false;
          if (where.workDate && row.workDate !== where.workDate) return false;
          return true;
        }) ?? null,
    },
  } as unknown as Tx;
}

it('uses the accelerated logical clock instead of wall time', async () => {
  const now = await businessNow(
    txWithDays([
      {
        status: 'running',
        workDate: '2099-12-31',
        logicalStartAt: 1_000n,
        logicalEndAt: 10_000n,
        startedAtWallSec: 2_000n,
        speedDurationSec: 90,
      },
    ]),
    2_030,
  );
  assert.equal(now, 4_000);
});

it('uses the scoped finished day as its final logical time', async () => {
  const now = await businessNow(
    txWithDays([
      {
        status: 'finished',
        workDate: '2099-12-31',
        logicalStartAt: 1_000n,
        logicalEndAt: 10_000n,
        startedAtWallSec: 2_000n,
        finishedAt: 8_000n,
        speedDurationSec: 90,
      },
    ]),
    99_000,
    '2099-12-31',
  );
  assert.equal(now, 8_000);
});
