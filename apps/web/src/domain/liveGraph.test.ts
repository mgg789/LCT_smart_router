import { describe, expect, it } from 'vitest';
import type { LiveRouteProgress } from '../api/live';
import type { PlanRouteView } from '../api/types';
import { createDevSnapshot } from '../fixtures/dev-day';
import { projectLiveGraph } from './liveGraph';

type ExactStatePoint = 'start' | 'j1' | 'j2' | 'j3';
interface ExactStateScenario {
  readonly name: string;
  readonly progress: LiveRouteProgress['phase'];
  readonly anchor: ExactStatePoint;
  readonly lunch: boolean;
  readonly next: ExactStatePoint | null;
  readonly map: readonly string[];
  readonly activeNodes: readonly string[];
  readonly activeSegments: readonly string[];
}

describe('LIVE graph projection', () => {
  it('uses a reported arrival and then the actual start instead of stale planned times', () => {
    const points = pointsForExactState();
    for (const started of [false, true]) {
      const arrival = { ...points.j2, at: 350 };
      const graph = projectLiveGraph(exactStateRoute(), {
        phase: started ? 'on_site' : 'traveling',
        origin: points.start,
        anchor: started ? arrival : points.j1,
        lunch: null,
        next: started ? points.j3 : arrival,
        occurredAt: 350,
      });
      expect(graph.timelineNodes.find((node) => node.requestId === 'j2')?.at).toBe(350);
    }
  });
  it('replaces a stale planned lunch with its single durable location and time', () => {
    const points = pointsForExactState();
    const lunch = { kind: 'lunch' as const, requestId: null, lat: 55.77, lon: 37.64, at: 250 };
    const graph = projectLiveGraph(exactStateRoute(), {
      phase: 'lunch',
      origin: points.start,
      anchor: points.j1,
      lunch,
      next: points.j2,
      occurredAt: 260,
    });
    for (const nodes of [graph.mapNodes, graph.timelineNodes]) {
      const lunches = nodes.filter((node) => node.kind === 'lunch');
      expect(lunches).toHaveLength(1);
      expect(lunches[0]).toMatchObject(lunch);
    }
  });
  it('keeps an actual lunch without requiring a following job or a stale route', () => {
    const points = pointsForExactState();
    const lunch = { kind: 'lunch' as const, requestId: null, lat: 55.77, lon: 37.64, at: 250 };
    const graph = projectLiveGraph(null, {
      phase: 'lunch',
      origin: points.start,
      anchor: points.j1,
      lunch,
      next: null,
      occurredAt: 260,
    });
    expect(graph.mapNodes.filter((node) => node.kind === 'lunch')).toHaveLength(1);
    expect(graph.activeNodeKeys.has('lunch:55.770000:37.640000')).toBe(true);
  });

  it('does not restore past lunch after completed anchors are hidden', () => {
    const points = pointsForExactState();
    const graph = projectLiveGraph(
      exactStateRoute(),
      {
        phase: 'finished',
        origin: points.start,
        anchor: points.j3,
        lunch: null,
        next: null,
        occurredAt: 460,
      },
      new Set(),
    );
    expect(graph.mapNodes.map((node) => node.key)).toEqual(['job:j3']);
    expect(graph.mapSegments).toEqual([]);
    expect(graph.timelineNodes.some((node) => node.kind === 'lunch')).toBe(true);
  });
  const origin = { kind: 'start' as const, requestId: null, lat: 55.74, lon: 37.6, at: 0 };
  const first = { kind: 'job' as const, requestId: 'first', lat: 55.75, lon: 37.61, at: 100 };
  const second = { kind: 'job' as const, requestId: 'second', lat: 55.76, lon: 37.62, at: 200 };

  it('marks only the stable start vertex before the engineer goes online', () => {
    const graph = projectLiveGraph(null, {
      phase: 'not_started',
      origin,
      anchor: origin,
      lunch: null,
      next: first,
      occurredAt: 0,
    });
    expect(graph.mapNodes.map((node) => node.key)).toEqual(['start', 'job:first']);
    expect([...graph.activeNodeKeys]).toEqual(['start']);
    expect(graph.activeSegments).toEqual([]);
  });

  it('keeps the previous vertex while its outgoing edge is factual', () => {
    const graph = projectLiveGraph(null, {
      phase: 'traveling',
      origin,
      anchor: first,
      lunch: null,
      next: second,
      occurredAt: 120,
    });
    expect(graph.mapNodes.map((node) => node.key)).toEqual(['job:first', 'job:second']);
    expect(graph.activeSegments.map((segment) => segment.key)).toEqual(['job:first->job:second']);
  });

  it('projects lunch as a single active compound span until the next job starts', () => {
    const lunch = { kind: 'lunch' as const, requestId: null, lat: 55.755, lon: 37.615, at: 150 };
    const graph = projectLiveGraph(null, {
      phase: 'traveling',
      origin,
      anchor: first,
      lunch,
      next: second,
      occurredAt: 180,
    });
    expect(graph.activeSegments.map((segment) => segment.key)).toEqual([
      'job:first->lunch:55.755000:37.615000',
      'lunch:55.755000:37.615000->job:second',
    ]);
    expect([...graph.activeNodeKeys]).toEqual(['lunch:55.755000:37.615000']);
  });

  it('keeps Start day first in the pipeline after a route revision', () => {
    const route = createDevSnapshot().plan.plan?.routes[0];
    if (!route) throw new Error('Fixture requires a route');
    const graph = projectLiveGraph(route, {
      phase: 'on_site',
      origin,
      anchor: first,
      lunch: null,
      next: null,
      occurredAt: 120,
    });
    expect(graph.timelineNodes[0]?.key).toBe('start');
    expect([...graph.activeNodeKeys]).toEqual(['job:first']);
  });

  const exactStateScenarios: readonly ExactStateScenario[] = [
    {
      name: 'before opening the engineer app',
      progress: 'not_started',
      anchor: 'start',
      lunch: false,
      next: 'j1',
      map: ['start', 'job:j1', 'job:j2', 'lunch:55.770000:37.630000', 'job:j3'],
      activeNodes: ['start'],
      activeSegments: [],
    },
    {
      name: 'after going online',
      progress: 'traveling',
      anchor: 'start',
      lunch: false,
      next: 'j1',
      map: ['start', 'job:j1', 'job:j2', 'lunch:55.770000:37.630000', 'job:j3'],
      activeNodes: [],
      activeSegments: ['start->job:j1'],
    },
    {
      name: 'after starting the first job',
      progress: 'on_site',
      anchor: 'j1',
      lunch: false,
      next: null,
      map: ['job:j1', 'job:j2', 'lunch:55.770000:37.630000', 'job:j3'],
      activeNodes: ['job:j1'],
      activeSegments: [],
    },
    {
      name: 'after finishing the first job',
      progress: 'traveling',
      anchor: 'j1',
      lunch: false,
      next: 'j2',
      map: ['job:j1', 'job:j2', 'lunch:55.770000:37.630000', 'job:j3'],
      activeNodes: [],
      activeSegments: ['job:j1->job:j2'],
    },
    {
      name: 'after finishing the job before lunch',
      progress: 'traveling',
      anchor: 'j2',
      lunch: true,
      next: 'j3',
      map: ['job:j2', 'lunch:55.770000:37.630000', 'job:j3'],
      activeNodes: ['lunch:55.770000:37.630000'],
      activeSegments: ['job:j2->lunch:55.770000:37.630000', 'lunch:55.770000:37.630000->job:j3'],
    },
    {
      name: 'after starting the third job',
      progress: 'on_site',
      anchor: 'j3',
      lunch: false,
      next: null,
      map: ['job:j3'],
      activeNodes: ['job:j3'],
      activeSegments: [],
    },
  ];

  it.each(exactStateScenarios)('keeps map and pipeline state exact: $name', (scenario) => {
    const route = exactStateRoute();
    const points = pointsForExactState();
    const anchor = points[scenario.anchor];
    const next = scenario.next === null ? null : points[scenario.next];
    if (!anchor || (scenario.next !== null && !next)) throw new Error('Invalid test scenario');
    const progress: LiveRouteProgress = {
      phase: scenario.progress,
      origin: points.start,
      anchor,
      lunch: scenario.lunch ? points.lunch : null,
      next,
      occurredAt: 120,
    };
    const graph = projectLiveGraph(route, progress);

    expect(graph.timelineNodes.map((node) => node.key)).toEqual([
      'start',
      'job:j1',
      'job:j2',
      'lunch:55.770000:37.630000',
      'job:j3',
    ]);
    expect(graph.timelineNodes.map((node) => node.kind)).not.toContain('wait');
    expect(graph.mapNodes.map((node) => node.key)).toEqual(scenario.map);
    expect([...graph.activeNodeKeys]).toEqual(scenario.activeNodes);
    expect(graph.activeSegments.map((segment) => segment.key)).toEqual(scenario.activeSegments);
    const mapNodeKeys = new Set(graph.mapNodes.map((node) => node.key));
    for (const segment of graph.mapSegments) {
      expect(mapNodeKeys.has(segment.from.key)).toBe(true);
      expect(mapNodeKeys.has(segment.to.key)).toBe(true);
    }
  });
});

