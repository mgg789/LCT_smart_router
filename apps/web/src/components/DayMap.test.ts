import { describe, expect, it } from 'vitest';
import type { PlanRouteView } from '../api/types';
import { projectLiveGraph, withoutMapLunch } from '../domain/liveGraph';
import {
  liveProgressPoints,
  liveProgressPosition,
  liveProgressSegments,
  lunchMarkerCoordinates,
  plannedRoadsCoverEdge,
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

  it('connects visits across lunch on the map but retains lunch in the pipeline', () => {
    const lunch = { kind: 'lunch' as const, requestId: null, lat: 55.755, lon: 37.615, at: 150 };
    const progress = { phase: 'lunch' as const, origin, anchor, lunch, next, occurredAt: 150 };
    expect(liveProgressSegments(progress)).toEqual([{ from: anchor, to: next }]);
    expect(liveProgressPoints(progress)).toEqual([anchor]);
    expect(liveProgressPosition(progress)?.lat).toBeCloseTo(55.755);
    expect(liveProgressPosition(progress)?.lon).toBeCloseTo(37.615);
    const graph = withoutMapLunch(projectLiveGraph(null, progress));
    expect(graph.mapNodes.some((node) => node.kind === 'lunch')).toBe(false);
    expect(graph.timelineNodes.some((node) => node.kind === 'lunch')).toBe(true);
  });

  it('never invents a location for a collocated lunch marker', () => {
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
    expect(lon).toBe(anchor.lon);
    expect(lat).toBe(anchor.lat);
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

  it('does not collapse mixed access, metro and egress geometry during selection', () => {
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
          legId: 'mixed-visible-path',
          fromStopId: 'done',
          toStopId: 'next',
          departureAt: 120,
          arrivalAt: 160,
          travelTimeSec: 40,
          distanceKm: 2,
          travelSource: 'road_matrix',
          trafficFactor: 1,
          geometry: {
            points: [
              { lat: 55.75, lon: 37.61 },
              { lat: 55.76, lon: 37.62 },
            ],
          },
          segments: [
            {
              geometry: {
                points: [
                  { lat: 55.75, lon: 37.61 },
                  { lat: 55.752, lon: 37.613 },
                ],
              },
              travelSource: 'route_api',
              travelTimeSec: 10,
              distanceKm: 0.4,
            },
            {
              geometry: {
                points: [
                  { lat: 55.752, lon: 37.613 },
                  { lat: 55.758, lon: 37.618 },
                ],
              },
              travelSource: 'metro',
              travelTimeSec: 20,
              distanceKm: 1.2,
            },
            {
              geometry: {
                points: [
                  { lat: 55.758, lon: 37.618 },
                  { lat: 55.76, lon: 37.62 },
                ],
              },
              travelSource: 'route_api',
              travelTimeSec: 10,
              distanceKm: 0.4,
            },
          ],
        },
      ],
    };
    const graph = projectLiveGraph(route, null, new Set(['done', 'next']));
    const segments = visiblePlannedSegments(route, graph);
    expect(segments).toHaveLength(3);
    expect(segments.map((segment) => segment.source)).toEqual(['route_api', 'metro', 'route_api']);
    expect(segments.every((segment) => segment.fromKey === 'job:done')).toBe(true);
    expect(segments.every((segment) => segment.toKey === 'job:next')).toBe(true);
    const edge = graph.mapSegments.find(
      (item) => item.from.key === 'job:done' && item.to.key === 'job:next',
    );
    expect(edge && plannedRoadsCoverEdge(edge, segments.filter((item) => item.source === 'metro'))).toBe(
      true,
    );
  });

  it('keeps a road polyline when OSRM snapped the ends onto the carriageway', () => {
    const route: PlanRouteView = {
      engineerId: 'engineer',
      startLat: 55.74,
      startLon: 37.6,
      startAt: 0,
      finishAt: 200,
      distanceKm: 2,
      travelTimeSec: 40,
      workTimeSec: 40,
      waitingTimeSec: 0,
      lunchTimeSec: 0,
      assignedCount: 1,
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
          legId: 'snapped-road',
          fromStopId: 'done',
          toStopId: 'next',
          departureAt: 120,
          arrivalAt: 160,
          travelTimeSec: 40,
          distanceKm: 2,
          travelSource: 'traffic_api',
          trafficFactor: 1.2,
          geometry: {
            points: [
              { lat: 55.75025, lon: 37.61 },
              { lat: 55.755, lon: 37.615 },
              { lat: 55.76, lon: 37.6197 },
            ],
          },
        },
      ],
    };
    const graph = projectLiveGraph(route, null, new Set(['done', 'next']));
    const segments = visiblePlannedSegments(route, graph);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      fromKey: 'job:done',
      toKey: 'job:next',
      source: 'traffic_api',
      approximate: false,
    });
    expect(segments[0]?.coordinates).toHaveLength(3);
  });

  it('keeps a traffic-api shape on the stops the leg connects', () => {
    const route: PlanRouteView = {
      engineerId: 'engineer',
      startLat: 55.74,
      startLon: 37.6,
      startAt: 0,
      finishAt: 200,
      distanceKm: 2,
      travelTimeSec: 40,
      workTimeSec: 40,
      waitingTimeSec: 0,
      lunchTimeSec: 0,
      assignedCount: 1,
      lunchStatus: 'none',
      stops: [
        {
          sequence: 1,
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
          legId: 'far-road',
          fromStopId: null,
          toStopId: 'next',
          departureAt: 0,
          arrivalAt: 160,
          travelTimeSec: 40,
          distanceKm: 2,
          travelSource: 'traffic_api',
          trafficFactor: 1,
          geometry: {
            points: [
              { lat: 55.7, lon: 37.5 },
              { lat: 55.71, lon: 37.55 },
              { lat: 55.72, lon: 37.58 },
            ],
          },
        },
      ],
    };
    const graph = projectLiveGraph(route, null, new Set(['next']));
    const segments = visiblePlannedSegments(route, graph);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      fromKey: 'start',
      toKey: 'job:next',
      source: 'traffic_api',
      approximate: false,
    });
  });

  it('keeps roads around a collapsed lunch and covers the straight chord', () => {
    const route: PlanRouteView = {
      engineerId: 'engineer',
      startLat: 55.74,
      startLon: 37.6,
      startAt: 0,
      finishAt: 400,
      distanceKm: 4,
      travelTimeSec: 80,
      workTimeSec: 40,
      waitingTimeSec: 0,
      lunchTimeSec: 1800,
      assignedCount: 2,
      lunchStatus: 'planned',
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
          kind: 'lunch',
          requestId: null,
          lat: 55.755,
          lon: 37.615,
          arrivalAt: 140,
          startAt: 140,
          endAt: 200,
        },
        {
          sequence: 3,
          kind: 'job',
          requestId: 'next',
          lat: 55.76,
          lon: 37.62,
          arrivalAt: 240,
          startAt: 240,
          endAt: 280,
        },
      ],
      legs: [
        {
          legId: 'to-lunch',
          fromStopId: 'done',
          toStopId: 'lunch',
          departureAt: 120,
          arrivalAt: 140,
          travelTimeSec: 20,
          distanceKm: 1,
          travelSource: 'route_api',
          trafficFactor: 1,
          geometry: {
            points: [
              { lat: 55.75, lon: 37.61 },
              { lat: 55.752, lon: 37.612 },
              { lat: 55.755, lon: 37.615 },
            ],
          },
        },
        {
          legId: 'from-lunch',
          fromStopId: 'lunch',
          toStopId: 'next',
          departureAt: 200,
          arrivalAt: 240,
          travelTimeSec: 40,
          distanceKm: 1,
          travelSource: 'route_api',
          trafficFactor: 1,
          geometry: {
            points: [
              { lat: 55.755, lon: 37.615 },
              { lat: 55.758, lon: 37.618 },
              { lat: 55.76, lon: 37.62 },
            ],
          },
        },
      ],
    };
    const graph = withoutMapLunch(projectLiveGraph(route, null, new Set(['done', 'next'])));
    const segments = visiblePlannedSegments(route, graph);
    expect(segments.map((segment) => segment.source)).toEqual(['route_api', 'route_api']);
    const collapsed = graph.mapSegments.find(
      (edge) => edge.from.key === 'job:done' && edge.to.key === 'job:next',
    );
    expect(collapsed).toBeTruthy();
    if (collapsed) expect(plannedRoadsCoverEdge(collapsed, segments)).toBe(true);
  });

  it('binds a return visit to the later job when it shares the start pin', () => {
    const route: PlanRouteView = {
      engineerId: 'engineer',
      startLat: 55.71,
      startLon: 37.77,
      startAt: 0,
      finishAt: 400,
      distanceKm: 8,
      travelTimeSec: 200,
      workTimeSec: 80,
      waitingTimeSec: 0,
      lunchTimeSec: 0,
      assignedCount: 2,
      lunchStatus: 'none',
      stops: [
        {
          sequence: 1,
          kind: 'job',
          requestId: 'away',
          lat: 55.74,
          lon: 37.69,
          arrivalAt: 100,
          startAt: 100,
          endAt: 140,
        },
        {
          sequence: 2,
          kind: 'job',
          requestId: 'back',
          lat: 55.71,
          lon: 37.77,
          arrivalAt: 200,
          startAt: 200,
          endAt: 240,
        },
        {
          sequence: 3,
          kind: 'job',
          requestId: 'next',
          lat: 55.73,
          lon: 37.8,
          arrivalAt: 300,
          startAt: 300,
          endAt: 340,
        },
      ],
      legs: [
        {
          legId: 'return-out',
          fromStopId: 'back',
          toStopId: 'next',
          departureAt: 240,
          arrivalAt: 300,
          travelTimeSec: 60,
          distanceKm: 3,
          travelSource: 'metro',
          trafficFactor: 1,
          geometry: {
            points: [
              { lat: 55.71, lon: 37.77 },
              { lat: 55.73, lon: 37.8 },
            ],
          },
          segments: [
            {
              geometry: {
                points: [
                  { lat: 55.71, lon: 37.77 },
                  { lat: 55.72, lon: 37.78 },
                  { lat: 55.73, lon: 37.8 },
                ],
              },
              travelSource: 'metro',
              travelTimeSec: 60,
              distanceKm: 3,
            },
          ],
        },
      ],
    };
    const graph = projectLiveGraph(route, null, new Set(['away', 'back', 'next']));
    const segments = visiblePlannedSegments(route, graph);
    expect(segments.map((segment) => segment.fromKey)).toContain('job:back');
    expect(segments.map((segment) => segment.toKey)).toContain('job:next');
    const edge = graph.mapSegments.find(
      (item) => item.from.key === 'job:back' && item.to.key === 'job:next',
    );
    expect(edge && plannedRoadsCoverEdge(edge, segments)).toBe(true);
  });
});
