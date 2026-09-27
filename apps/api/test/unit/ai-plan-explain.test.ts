import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ExplainSnapshot } from '../../src/ai/explain/case-explanation';
import { renderPlanContext } from '../../src/ai/explain/explain.service';

describe('plan explanation context', () => {
  it('uses only the applied plan and explicitly excludes uncomputed reliability', () => {
    const snapshot: ExplainSnapshot = {
      policyId: 'balanced',
      engineers: [],
      requests: [],
      plan: {
        plan: {
          routes: [
            {
              engineerId: 'e-1',
              assignedCount: 1,
              distanceKm: 12,
              travelTimeSec: 1800,
              stops: [],
              legs: [],
            },
          ],
          assignments: [
            { requestId: 'r-1', status: 'assigned', engineerId: 'e-1', reasons: {} },
            { requestId: 'r-2', status: 'unassigned', engineerId: null, reasons: {} },
          ],
        },
      },
    };
    const context = renderPlanContext(snapshot);
    assert.match(context, /balanced/);
    assert.match(context, /без назначения: 1/);
    assert.match(context, /r-2/);
    assert.match(context, /12 км/);
    assert.match(context, /не рассчитывались/);
  });
});