function pointsForExactState() {
  return {
    start: { kind: 'start' as const, requestId: null, lat: 55.74, lon: 37.6, at: 0 },
    j1: { kind: 'job' as const, requestId: 'j1', lat: 55.75, lon: 37.61, at: 100 },
    j2: { kind: 'job' as const, requestId: 'j2', lat: 55.76, lon: 37.62, at: 200 },
    lunch: { kind: 'lunch' as const, requestId: null, lat: 55.77, lon: 37.63, at: 300 },
    j3: { kind: 'job' as const, requestId: 'j3', lat: 55.78, lon: 37.64, at: 400 },
  };
}

function exactStateRoute(): PlanRouteView {
  const points = pointsForExactState();
  return {
    engineerId: 'engineer',
    startLat: points.start.lat,
    startLon: points.start.lon,
    startAt: points.start.at,
    finishAt: 500,
    distanceKm: 1,
    travelTimeSec: 1,
    workTimeSec: 1,
    waitingTimeSec: 1,
    lunchTimeSec: 1,
    assignedCount: 3,
    lunchStatus: 'planned',
    legs: [],
    stops: [
      {
        sequence: 1,
        kind: 'wait',
        requestId: null,
        lat: 55.745,
        lon: 37.605,
        arrivalAt: 50,
        startAt: 50,
        endAt: 90,
      },
      {
        sequence: 2,
        kind: 'job',
        requestId: 'j1',
        lat: points.j1.lat,
        lon: points.j1.lon,
        arrivalAt: 100,
        startAt: 100,
        endAt: 150,
      },
      {
        sequence: 3,
        kind: 'job',
        requestId: 'j2',
        lat: points.j2.lat,
        lon: points.j2.lon,
        arrivalAt: 200,
        startAt: 200,
        endAt: 250,
      },
      {
        sequence: 4,
        kind: 'lunch',
        requestId: null,
        lat: points.lunch.lat,
        lon: points.lunch.lon,
        arrivalAt: 300,
        startAt: 300,
        endAt: 330,
      },
      {
        sequence: 5,
        kind: 'job',
        requestId: 'j3',
        lat: points.j3.lat,
        lon: points.j3.lon,
        arrivalAt: 400,
        startAt: 400,
        endAt: 450,
      },
    ],
  };
}
