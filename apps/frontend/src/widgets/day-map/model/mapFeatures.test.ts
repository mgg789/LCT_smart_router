import { describe, expect, it } from 'vitest';
import type { PlanRouteLegView, PlanRouteView } from '@/entities/plan';
import type { RequestView } from '@/entities/request';
import { boundsOf, buildRequestPoints, buildRouteLine } from './mapFeatures';

function request(over: Partial<RequestView>): RequestView {
  return {
    id: 'r1',
    version: 1,
    lifecycle: 'submitted',
    assignmentState: 'assigned',
    addressText: 'Москва',
    region: 'east',
    lat: 55.7,
    lon: 37.7,
    needsGeocoding: false,
    geocodeQuality: null,
    workType: 'convergence',
    workTypeTitle: 'Конвергенция',
    requiredSkill: 'connection',
    requiredEquipment: null,
    normProfileCode: null,
    normativeTravelDurationSec: null,
    technicalDurationSec: null,
    documentationDurationSec: null,
    serviceDurationSec: null,
    actualDurationSec: null,
    durationVarianceSec: null,
    windowStartAt: 1,
    windowEndAt: 2,
    priority: 'normal',
    contactName: null,
    problemText: null,
    createdAt: 1,
    submittedAt: 1,
    startedAt: null,
    expectedCompletionAt: null,
    continuationAvailableAt: null,
    overrunDetectedAt: null,
    completedAt: null,
    cancelledAt: null,
    ...over,
  };
}

describe('buildRequestPoints', () => {
  it('leaves a request without coordinates off the map', () => {
    const points = buildRequestPoints([
      request({ id: 'has', lat: 55.7, lon: 37.7 }),
      request({ id: 'none', lat: null, lon: null, needsGeocoding: true }),
    ]);

    expect(points.features).toHaveLength(1);
    expect(points.features[0]?.properties.requestId).toBe('has');
  });

  it('drops cancelled work', () => {
    const points = buildRequestPoints([request({ id: 'x', lifecycle: 'cancelled' })]);

    expect(points.features).toHaveLength(0);
  });

  it('marks state and skill for the point styling', () => {
    const points = buildRequestPoints([
      request({ assignmentState: 'unassigned', requiredSkill: 'emergency' }),
    ]);

    expect(points.features[0]?.properties).toMatchObject({ state: 'unassigned', badge: 'А' });
  });
});

describe('buildRouteLine', () => {
  const route: PlanRouteView = {
    engineerId: 'e1',
    startLat: 55.69,
    startLon: 37.77,
    startAt: 1,
    finishAt: 2,
    distanceKm: 4,
    travelTimeSec: 60,
    workTimeSec: 60,
    waitingTimeSec: 0,
    lunchTimeSec: 0,
    assignedCount: 2,
    lunchStatus: 'not_scheduled',
    stops: [
      {
        sequence: 0,
        kind: 'job',
        requestId: 'r1',
        lat: 55.7,
        lon: 37.78,
        arrivalAt: 1,
        startAt: 1,
        endAt: 2,
      },
      {
        sequence: 1,
        kind: 'job',
        requestId: 'r2',
        lat: 55.71,
        lon: 37.79,
        arrivalAt: 2,
        startAt: 2,
        endAt: 3,
      },
    ],
  };

  const leg = (index: number, over: Partial<PlanRouteLegView>): PlanRouteLegView => ({
    legId: `e1:leg:${index}`,
    fromStopId: index === 0 ? null : `e1:${index - 1}`,
    toStopId: `e1:${index}`,
    departureAt: 0,
    arrivalAt: index + 1,
    travelTimeSec: 60,
    distanceKm: 1,
    geometry: null,
    travelSource: 'approximate',
    trafficFactor: 1,
    ...over,
  });

  it('starts at the crew start and walks the stops in order, straight when no road is known', () => {
    const line = buildRouteLine(route);

    expect(line.features.map((feature) => feature.geometry.coordinates)).toEqual([
      [
        [37.77, 55.69],
        [37.78, 55.7],
      ],
      [
        [37.78, 55.7],
        [37.79, 55.71],
      ],
    ]);
    expect(line.features.every((feature) => feature.properties.shape === 'straight')).toBe(true);
  });

  it('follows the road a leg carries', () => {
    const road = [
      { lat: 55.69, lon: 37.77 },
      { lat: 55.695, lon: 37.771 },
      { lat: 55.7, lon: 37.78 },
    ];
    const line = buildRouteLine({
      ...route,
      legs: [leg(0, { geometry: { points: road }, travelSource: 'road_matrix' }), leg(1, {})],
    });

    expect(line.features[0]?.properties.shape).toBe('road');
    expect(line.features[0]?.geometry.coordinates).toHaveLength(3);
    expect(line.features[1]?.properties.shape).toBe('straight');
  });

  it('does not call a bare two-point matrix leg a road', () => {
    const line = buildRouteLine({
      ...route,
      legs: [
        leg(0, {
          geometry: {
            points: [
              { lat: 55.69, lon: 37.77 },
              { lat: 55.7, lon: 37.78 },
            ],
          },
          travelSource: 'road_matrix',
        }),
      ],
    });

    expect(line.features[0]?.properties.shape).toBe('straight');
  });

  it('trusts a route API even when its road is short', () => {
    const line = buildRouteLine({
      ...route,
      legs: [
        leg(0, {
          geometry: {
            points: [
              { lat: 55.69, lon: 37.77 },
              { lat: 55.7, lon: 37.78 },
            ],
          },
          travelSource: 'route_api',
        }),
      ],
    });

    expect(line.features[0]?.properties.shape).toBe('road');
  });

  it('drops a leg whose arrival does not match its visit instead of drawing it wrong', () => {
    const road = [
      { lat: 50, lon: 30 },
      { lat: 50.5, lon: 30.5 },
      { lat: 51, lon: 31 },
    ];
    const line = buildRouteLine({
      ...route,
      legs: [leg(0, { arrivalAt: 999, geometry: { points: road }, travelSource: 'route_api' })],
    });

    expect(line.features[0]?.properties.shape).toBe('straight');
    expect(line.features[0]?.geometry.coordinates[1]).toEqual([37.78, 55.7]);
  });

  it('draws nothing when there is no route', () => {
    expect(buildRouteLine(null).features).toHaveLength(0);
  });
});

describe('boundsOf', () => {
  it('frames every point', () => {
    const points = buildRequestPoints([
      request({ id: 'a', lat: 55.6, lon: 37.5 }),
      request({ id: 'b', lat: 55.9, lon: 37.9 }),
    ]);

    expect(boundsOf(points)).toEqual([
      [37.5, 55.6],
      [37.9, 55.9],
    ]);
  });

  it('has nothing to frame on an empty day', () => {
    expect(boundsOf(buildRequestPoints([]))).toBeNull();
  });
});
