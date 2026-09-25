import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { updateOwnProfileSchema } from '../../src/api/dto/engineer.dto';
import { planSchema } from '../../src/routing/router-gateway/result.types';

const legSchema = planSchema.shape.routes.unwrap().element.shape.legs.unwrap().element;
const a = { lat: 55.72, lon: 37.75 };
const b = { lat: 55.73, lon: 37.75 };
const c = { lat: 55.75, lon: 37.65 };
const leg = {
  leg_id: 'metro',
  from_stop_id: null,
  to_stop_id: 'job',
  departure_at: 100,
  arrival_at: 700,
  travel_time_sec: 600,
  distance_km: 5,
  travel_source: 'metro',
  geometry: { points: [a, b, c] },
  segments: [
    {
      geometry: { points: [a, b] },
      travel_source: 'approximate',
      duration_sec: 200,
      distance_m: 1000,
    },
    { geometry: { points: [b, c] }, travel_source: 'metro', duration_sec: 400, distance_m: 4000 },
  ],
};

describe('metro contract', () => {
  it('preserves complete segment costs and rejects disconnected or inconsistent legs', () => {
    assert.equal(legSchema.parse(leg).segments?.length, 2);
    assert.equal(legSchema.safeParse({ ...leg, travel_time_sec: 601 }).success, false);
    assert.equal(legSchema.safeParse({ ...leg, segments: [] }).success, false);
    assert.equal(
      legSchema.safeParse({
        ...leg,
        segments: [
          leg.segments[0],
          {
            ...leg.segments[1],
            geometry: { points: [a, c] },
          },
        ],
      }).success,
      false,
    );
  });

  it('normalizes legacy transit profile input to the single pedestrian type', () => {
    assert.equal(
      updateOwnProfileSchema.parse({
        operationId: '11111111-1111-4111-a111-111111111111',
        transportType: 'transit',
      }).transportType,
      'walk',
    );
  });
});
