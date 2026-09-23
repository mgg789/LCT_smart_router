import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  readDispatcherConstraints,
  withDispatcherConstraints,
} from '../../src/routing/dispatcher-constraints';
import type { RouterTaskSnapshot } from '../../src/routing/mount-data-eng';

const snapshot: RouterTaskSnapshot = {
  schema_version: '1.0',
  planning_as_of: 100,
  horizon_start_at: 100,
  horizon_end_at: 10000,
  engineers: [],
  policy: { policy_id: 'compact', parameters: {} },
  requests: [
    {
      request_id: 'remaining',
      region: 'east',
      arrival_order: 1,
      location: { lat: 55.7, lon: 37.6 },
      service_duration_sec: 600,
      window_start_at: 100,
      window_end_at: 10000,
      priority: 'normal',
      required_skill: 'local',
      required_transport: null,
      required_equipment: null,
    },
  ],
};

describe('dispatcher pin projection', () => {
  it('does not revive completed or reserved work and removes empty relative orders', () => {
    const pins = readDispatcherConstraints({
      assignments: [
        { requestId: 'completed', engineerId: 'e' },
        { requestId: 'remaining', engineerId: 'e' },
      ],
      orders: [{ engineerId: 'e', requestIds: ['completed', 'remaining'] }],
    });
    const projected = withDispatcherConstraints(snapshot, pins);
    assert.equal(projected.requests.length, 1);
    assert.equal(projected.requests[0]?.pinned_engineer_id, 'e');
    assert.equal(projected.pinned_orders, undefined);
  });

  it('clears old pin fields when a reviewed release is projected', () => {
    const pinned = withDispatcherConstraints(snapshot, {
      assignments: [{ requestId: 'remaining', engineerId: 'e' }],
      orders: [],
    });
    assert.deepEqual(withDispatcherConstraints(pinned, { assignments: [], orders: [] }), snapshot);
  });

  it('refuses an order that contradicts assignment pins', () => {
    assert.throws(() =>
      readDispatcherConstraints({
        assignments: [{ requestId: 'a', engineerId: 'e' }],
        orders: [{ engineerId: 'e', requestIds: ['a', 'b'] }],
      }),
    );
  });
});
