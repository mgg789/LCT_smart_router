import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDevSnapshot } from '../fixtures/dev-day';
import { applyManualChange, manualExpectation, previewManualChange } from './manual';

afterEach(() => vi.unstubAllGlobals());

describe('manual API version and retry contract', () => {
  it('keeps the captured revision and operation id on duplicate submissions', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 201 }));
    vi.stubGlobal('fetch', fetch);
    const expected = manualExpectation(createDevSnapshot().plan);
    const change = { kind: 'reassign' as const, requestId: 'r', engineerId: 'e' };
    await applyManualChange('local-session', change, expected, 'stable-intention');
    fetch.mockResolvedValueOnce(new Response('{}', { status: 201 }));
    await applyManualChange('local-session', change, expected, 'stable-intention');
    for (const call of fetch.mock.calls)
      expect(JSON.parse(call[1].body)).toEqual({
        ...change,
        ...expected,
        operationId: 'stable-intention',
      });
  });

  it('refuses a preview with no declared timing provenance', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ queues: [], warnings: [], sourcePlanRevision: 1 })),
        ),
    );
    await expect(
      previewManualChange(
        'local-session',
        { kind: 'reorder', requestIds: ['r'], engineerId: 'e' },
        { expectedModeVersion: 1, expectedPlanRevision: 1 },
      ),
    ).rejects.toThrow('контракту');
  });
});
