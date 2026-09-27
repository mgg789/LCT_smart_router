import { afterEach, expect, it, vi } from 'vitest';
import { setDispatchMode } from './client';
import { loadManualState, saveManualDecision, saveManualPriorities } from './manual';

const state = {
  version: 4,
  reason: 'Нужен контроль',
  decisions: [],
  resolution: null,
  needsReview: false,
};
afterEach(() => vi.unstubAllGlobals());
it('sends versioned explicit unassignment and preserves the raw manual state', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(state)));
  vi.stubGlobal('fetch', fetch);
  expect(
    await saveManualDecision('test', 3, {
      kind: 'assignment',
      targetId: 'request',
      engineerId: null,
    }),
  ).toEqual(state);
  expect(JSON.parse(fetch.mock.calls[0]?.[1].body)).toMatchObject({
    expectedVersion: 3,
    kind: 'assignment',
    targetId: 'request',
    engineerId: null,
  });
});
it('sends all priority ids in the chosen order and keeps the mandatory mode reason', async () => {
  const fetch = vi
    .fn()
    .mockImplementation(() => Promise.resolve(new Response(JSON.stringify(state))));
  vi.stubGlobal('fetch', fetch);
  await saveManualPriorities('test', 4, ['second', 'first']);
  expect(JSON.parse(fetch.mock.calls[0]?.[1].body)).toMatchObject({
    expectedVersion: 4,
    decisionIds: ['second', 'first'],
  });
  await setDispatchMode('test', 'manual', 'Нужен контроль');
  expect(JSON.parse(fetch.mock.calls[1]?.[1].body)).toMatchObject({
    mode: 'manual',
    reason: 'Нужен контроль',
  });
  expect(await loadManualState('test')).toEqual(state);
});
