import { describe, expect, it } from 'vitest';
import { createDevSnapshot } from '../fixtures/dev-day';
import { filterSnapshotByRegion, regionOptions, regionStyle } from './regions';

describe('region dashboard projection', () => {
  it('uses three distinct official colors and stable uploaded-region colors', () => {
    const official = ['east', 'southeast', 'south_central'].map(
      (region) => regionStyle(region).color,
    );
    expect(new Set(official).size).toBe(3);
    expect(regionStyle('north_test')).toEqual(regionStyle('north_test'));
  });

  it('filters requests, engineers, routes and assignments together', () => {
    const base = createDevSnapshot();
    const engineer = base.engineers[0];
    const route = base.plan.plan?.routes[0];
    const assignment = base.plan.plan?.assignments.find((item) => item.engineerId === engineer?.id);
    expect(engineer && route && assignment).toBeTruthy();
    if (!engineer || !route || !assignment || !base.plan.plan) return;

    const snapshot = {
      ...base,
      engineers: base.engineers.map((item, index) => ({
        ...item,
        region: index === 0 ? 'east' : 'southeast',
      })),
      requests: base.requests.map((item) => ({
        ...item,
        region: item.id === assignment.requestId ? 'east' : 'southeast',
      })),
    };
    const east = filterSnapshotByRegion(snapshot, 'east');

    expect(east.engineers.map((item) => item.id)).toEqual([engineer.id]);
    expect(east.requests.map((item) => item.id)).toEqual([assignment.requestId]);
    expect(east.plan.plan?.routes.map((item) => item.engineerId)).toEqual([engineer.id]);
    expect(east.plan.plan?.assignments.map((item) => item.requestId)).toEqual([
      assignment.requestId,
    ]);
    expect(regionOptions(snapshot).map((item) => item.id)).toEqual(['east', 'southeast']);
  });
});
