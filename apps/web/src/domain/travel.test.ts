import { describe, expect, it } from 'vitest';
import { createDevSnapshot } from '../fixtures/dev-day';
import { mapRouteSegments } from './travel';

describe('map travel geometry', () => {
  it('uses provider geometry only for route and traffic API legs', () => {
    const route = createDevSnapshot().plan.plan?.routes[0];
    expect(route).toBeTruthy();
    if (!route) return;
    const withGeometry = {
      ...route,
      legs: [
        {
          legId: 'leg-1',
          fromStopId: 'start',
          toStopId: 'first',
          departureAt: route.startAt ?? 0,
          arrivalAt: route.stops[0]?.arrivalAt ?? 0,
          travelTimeSec: 600,
          distanceKm: 4,
          travelSource: 'route_api' as const,
          trafficFactor: 1.25,
          geometry: {
            points: [
              { lat: 55.7, lon: 37.5 },
              { lat: 55.75, lon: 37.61 },
            ],
          },
        },
      ],
    };

    expect(mapRouteSegments(withGeometry)[0]).toMatchObject({
      source: 'route_api',
      approximate: false,
      coordinates: [
        [37.5, 55.7],
        [37.61, 55.75],
      ],
    });
  });

  it('draws a straight dashed segment for approximate travel', () => {
    const route = createDevSnapshot().plan.plan?.routes[0];
    expect(route).toBeTruthy();
    if (!route) return;
    const segment = mapRouteSegments({ ...route, legs: [] })[0];
    expect(segment?.source).toBe('approximate');
    expect(segment?.approximate).toBe(true);
    expect(segment?.coordinates).toHaveLength(2);
  });

  it('keeps a road-matrix leg schematic when no road geometry was supplied', () => {
    const route = createDevSnapshot().plan.plan?.routes[0];
    expect(route).toBeTruthy();
    if (!route) return;
    const segment = mapRouteSegments({
      ...route,
      legs: [
        {
          legId: 'matrix-leg',
          fromStopId: null,
          toStopId: 'first',
          departureAt: route.startAt ?? 0,
          arrivalAt: route.stops[0]?.arrivalAt ?? 0,
          travelTimeSec: 600,
          distanceKm: 4,
          travelSource: 'road_matrix',
          trafficFactor: 1.2,
          geometry: null,
        },
      ],
    })[0];
    expect(segment).toMatchObject({ source: 'road_matrix', approximate: true });
  });

  it('keeps traffic matrix output schematic when the provider supplied no geometry', () => {
    const route = createDevSnapshot().plan.plan?.routes[0];
    expect(route).toBeTruthy();
    if (!route) return;
    const segment = mapRouteSegments({
      ...route,
      legs: [
        {
          legId: 'traffic-matrix-leg',
          fromStopId: null,
          toStopId: 'first',
          departureAt: route.startAt ?? 0,
          arrivalAt: route.stops[0]?.arrivalAt ?? 0,
          travelTimeSec: 600,
          distanceKm: 4,
          travelSource: 'traffic_api',
          trafficFactor: 1,
          geometry: null,
        },
      ],
    })[0];
    expect(segment).toMatchObject({ source: 'traffic_api', approximate: true });
    expect(segment?.coordinates).toHaveLength(2);
  });

  it('matches persisted legs by schedule when lunch and wait stops sit between jobs', () => {
    const route = createDevSnapshot().plan.plan?.routes[0];
    expect(route).toBeTruthy();
    if (!route) return;
    const startAt = route.startAt ?? 1_800_000_000;
    const firstJob = {
      sequence: 0,
      kind: 'job' as const,
      requestId: 'first',
      lat: 55.71,
      lon: 37.51,
      arrivalAt: startAt + 600,
      startAt: startAt + 600,
      endAt: startAt + 1_200,
    };
    const lunch = {
      sequence: 1,
      kind: 'lunch' as const,
      requestId: null,
      lat: 55.71,
      lon: 37.51,
      arrivalAt: startAt + 1_200,
      startAt: startAt + 1_200,
      endAt: startAt + 1_800,
    };
    const wait = {
      sequence: 2,
      kind: 'wait' as const,
      requestId: null,
      lat: 55.81,
      lon: 37.71,
      arrivalAt: startAt + 2_400,
      startAt: startAt + 2_400,
      endAt: startAt + 2_700,
    };
    const secondJob = {
      sequence: 3,
      kind: 'job' as const,
      requestId: 'second',
      lat: 55.81,
      lon: 37.71,
      arrivalAt: startAt + 2_400,
      startAt: startAt + 2_700,
      endAt: startAt + 3_300,
    };
    const segments = mapRouteSegments({
      ...route,
      stops: [firstJob, lunch, wait, secondJob],
      legs: [
        {
          legId: 'leg-1',
          fromStopId: null,
          toStopId: 'stop-0',
          departureAt: startAt,
          arrivalAt: firstJob.arrivalAt,
          travelTimeSec: 600,
          distanceKm: 2,
          travelSource: 'approximate',
          trafficFactor: 1,
          geometry: null,
        },
        {
          legId: 'leg-2',
          fromStopId: 'stop-1',
          toStopId: 'stop-2',
          departureAt: lunch.endAt,
          arrivalAt: wait.arrivalAt,
          travelTimeSec: 600,
          distanceKm: 4,
          travelSource: 'road_matrix',
          trafficFactor: 1.2,
          geometry: null,
        },
      ],
    });

    expect(segments).toHaveLength(2);
    expect(segments[1]?.coordinates).toEqual([
      [lunch.lon, lunch.lat],
      [wait.lon, wait.lat],
    ]);
  });
});
