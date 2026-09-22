import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { DEFAULT_DISPATCHER_SETTINGS } from '../../src/orchestrator/settings/dispatcher-settings';
import { MapRoutingClient } from '../../src/orchestrator/settings/map-routing-client';

// Synthetic coordinates, using the documented 2GIS detailed-response structure.
const detailedResponse = {
  status: 'OK',
  query: { transport: 'driving', traffic_mode: 'jam' },
  result: [
    {
      total_distance: 1250,
      total_duration: 240,
      begin_pedestrian_path: { geometry: { selection: 'LINESTRING(37.60 55.70, 37.61 55.71)' } },
      maneuvers: [
        {
          outcoming_path: {
            geometry: [
              { selection: 'LINESTRING(37.61 55.71, 37.62 55.72)', color: 'slow' },
              { selection: 'LINESTRING(37.62 55.72, 37.63 55.73)', color: 'normal' },
            ],
          },
        },
      ],
      end_pedestrian_path: { geometry: { selection: 'LINESTRING(37.63 55.73, 37.64 55.74)' } },
    },
  ],
};

describe('map routing integration', () => {
  it('reads detailed 2GIS geometry in travel order including access paths', async () => {
    const mocked = mock.method(globalThis, 'fetch', async () => Response.json(detailedResponse));
    try {
      const client = new MapRoutingClient();
      const { route } = await client.quote(
        { lat: 55.7, lon: 37.6 },
        { lat: 55.74, lon: 37.64 },
        true,
        'car',
        { ...DEFAULT_DISPATCHER_SETTINGS, twogisApiKey: 'test-key' },
      );
      assert.ok(route, 'documented nested selection geometry must produce a route');
      assert.deepEqual(route.points, [
        { lon: 37.6, lat: 55.7 },
        { lon: 37.61, lat: 55.71 },
        { lon: 37.62, lat: 55.72 },
        { lon: 37.63, lat: 55.73 },
        { lon: 37.64, lat: 55.74 },
      ]);
      assert.equal(route.durationSec, 240);
      assert.equal(route.distanceKm, 1.25);
      assert.equal(route.traffic, true);
    } finally {
      mocked.mock.restore();
    }
  });
});
