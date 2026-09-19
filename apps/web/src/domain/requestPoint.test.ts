import { describe, expect, it } from 'vitest';
import { createDevSnapshot } from '../fixtures/dev-day';
import { requestMapPoint } from './requestPoint';

describe('requestMapPoint', () => {
  it('uses the request pin when lat/lon are present', () => {
    const snapshot = createDevSnapshot();
    const request = snapshot.requests.find((item) => item.lat != null && item.lon != null);
    expect(request).toBeTruthy();
    expect(requestMapPoint(snapshot, request!.id)).toEqual({
      lat: request!.lat,
      lon: request!.lon,
    });
  });

  it('falls back to the planned stop when the request has no coordinates', () => {
    const snapshot = createDevSnapshot();
    const routed = snapshot.plan.plan?.routes
      .flatMap((route) => route.stops)
      .find((stop) => stop.requestId && stop.kind === 'job');
    expect(routed?.requestId).toBeTruthy();
    const requestId = routed!.requestId!;
    const stripped = {
      ...snapshot,
      requests: snapshot.requests.map((item) =>
        item.id === requestId ? { ...item, lat: null, lon: null } : item,
      ),
    };
    expect(requestMapPoint(stripped, requestId)).toEqual({
      lat: routed!.lat,
      lon: routed!.lon,
    });
  });
});
