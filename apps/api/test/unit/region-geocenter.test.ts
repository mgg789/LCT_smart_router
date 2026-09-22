import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  geocenterOf,
  nearestRegion,
  regionCenters,
} from '../../src/orchestrator/requests/region-geocenter';

describe('region geocenters', () => {
  it('averages the points of each region', () => {
    const centers = regionCenters([
      { region: 'east', lat: 55.8, lon: 37.8 },
      { region: 'east', lat: 55.82, lon: 37.84 },
      { region: 'southeast', lat: 55.7, lon: 37.75 },
    ]);
    assert.deepEqual(centers.get('east'), { lat: 55.81, lon: 37.82 });
    assert.deepEqual(centers.get('southeast'), { lat: 55.7, lon: 37.75 });
  });

  it('assigns a new point to the nearest existing region geocenter', () => {
    const centers = regionCenters([
      { region: 'east', lat: 55.8, lon: 37.85 },
      { region: 'southeast', lat: 55.68, lon: 37.78 },
      { region: 'south_central', lat: 55.72, lon: 37.62 },
    ]);
    assert.equal(nearestRegion({ lat: 55.805, lon: 37.84 }, centers), 'east');
    assert.equal(nearestRegion({ lat: 55.71, lon: 37.61 }, centers), 'south_central');
    assert.equal(nearestRegion({ lat: 55.69, lon: 37.79 }, centers), 'southeast');
  });

  it('returns null when no regional points exist yet', () => {
    assert.equal(geocenterOf([]), null);
    assert.equal(nearestRegion({ lat: 55.75, lon: 37.62 }, new Map()), null);
  });
});
