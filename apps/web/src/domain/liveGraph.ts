import type { LiveRoutePoint, LiveRouteProgress } from '../api/live';
import type { PlanRouteView } from '../api/types';
import { routeVertices } from './dashboard';

/** A stable, drawable LIVE vertex shared by the map and horizontal pipeline. */
export interface LiveGraphNode extends LiveRoutePoint {
  readonly key: string;
  readonly sequence: number;
}

/** A connecting edge. Both endpoints are always part of the same projection. */
export interface LiveGraphSegment {
  readonly key: string;
  readonly from: LiveGraphNode;
  readonly to: LiveGraphNode;
}

/**
 * One factual projection of a mutable route.
 *
 * The pipeline retains every stable visit, whereas the map begins at the
 * factual anchor. This is what makes a completed vertex disappear only after
 * the engineer has explicitly reached the next one.
 */
export interface LiveGraphProjection {
  readonly timelineNodes: readonly LiveGraphNode[];
  readonly mapNodes: readonly LiveGraphNode[];
  readonly mapSegments: readonly LiveGraphSegment[];
  readonly activeNodeKeys: ReadonlySet<string>;
  readonly activeSegmentKeys: ReadonlySet<string>;
  readonly activeSegments: readonly LiveGraphSegment[];
}

/**
 * Projects a route and its durable movement fact into map and pipeline state.
 * Wait stops are intentionally excluded: they are schedule intervals, not
 * graph vertices. `visibleRequestIds` lets the map hide terminal work while
 * the timeline still keeps that work in its history.
 */
export function projectLiveGraph(
  route: PlanRouteView | null,
  progress: LiveRouteProgress | null,
  visibleRequestIds?: ReadonlySet<string>,
): LiveGraphProjection {
  const routeNodes = stableRouteNodes(route).filter(
    (node) =>
      node.kind !== 'job' ||
      visibleRequestIds === undefined ||
      node.requestId === null ||
      visibleRequestIds.has(node.requestId),
  );
  const origin = progress ? nodeFromPoint(progress.origin, 0) : (routeNodes[0] ?? null);
  const planned = routeNodes.filter((node) => node.kind !== 'start');
  const factual = progress ? [progress.anchor, progress.lunch, progress.next].filter(isPoint) : [];
  const timelineNodes = origin
    ? dedupeNodes([
        origin,
        ...planned,
        ...factual.map((point) => nodeFromPoint(point, nodeSequence(point, planned))),
      ])
    : dedupeNodes([
        ...planned,
        ...factual.map((point) => nodeFromPoint(point, nodeSequence(point, planned))),
      ]);
  const orderedTimeline = orderTimeline(timelineNodes);

  const mapNodes = projectMapNodes(origin, planned, progress);
  const mapSegments = segmentsFor(mapNodes);
  const activeSegments = activePath(progress).flatMap(([from, to]) => {
    const fromNode = mapNodes.find((node) => samePoint(node, from));
    const toNode = mapNodes.find((node) => samePoint(node, to));
    return fromNode && toNode
      ? [{ key: segmentKey(fromNode, toNode), from: fromNode, to: toNode }]
      : [];
  });
  const activeNodeKeys = new Set<string>();
  if (progress?.phase === 'not_started') {
    activeNodeKeys.add(nodeKey(progress.origin));
  }
  if (progress?.phase === 'on_site') {
    activeNodeKeys.add(nodeKey(progress.anchor));
  }
  if (
    (progress?.phase === 'lunch' || (progress?.phase === 'traveling' && progress.lunch)) &&
    progress.lunch
  ) {
    activeNodeKeys.add(nodeKey(progress.lunch));
  }

  return {
    timelineNodes: orderedTimeline,
    mapNodes,
    mapSegments,
    activeNodeKeys,
    activeSegmentKeys: new Set(activeSegments.map((segment) => segment.key)),
    activeSegments,
  };
}

/** Stable identity does not depend on a plan revision or planned timestamp. */
export function nodeKey(point: LiveRoutePoint): string {
  if (point.kind === 'start') return 'start';
  if (point.kind === 'job' && point.requestId) return `job:${point.requestId}`;
  return `lunch:${point.lat.toFixed(6)}:${point.lon.toFixed(6)}`;
}

/** Edge identity is used by both the map stroke and the pipeline connector. */
export function segmentKey(from: LiveGraphNode, to: LiveGraphNode): string {
  return `${from.key}->${to.key}`;
}

