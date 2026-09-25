import assert from 'node:assert/strict';
import test from 'node:test';
import { arrivalReward, completionReward } from '../../src/orchestrator/rewards/reward-policy';

const base = {
  plannedAt: 1_000,
  actionRecordedAt: 900,
  ownerMatches: true,
};

test('reward policy awards ordinary arrival at or before the frozen plan', () => {
  assert.deepEqual(arrivalReward({ ...base, actualAt: 1_000, windowStartAt: 800 }), {
    points: 40,
    kind: 'ordinary',
  });
  assert.deepEqual(arrivalReward({ ...base, actualAt: 999, windowStartAt: 800 }), {
    points: 40,
    kind: 'ordinary',
  });
});

test('revised arrival accepts only the ten minute pre-promise corridor', () => {
  const input = {
    ...base,
    actualAt: 1_590,
    promiseAt: 1_600,
    promiseRecordedAt: 700,
    baselineAt: 1_000,
    windowStartAt: 800,
  };
  assert.deepEqual(arrivalReward(input), { points: 30, kind: 'revised', corridorSec: 600 });
  assert.equal(arrivalReward({ ...input, actualAt: 1_900, promiseAt: 2_600 }), null);
  assert.equal(arrivalReward({ ...input, actualAt: 1_601 }), null);
});

test('late revised promise cannot farm arrival points', () => {
  assert.equal(
    arrivalReward({
      ...base,
      actionRecordedAt: 1_300,
      actualAt: 1_590,
      promiseAt: 1_600,
      promiseRecordedAt: 1_001,
      baselineAt: 1_000,
      windowStartAt: 800,
    }),
    null,
  );
});

test('completion uses the same ten minute pre-promise corridor', () => {
  assert.deepEqual(
    completionReward({
      ...base,
      actionRecordedAt: 1_300,
      actualAt: 1_590,
      promiseAt: 1_600,
      promiseRecordedAt: 700,
      baselineAt: 1_000,
    }),
    { points: 30, kind: 'revised', corridorSec: 600 },
  );
  assert.deepEqual(completionReward({ ...base, actualAt: 999 }), { points: 40, kind: 'ordinary' });
});

test('completion can use a first extension accepted after the original norm', () => {
  assert.deepEqual(
    completionReward({
      ...base,
      actionRecordedAt: 1_300,
      actualAt: 1_590,
      promiseAt: 1_600,
      promiseRecordedAt: 1_200,
      baselineAt: 1_000,
      allowAfterBaseline: true,
    }),
    { points: 30, kind: 'revised', corridorSec: 600 },
  );
});
