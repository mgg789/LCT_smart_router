import { describe, expect, it } from 'vitest';
import type { PlanRouteView } from '@/entities/plan';
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

  it('starts the line at the crew start and walks the stops in order', () => {
    const line = buildRouteLine(route);

    expect(line.features[0]?.geometry.coordinates).toEqual([
      [37.77, 55.69],
      [37.78, 55.7],
      [37.79, 55.71],
    ]);
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
