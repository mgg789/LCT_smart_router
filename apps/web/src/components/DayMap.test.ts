import { describe, expect, it } from 'vitest';
import type { PlanRouteView } from '../api/types';
import { projectLiveGraph } from '../domain/liveGraph';
import {
  liveProgressPoints,
  liveProgressPosition,
  liveProgressSegments,
  lunchMarkerCoordinates,
  visiblePlannedSegments,
} from './DayMap';

describe('LIVE map factual projection', () => {
  const anchor = { kind: 'job' as const, requestId: 'done', lat: 55.75, lon: 37.61, at: 100 };
  const next = { kind: 'job' as const, requestId: 'next', lat: 55.76, lon: 37.62, at: 200 };
  const origin = { kind: 'start' as const, requestId: null, lat: 55.74, lon: 37.6, at: 0 };

  it('retains the finished anchor and highlights its outgoing edge while traveling', () => {
    const progress = {
      phase: 'traveling' as const,
      origin,
      anchor,
      lunch: null,
      next,
      occurredAt: 110,
    };
    expect(liveProgressSegments(progress)).toEqual([{ from: anchor, to: next }]);
    expect(liveProgressPoints(progress)).toEqual([anchor]);
    expect(liveProgressPosition(progress)).toEqual({ lat: 55.751, lon: 37.611 });
  });

  it('projects lunch as both legs and the lunch vertex at once', () => {
    const lunch = { kind: 'lunch' as const, requestId: null, lat: 55.755, lon: 37.615, at: 150 };
    const progress = { phase: 'lunch' as const, origin, anchor, lunch, next, occurredAt: 150 };
    expect(liveProgressSegments(progress)).toEqual([
      { from: anchor, to: lunch },
      { from: lunch, to: next },
    ]);
    expect(liveProgressPoints(progress)).toEqual([anchor, lunch]);
  });

  it('moves a collocated lunch marker between its adjacent visits', () => {
    const graph = projectLiveGraph(null, {
      phase: 'traveling',
      origin,
      anchor,
      lunch: { kind: 'lunch', requestId: null, lat: anchor.lat, lon: anchor.lon, at: 150 },
      next,
      occurredAt: 150,
    });
    const lunchIndex = graph.mapNodes.findIndex((node) => node.kind === 'lunch');

    const [lon, lat] = lunchMarkerCoordinates(graph.mapNodes, lunchIndex);
    expect(lon).toBeCloseTo(37.615);
    expect(lat).toBeCloseTo(55.755);
  });

  it('keeps a distinct lunch marker at its Router position', () => {
    const lunch = { kind: 'lunch' as const, requestId: null, lat: 55.757, lon: 37.617, at: 150 };
    const graph = projectLiveGraph(null, {
      phase: 'traveling',
      origin,
      anchor,
      lunch,
      next,
      occurredAt: 150,
    });
    const lunchIndex = graph.mapNodes.findIndex((node) => node.kind === 'lunch');

    expect(lunchMarkerCoordinates(graph.mapNodes, lunchIndex)).toEqual([lunch.lon, lunch.lat]);
  });

  it('marks the current vertex without retaining a past connector after next job starts', () => {
    const progress = {
      phase: 'on_site' as const,
      origin,
      anchor: next,
      lunch: null,
      next: null,
      occurredAt: 200,
    };
    expect(liveProgressSegments(progress)).toEqual([]);
    expect(liveProgressPoints(progress)).toEqual([next]);
  });

  it('retains Router geometry only for visible planned edges', () => {
    const route: PlanRouteView = {
      engineerId: 'engineer',
      startLat: 55.74,
      startLon: 37.6,
      startAt: 0,
      finishAt: 300,
      distanceKm: 4,
      travelTimeSec: 200,
      workTimeSec: 100,
      waitingTimeSec: 0,
      lunchTimeSec: 0,
      assignedCount: 2,
      lunchStatus: 'none',
      stops: [
        {
          sequence: 1,
          kind: 'job',
          requestId: 'done',
          lat: 55.75,
          lon: 37.61,
          arrivalAt: 100,
          startAt: 100,
          endAt: 120,
        },
        {
          sequence: 2,
          kind: 'wait',
          requestId: null,
          lat: 55.76,
          lon: 37.62,
          arrivalAt: 150,
          startAt: 150,
          endAt: 160,
        },
        {
          sequence: 3,
          kind: 'job',
          requestId: 'next',
          lat: 55.76,
          lon: 37.62,
          arrivalAt: 160,
          startAt: 160,
          endAt: 200,
        },
      ],
      legs: [
        {
          legId: 'pruned-start',
          fromStopId: null,
          toStopId: 'done',
          departureAt: 0,
          arrivalAt: 100,
          travelTimeSec: 100,
          distanceKm: 2,
          travelSource: 'route_api',
          trafficFactor: 1,
          geometry: {
            points: [
              { lat: 55.74, lon: 37.6 },
              { lat: 55.745, lon: 37.605 },
              { lat: 55.75, lon: 37.61 },
            ],
          },
        },
        {
          legId: 'visible-router-path',
          fromStopId: 'done',
          toStopId: 'wait',
          departureAt: 120,
          arrivalAt: 150,
          travelTimeSec: 30,
          distanceKm: 2,
          travelSource: 'route_api',
          trafficFactor: 1,
          geometry: {
            points: [
              { lat: 55.75, lon: 37.61 },
              { lat: 55.755, lon: 37.615 },
              { lat: 55.76, lon: 37.62 },
            ],
          },
        },
      ],
    };
    const progress = {
      phase: 'on_site' as const,
      origin,
      anchor,
      lunch: null,
      next,
      occurredAt: 120,
    };
    const graph = projectLiveGraph(route, progress, new Set(['done', 'next']));
    const segments = visiblePlannedSegments(route, graph);

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      fromKey: 'job:done',
      toKey: 'job:next',
      source: 'route_api',
      approximate: false,
      coordinates: [
        [37.61, 55.75],
        [37.615, 55.755],
        [37.62, 55.76],
      ],
    });
    const nodeKeys = new Set(graph.mapNodes.map((node) => node.key));
    expect(
      segments.every((segment) => nodeKeys.has(segment.fromKey) && nodeKeys.has(segment.toKey)),
    ).toBe(true);
  });
});
