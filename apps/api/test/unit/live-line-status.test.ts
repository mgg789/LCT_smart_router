import assert from 'node:assert/strict';
import { it } from 'node:test';
import { lineStatusAfterDispatcherAvailability } from '../../src/orchestrator/live/replan-policy';

const start = 1_000_000;

it('keeps an unchecked engineer pending before the no-show deadline', () => {
  assert.deepEqual(lineStatusAfterDispatcherAvailability('online', null, start + 10 * 60, start), {
    lineStatus: 'pending',
    lineStartedAt: null,
  });
});

it('confirms the line when the dispatcher restores a shift after the no-show deadline', () => {
  const liveNow = start + 31 * 60;
  assert.deepEqual(lineStatusAfterDispatcherAvailability('online', null, liveNow, start), {
    lineStatus: 'online',
    lineStartedAt: BigInt(liveNow),
  });
});

it('does not move the original line start when restoring someone who already checked in', () => {
  assert.deepEqual(
    lineStatusAfterDispatcherAvailability('online', BigInt(start + 5 * 60), start + 40 * 60, start),
    { lineStatus: 'online', lineStartedAt: BigInt(start + 5 * 60) },
  );
});

it('records a dispatcher removal as no-show offline without erasing the line start', () => {
  assert.deepEqual(
    lineStatusAfterDispatcherAvailability('offline', BigInt(start + 5 * 60), start + 40 * 60, start),
    { lineStatus: 'no_show_offline', lineStartedAt: BigInt(start + 5 * 60) },
  );
});