function stableRouteNodes(route: PlanRouteView | null): LiveGraphNode[] {
  if (!route) return [];
  return routeVertices(route)
    .filter((vertex) => vertex.kind !== 'wait')
    .map((vertex) => ({
      kind: vertex.kind === 'wait' ? 'job' : vertex.kind,
      requestId: vertex.requestId,
      lat: vertex.lat,
      lon: vertex.lon,
      at: vertex.startAt,
      key:
        vertex.kind === 'start'
          ? 'start'
          : nodeKey({
              kind: vertex.kind === 'lunch' ? 'lunch' : 'job',
              requestId: vertex.requestId,
              lat: vertex.lat,
              lon: vertex.lon,
              at: vertex.startAt,
            }),
      sequence: vertex.sequence,
    }));
}

function nodeFromPoint(point: LiveRoutePoint, sequence: number): LiveGraphNode {
  return { ...point, key: nodeKey(point), sequence };
}

function nodeSequence(point: LiveRoutePoint, planned: readonly LiveGraphNode[]): number {
  return planned.find((node) => samePoint(node, point))?.sequence ?? Number.MAX_SAFE_INTEGER;
}

function isPoint(point: LiveRoutePoint | null): point is LiveRoutePoint {
  return point !== null;
}

function samePoint(
  left: Pick<LiveRoutePoint, 'kind' | 'requestId' | 'lat' | 'lon'>,
  right: Pick<LiveRoutePoint, 'kind' | 'requestId' | 'lat' | 'lon'>,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'job') return left.requestId !== null && left.requestId === right.requestId;
  if (left.kind === 'start') return true;
  return left.lat === right.lat && left.lon === right.lon;
}

function dedupeNodes(nodes: readonly LiveGraphNode[]): LiveGraphNode[] {
  const seen = new Set<string>();
  return nodes.filter((node) => {
    if (seen.has(node.key)) return false;
    seen.add(node.key);
    return true;
  });
}

function orderTimeline(nodes: readonly LiveGraphNode[]): LiveGraphNode[] {
  const start = nodes.find((node) => node.kind === 'start');
  const rest = nodes
    .filter((node) => node.kind !== 'start')
    .slice()
    .sort(
      (left, right) =>
        left.at - right.at || left.sequence - right.sequence || left.key.localeCompare(right.key),
    );
  return start ? [start, ...rest] : rest;
}

function projectMapNodes(
  origin: LiveGraphNode | null,
  planned: readonly LiveGraphNode[],
  progress: LiveRouteProgress | null,
): LiveGraphNode[] {
  if (!progress) return dedupeNodes(origin ? [origin, ...planned] : planned);
  const anchor = nodeFromPoint(progress.anchor, nodeSequence(progress.anchor, planned));
  const next = progress.next
    ? nodeFromPoint(progress.next, nodeSequence(progress.next, planned))
    : null;
  const lunch = progress.lunch
    ? nodeFromPoint(progress.lunch, nodeSequence(progress.lunch, planned))
    : null;
  const anchorIndex =
    anchor.kind === 'start' ? -1 : planned.findIndex((node) => samePoint(node, anchor));
  const afterAnchor = anchorIndex >= 0 ? planned.slice(anchorIndex) : planned;
  const prefix = anchor.kind === 'start' ? [origin ?? anchor] : [anchor];
  const activeSpan = lunch && next ? [lunch, next] : next ? [next] : [];
  return dedupeNodes([...prefix, ...activeSpan, ...afterAnchor]);
}

function segmentsFor(nodes: readonly LiveGraphNode[]): LiveGraphSegment[] {
  const segments: LiveGraphSegment[] = [];
  for (let index = 0; index < nodes.length - 1; index += 1) {
    const from = nodes[index];
    const to = nodes[index + 1];
    if (from && to) segments.push({ key: segmentKey(from, to), from, to });
  }
  return segments;
}

function activePath(
  progress: LiveRouteProgress | null,
): Array<readonly [LiveRoutePoint, LiveRoutePoint]> {
  if (
    !progress ||
    progress.phase === 'not_started' ||
    progress.phase === 'on_site' ||
    progress.phase === 'finished' ||
    !progress.next
  )
    return [];
  if (progress.lunch) {
    return [
      [progress.anchor, progress.lunch],
      [progress.lunch, progress.next],
    ];
  }
  return [[progress.anchor, progress.next]];
}
