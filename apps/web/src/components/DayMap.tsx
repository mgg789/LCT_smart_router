import maplibregl from 'maplibre-gl';
import { useEffect, useRef, useState } from 'react';
import type { HandoffView, LiveRouteProgress } from '../api/live';
import type { DashboardSnapshot, PlanRouteView } from '../api/types';
import { routeVertices, unassignedRequests } from '../domain/dashboard';
import {
  type LiveGraphNode,
  type LiveGraphProjection,
  projectLiveGraph,
  withoutMapLunch,
} from '../domain/liveGraph';
import { localMapStyle } from '../domain/localBasemap';
import { browserMapOnline, ONLINE_MAP_STYLE, watchMapStartup } from '../domain/mapAvailability';
import {
  MAP_CANVAS,
  MAP_EMERGENCY,
  MAP_INK,
  MAP_LUNCH_FILL,
  MAP_LUNCH_STROKE,
  MAP_MUTED,
  MAP_ROUTE_DASH_PX,
  MAP_ROUTE_GAP_PX,
  mapPaintColor,
  metersPerPixel,
  pillDashLine,
} from '../domain/mapPaint';
import { regionStyle, requestRegion, routeRegion } from '../domain/regions';
import { requestMapPoint } from '../domain/requestPoint';
import { type MapRouteSegment, mapRouteSegments, routeLineKind } from '../domain/travel';
import { t } from '../i18n';
import { engineerColor, skillMark } from '../lib/reasons';

const OSRM_LINE = '#8A8F98';
const MAP_API_LINE = '#16A34A';
const METRO_LINE = '#8B5CF6';

function routeStroke(
  segment: Pick<MapRouteSegment, 'approximate' | 'source' | 'geometryProvider' | 'handoffId'>,
  engineerId: string,
) {
  if (segment.handoffId) return mapPaintColor('#2563EB');
  const kind = routeLineKind(segment);
  if (kind === 'metro') return mapPaintColor(METRO_LINE);
  if (kind === 'map') return mapPaintColor(MAP_API_LINE);
  if (kind === 'osrm') return mapPaintColor(OSRM_LINE);
  return mapPaintColor(engineerColor(engineerId));
}

interface DayMapProps {
  readonly snapshot: DashboardSnapshot;
  readonly selectedEngineerId: string | null;
  readonly selectedRequestId: string | null;
  /** When set, the map shows only this request pin. */
  readonly soloRequestId?: string | null;
  /** Server-owned positions survive a remaining-day route rebuild. */
  readonly progressByEngineer?: ReadonlyMap<string, LiveRouteProgress | null>;
  readonly completedByEngineer?: ReadonlyMap<string, number>;
  readonly handoffs?: readonly HandoffView[];
  readonly onSelectRequest: (requestId: string) => void;
}

export interface LiveProgressSegment {
  readonly from: LiveRouteProgress['anchor'];
  readonly to: LiveRouteProgress['anchor'];
}

/** Interpolated position on the current factual edge at the LIVE business time. */
export function liveProgressPosition(
  progress: LiveRouteProgress,
): { readonly lat: number; readonly lon: number } | null {
  if (!['traveling', 'lunch'].includes(progress.phase) || !progress.next) return null;
  const [from, to] = [progress.anchor, progress.next];
  const span = Math.max(1, to.at - from.at);
  const ratio = Math.min(1, Math.max(0, (progress.occurredAt - from.at) / span));
  return {
    lat: from.lat + (to.lat - from.lat) * ratio,
    lon: from.lon + (to.lon - from.lon) * ratio,
  };
}

/** Router geometry retained for a visible planned edge. */
export interface VisiblePlannedSegment extends MapRouteSegment {
  readonly fromKey: string;
  readonly toKey: string;
}

/** Keeps lunch at its real location, including a location shared with a job. */
export function lunchMarkerCoordinates(
  nodes: readonly LiveGraphNode[],
  lunchIndex: number,
): readonly [number, number] {
  const lunch = nodes[lunchIndex];
  if (lunch?.kind !== 'lunch') {
    throw new RangeError('lunchIndex must reference a lunch node');
  }
  return [lunch.lon, lunch.lat];
}

/**
 * Keeps Router geometry only when both of its factual endpoints remain in the
 * current map projection. A wait is not a drawable vertex, but it may share a
 * coordinate with the following visit and then resolves to that visit.
 */
export function visiblePlannedSegments(
  route: PlanRouteView,
  graph: LiveGraphProjection,
): readonly VisiblePlannedSegment[] {
  const visible: VisiblePlannedSegment[] = [];
  const seenGeometry = new Set<string>();
  for (const segment of mapRouteSegments(route)) {
    const first = segment.coordinates[0];
    const last = segment.coordinates[segment.coordinates.length - 1];
    if (!first || !last) continue;
    const routeFirst = segment.routeEndpoints?.[0] ?? first;
    const routeLast = segment.routeEndpoints?.[1] ?? last;
    const { from, to } = resolveVisiblePair(route, graph, routeFirst, routeLast);
    const drawableRoad =
      !segment.approximate && segment.coordinates.length >= 2 && segment.source !== 'metro';
    const onGraph =
      from !== null &&
      to !== null &&
      from.key !== to.key &&
      graph.mapSegments.some((edge) => edge.key === `${from.key}->${to.key}`);
    const lunchPin = (coordinate: readonly [number, number]) =>
      route.stops.some((stop) => stop.kind === 'lunch' && hasCoordinate(stop, coordinate));
    // Lunch is collapsed off the map, so a road into that stop no longer matches
    // a graph edge. Keep only that polyline; a finished edge behind the anchor stays hidden.
    const intoCollapsedLunch =
      drawableRoad &&
      (from !== null || to !== null) &&
      ((from === null && (lunchPin(routeFirst) || lunchPin(first))) ||
        (to === null && (lunchPin(routeLast) || lunchPin(last))));
    if (!onGraph && !intoCollapsedLunch) continue;
    const shapeId = `${segment.source}:${first[0]},${first[1]}:${last[0]},${last[1]}`;
    const fromKey = from?.key ?? `shape:${shapeId}:a`;
    const toKey = to && to.key !== from?.key ? to.key : `shape:${shapeId}:b`;
    if (fromKey === toKey) continue;
    const key = `${fromKey}->${toKey}`;
    // Mixed legs intentionally keep access, metro and egress as separate lines.
    // Deduplicate only an exact repeated shape from a malformed/duplicated payload.
    const geometryKey = `${key}:${segment.source}:${segment.coordinates
      .map((point) => `${point[0]},${point[1]}`)
      .join(';')}`;
    if (seenGeometry.has(geometryKey)) continue;
    seenGeometry.add(geometryKey);
    visible.push({ ...segment, fromKey, toKey });
  }
  return visible;
}

/**
 * The MKAD road API snaps a quote onto the carriageway. Observed offsets from a
 * building pin are about 15–40 m, so an exact coordinate match drops the polyline
 * and the map falls back to a straight dashed chord.
 */
const ROAD_ENDPOINT_SNAP_M = 80;

/**
 * A return visit sits on the same pin as the shift start. The first node at
 * that coordinate is the start, which is not the graph edge of the return
 * trip, so the road was dropped and a dashed chord remained.
 */
function resolveVisiblePair(
  route: PlanRouteView,
  graph: LiveGraphProjection,
  start: readonly [number, number],
  end: readonly [number, number],
): { from: LiveGraphNode | null; to: LiveGraphNode | null } {
  const fromOptions = endpointCandidates(route, graph.mapNodes, start);
  const toOptions = endpointCandidates(route, graph.mapNodes, end);
  for (const from of fromOptions) {
    for (const to of toOptions) {
      if (from.key === to.key) continue;
      if (graph.mapSegments.some((edge) => edge.key === `${from.key}->${to.key}`)) {
        return { from, to };
      }
    }
  }
  return { from: fromOptions[0] ?? null, to: toOptions[0] ?? null };
}

function endpointCandidates(
  route: PlanRouteView,
  visibleNodes: readonly LiveGraphNode[],
  coordinate: readonly [number, number],
): LiveGraphNode[] {
  const exact = visibleNodes.filter((node) => hasCoordinate(node, coordinate));
  if (exact.length > 0) return exact;
  const single = resolveVisibleEndpoint(route, visibleNodes, coordinate);
  return single ? [single] : [];
}

function resolveVisibleEndpoint(
  route: PlanRouteView,
  visibleNodes: readonly LiveGraphNode[],
  coordinate: readonly [number, number],
): LiveGraphNode | null {
  const exact = visibleNodes.find((node) => hasCoordinate(node, coordinate));
  if (exact) return exact;
  const direct = nearestNodeWithin(visibleNodes, coordinate, ROAD_ENDPOINT_SNAP_M);
  if (direct) return direct;
  const vertices = routeVertices(route);
  const waitIndex = vertices.findIndex(
    (vertex) => vertex.kind === 'wait' && hasCoordinate(vertex, coordinate),
  );
  if (waitIndex < 0) return null;
  const following = vertices
    .slice(waitIndex + 1)
    .find((vertex) => vertex.kind !== 'wait' && hasCoordinate(vertex, coordinate));
  return following
    ? (visibleNodes.find(
        (node) => node.kind === following.kind && hasCoordinate(node, coordinate),
      ) ?? null)
    : null;
}

function nearestNodeWithin(
  nodes: readonly LiveGraphNode[],
  coordinate: readonly [number, number],
  maxMeters: number,
): LiveGraphNode | null {
  let best: LiveGraphNode | null = null;
  let bestMeters = maxMeters;
  for (const node of nodes) {
    const meters = haversineMeters([node.lon, node.lat], coordinate);
    if (best === null ? meters <= maxMeters : meters < bestMeters) {
      best = node;
      bestMeters = meters;
    }
  }
  return best;
}

/**
 * A graph edge is already drawn when a road, a metro ride, or two roads
 * meeting at a collapsed lunch pin connect its stops. A leftover chord is
 * the dashed fallback.
 */
export function plannedRoadsCoverEdge(
  edge: {
    from: Pick<LiveGraphNode, 'lat' | 'lon' | 'key'>;
    to: Pick<LiveGraphNode, 'lat' | 'lon' | 'key'>;
  },
  planned: readonly VisiblePlannedSegment[],
): boolean {
  const roads = planned.filter((segment) => segment.source === 'metro' || !segment.approximate);
  const pinsOf = (segment: VisiblePlannedSegment) =>
    segment.routeEndpoints ??
    ([segment.coordinates[0], segment.coordinates[segment.coordinates.length - 1]] as const);
  const near = (
    node: Pick<LiveGraphNode, 'lat' | 'lon'>,
    point: readonly [number, number] | undefined,
  ) => point !== undefined && haversineMeters([node.lon, node.lat], point) <= 40;
  for (const road of roads) {
    if (road.fromKey === edge.from.key && road.toKey === edge.to.key) return true;
    const pins = pinsOf(road);
    if (
      (near(edge.from, pins[0]) && near(edge.to, pins[1])) ||
      (near(edge.from, pins[1]) && near(edge.to, pins[0]))
    ) {
      return true;
    }
  }
  for (const left of roads) {
    const leftPins = pinsOf(left);
    const leftTouchesFrom = near(edge.from, leftPins[0]) || near(edge.from, leftPins[1]);
    if (!leftTouchesFrom) continue;
    const leftFar = near(edge.from, leftPins[0]) ? leftPins[1] : leftPins[0];
    for (const right of roads) {
      if (right === left || !leftFar) continue;
      const rightPins = pinsOf(right);
      const rightTouchesTo = near(edge.to, rightPins[0]) || near(edge.to, rightPins[1]);
      if (!rightTouchesTo) continue;
      const rightFar = near(edge.to, rightPins[0]) ? rightPins[1] : rightPins[0];
      if (rightFar && haversineMeters(leftFar, rightFar) <= 40) return true;
    }
  }
  return false;
}

function haversineMeters(from: readonly [number, number], to: readonly [number, number]): number {
  const radius = 6_371_000;
  const toRad = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRad(to[1] - from[1]);
  const dLon = toRad(to[0] - from[0]);
  const lat1 = toRad(from[1]);
  const lat2 = toRad(to[1]);
  const half = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(half)));
}

function hasCoordinate(
  point: Pick<LiveGraphNode, 'lat' | 'lon'>,
  coordinate: readonly [number, number],
): boolean {
  return (
    Math.abs(point.lon - coordinate[0]) < 0.00001 && Math.abs(point.lat - coordinate[1]) < 0.00001
  );
}

/**
 * Projects the factual part of a LIVE route. A completed job remains the edge
 * anchor until the next job is explicitly started; lunch is collapsed out of the map.
 */
export function liveProgressSegments(progress: LiveRouteProgress): readonly LiveProgressSegment[] {
  return withoutMapLunch(projectLiveGraph(null, progress)).activeSegments.map((segment) => ({
    from: pointWithoutProjectionFields(segment.from),
    to: pointWithoutProjectionFields(segment.to),
  }));
}

/** Current factual map vertex: the last reached job, never a separate lunch point. */
export function liveProgressPoints(
  progress: LiveRouteProgress,
): readonly LiveRouteProgress['anchor'][] {
  const graph = withoutMapLunch(projectLiveGraph(null, progress));
  return graph.mapNodes
    .filter(
      (node) => node.kind === progress.anchor.kind && node.requestId === progress.anchor.requestId,
    )
    .map(pointWithoutProjectionFields);
}

function pointWithoutProjectionFields(point: LiveRouteProgress['anchor']) {
  return {
    kind: point.kind,
    requestId: point.requestId,
    lat: point.lat,
    lon: point.lon,
    at: point.at,
  };
}

export function DayMap({
  snapshot,
  selectedEngineerId,
  selectedRequestId,
  soloRequestId = null,
  progressByEngineer,
  completedByEngineer,
  handoffs = [],
  onSelectRequest,
}: DayMapProps) {
  const [forceLocal, setForceLocal] = useState(!browserMapOnline());
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const update = () => setForceLocal(!browserMapOnline());
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  const containerRef = useRef<HTMLElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const soloMarkerRef = useRef<maplibregl.Marker | null>(null);
  const onSelectRef = useRef(onSelectRequest);
  const fittedKeyRef = useRef<string | null>(null);
  const focusPointRef = useRef<ReturnType<typeof requestMapPoint>>(null);
  const focusId = soloRequestId ?? selectedRequestId;
  focusPointRef.current = focusId ? requestMapPoint(snapshot, focusId) : null;
  const [localMap, setLocalMap] = useState(forceLocal);
  const [mapFailed, setMapFailed] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  onSelectRef.current = onSelectRequest;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    container.dataset.mapAttempt = String(retry);
    setLocalMap(forceLocal);
    setMapFailed(false);
    setMapReady(false);
    fittedKeyRef.current = null;
    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container,
        style: forceLocal ? localMapStyle() : ONLINE_MAP_STYLE,
        center: [37.62, 55.75],
        zoom: 11.4,
        attributionControl: false,
      });
    } catch {
      setMapFailed(true);
      return;
    }
    let fallback = forceLocal;
    const markReady = () => setMapReady(true);
    map.on('idle', markReady);
    const activateLocalMap = () => {
      if (fallback) return;
      fallback = true;
      setMapReady(false);
      setLocalMap(true);
      map.setStyle(localMapStyle());
    };
    const stopWatching = watchMapStartup(map, activateLocalMap);
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    map.on('click', 'stops-circle', (event) => pickRequest(event, onSelectRef));
    map.on('click', 'unassigned-circle', (event) => pickRequest(event, onSelectRef));
    const observer = new ResizeObserver(() => {
      map.resize();
      // The request panel animates the map width; keep its point centred in the new viewport.
      const point = focusPointRef.current;
      if (point)
        map.jumpTo({
          center: [point.lon, point.lat],
          padding: { top: 0, bottom: 0, left: 0, right: 0 },
        });
    });
    observer.observe(container);
    mapRef.current = map;
    return () => {
      observer.disconnect();
      stopWatching();
      map.off('idle', markReady);
      map.remove();
      mapRef.current = null;
    };
  }, [forceLocal, retry]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }

    const apply = () => {
      if (mapRef.current !== map || !map.getStyle()) {
        return false;
      }
      const soloPoint = soloRequestId ? requestMapPoint(snapshot, soloRequestId) : null;
      const allRoutes = soloRequestId ? [] : (snapshot.plan.plan?.routes ?? []);
      const selectedRoutes = selectedEngineerId
        ? allRoutes.filter((route) => route.engineerId === selectedEngineerId)
        : allRoutes;
      const visibleRequestIds = new Set(
        snapshot.requests
          .filter(
            (request) =>
              request.lifecycle !== 'completed' &&
              request.lifecycle !== 'cancelled' &&
              (request.assumedCompletedAt === null || request.assumedCompletedAt === undefined),
          )
          .map((request) => request.id),
      );
      // A projection starts at a factual anchor and never draws the synthetic
      // start of a freshly rebuilt remaining route.
      const routeByEngineer = new Map(selectedRoutes.map((route) => [route.engineerId, route]));
      const projectedEngineerIds = new Set(routeByEngineer.keys());
      for (const [engineerId, progress] of progressByEngineer ?? []) {
        if (progress && (selectedEngineerId === null || selectedEngineerId === engineerId)) {
          projectedEngineerIds.add(engineerId);
        }
      }
      const projections = [...projectedEngineerIds].map((engineerId) => {
        const route = routeByEngineer.get(engineerId) ?? null;
        const progress = progressByEngineer?.get(engineerId) ?? null;
        return {
          engineerId,
          route,
          progress,
          graph: withoutMapLunch(projectLiveGraph(route, progress, visibleRequestIds)),
        };
      });
      const viewingUnassigned = unassignedRequests(snapshot).some(
        (request) => request.id === selectedRequestId,
      );
      const showUnassigned = !soloRequestId && (selectedEngineerId === null || viewingUnassigned);
      const sampleLat = projections[0]?.graph.mapNodes[0]?.lat ?? 55.75;
      const dashMeters = metersPerPixel(sampleLat, map.getZoom()) * MAP_ROUTE_DASH_PX;
      const gapMeters = metersPerPixel(sampleLat, map.getZoom()) * MAP_ROUTE_GAP_PX;

      const lineFeatures = projections.flatMap(({ engineerId, route, graph }) => {
        const region = route ? routeRegion(snapshot, route) : null;
        const planned = route ? visiblePlannedSegments(route, graph) : [];
        const covered = (from: LiveGraphNode, to: LiveGraphNode) =>
          plannedRoadsCoverEdge({ from, to }, planned);
        const segments = [
          ...planned.map((segment) => ({
            approximate: segment.approximate,
            source: segment.source,
            geometryProvider: segment.geometryProvider,
            handoffId: segment.handoffId,
            travelTimeSec: segment.travelTimeSec,
            distanceKm: segment.distanceKm,
            coordinates: segment.coordinates,
          })),
          ...graph.mapSegments
            .filter((segment) => !covered(segment.from, segment.to))
            .map((segment) => ({
              approximate: true,
              source: 'approximate' as const,
              coordinates: [
                [segment.from.lon, segment.from.lat] as const,
                [segment.to.lon, segment.to.lat] as const,
              ],
            })),
        ];
        return segments.flatMap((segment) => {
          const paths = segment.approximate
            ? pillDashLine(segment.coordinates, dashMeters, gapMeters)
            : [segment.coordinates.map((point) => [point[0], point[1]] as [number, number])];
          return paths.map((coordinates) => ({
            type: 'Feature' as const,
            properties: {
              engineerId,
              selected: !selectedEngineerId || engineerId === selectedEngineerId ? 1 : 0,
              approximate: segment.approximate ? 1 : 0,
              color: routeStroke(segment, engineerId),
              regionColor: mapPaintColor(regionStyle(region).color),
              travelSource: segment.source,
            },
            geometry: {
              type: 'LineString' as const,
              coordinates,
            },
          }));
        });
      });

      const progressLines = projections.flatMap(({ engineerId, route, graph }) =>
        graph.activeSegments.map((segment) => {
          const road = route
            ? visiblePlannedSegments(route, graph).find((candidate) => {
                return candidate.fromKey === segment.from.key && candidate.toKey === segment.to.key;
              })
            : null;
          return {
            type: 'Feature' as const,
            properties: {
              engineerId,
              color: road?.handoffId
                ? mapPaintColor('#2563EB')
                : road && routeLineKind(road) === 'metro'
                  ? routeStroke(road, engineerId)
                  : mapPaintColor(engineerColor(engineerId)),
            },
            geometry: {
              type: 'LineString' as const,
              coordinates: road?.coordinates ?? [
                [segment.from.lon, segment.from.lat] as const,
                [segment.to.lon, segment.to.lat] as const,
              ],
            },
          };
        }),
      );

      const startFeatures = projections.flatMap(({ engineerId, route, graph }) => {
        const start = graph.mapNodes.find((node) => node.kind === 'start');
        if (!start) return [];
        return [
          {
            type: 'Feature' as const,
            properties: {
              engineerId,
              selected: !selectedEngineerId || engineerId === selectedEngineerId ? 1 : 0,
              color: mapPaintColor(engineerColor(engineerId)),
              regionColor: mapPaintColor(
                regionStyle(route ? routeRegion(snapshot, route) : null).color,
              ),
              current: graph.activeNodeKeys.has(start.key) ? 1 : 0,
            },
            geometry: {
              type: 'Point' as const,
              coordinates: [start.lon, start.lat],
            },
          },
        ];
      });

      const handoffFeatures = projections.flatMap(({ engineerId, graph }) =>
        graph.mapNodes.flatMap((node) => {
          if (node.kind !== 'handoff' || !node.handoffId) return [];
          const handoff = handoffs.find((item) => item.id === node.handoffId);
          return [
            {
              type: 'Feature' as const,
              properties: {
                handoffId: node.handoffId,
                engineerId,
                completed: handoff?.completedAt ? 1 : 0,
              },
              geometry: { type: 'Point' as const, coordinates: [node.lon, node.lat] as const },
            },
          ];
        }),
      );
      const stopFeatures = projections.flatMap(({ engineerId, graph, progress }) =>
        graph.mapNodes.flatMap((node, index) => {
          if (node.kind === 'start') return [];
          if (node.kind === 'handoff') return [];
          if (node.kind === 'lunch') {
            const coordinates = lunchMarkerCoordinates(graph.mapNodes, index);
            return [
              {
                type: 'Feature' as const,
                properties: {
                  engineerId,
                  selected: !selectedEngineerId || engineerId === selectedEngineerId ? 1 : 0,
                  current: graph.activeNodeKeys.has(node.key) ? 1 : 0,
                },
                geometry: {
                  type: 'Point' as const,
                  coordinates,
                },
              },
            ];
          }
          if (!node.requestId) {
            return [];
          }
          const request = snapshot.requests.find((item) => item.id === node.requestId);
          const anchorAlreadyDone =
            progress?.anchor.kind === 'job' &&
            progress.phase !== 'on_site' &&
            graph.mapNodes.some((item) => item.requestId === progress.anchor.requestId);
          const sequence =
            Math.max(0, (completedByEngineer?.get(engineerId) ?? 0) - (anchorAlreadyDone ? 1 : 0)) +
            graph.mapNodes.slice(0, index + 1).filter((item) => item.kind === 'job').length;
          return [
            {
              type: 'Feature' as const,
              properties: {
                requestId: node.requestId,
                sequence,
                skillMark: request ? skillMark(request.requiredSkill) : '',
                engineerId,
                selected: node.requestId === selectedRequestId ? 1 : 0,
                color:
                  request?.workCategory === 'emergency'
                    ? MAP_MUTED
                    : mapPaintColor(engineerColor(engineerId)),
                regionColor: mapPaintColor(
                  request?.workCategory === 'emergency'
                    ? MAP_EMERGENCY
                    : regionStyle(request ? requestRegion(snapshot, request) : null).color,
                ),
                current: graph.activeNodeKeys.has(node.key) ? 1 : 0,
              },
              geometry: {
                type: 'Point' as const,
                coordinates: [node.lon, node.lat] as const,
              },
            },
          ];
        }),
      );
      const lunchFeatures = stopFeatures.filter((feature) => !('requestId' in feature.properties));
      const jobFeatures = stopFeatures.filter((feature) => 'requestId' in feature.properties);

      const unassignedFeatures = (showUnassigned ? unassignedRequests(snapshot) : [])
        .filter((request) => visibleRequestIds.has(request.id))
        .flatMap((request) => {
          if (request.lat === null || request.lon === null) {
            return [];
          }
          return [
            {
              type: 'Feature' as const,
              properties: {
                requestId: request.id,
                skillMark: skillMark(request.requiredSkill),
                selected: request.id === selectedRequestId ? 1 : 0,
                regionColor:
                  request.workCategory === 'emergency'
                    ? MAP_EMERGENCY
                    : mapPaintColor(regionStyle(requestRegion(snapshot, request)).color),
              },
              geometry: {
                type: 'Point' as const,
                coordinates: [request.lon, request.lat],
              },
            },
          ];
        });

      upsert(map, 'routes', { type: 'FeatureCollection', features: lineFeatures }, () => {
        map.addLayer({
          id: 'routes-casing',
          type: 'line',
          source: 'routes',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': MAP_CANVAS,
            'line-width': ['case', ['==', ['get', 'selected'], 1], 9, 7],
          },
        });
        map.addLayer({
          id: 'routes-line',
          type: 'line',
          source: 'routes',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': ['get', 'color'],
            'line-width': ['case', ['==', ['get', 'selected'], 1], 5, 3.5],
            'line-opacity': ['case', ['==', ['get', 'selected'], 1], 0.9, 0.35],
          },
        });
      });

      upsert(
        map,
        'live-progress-lines',
        { type: 'FeatureCollection', features: progressLines },
        () => {
          map.addLayer({
            id: 'live-progress-lines',
            type: 'line',
            source: 'live-progress-lines',
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': ['get', 'color'], 'line-width': 6, 'line-opacity': 0.95 },
          });
        },
      );

      upsert(map, 'starts', { type: 'FeatureCollection', features: startFeatures }, () => {
        map.addLayer({
          id: 'starts-square',
          type: 'circle',
          source: 'starts',
          paint: {
            'circle-radius': 11,
            'circle-color': MAP_CANVAS,
            'circle-stroke-width': ['case', ['==', ['get', 'current'], 1], 5, 3],
            'circle-stroke-color': [
              'case',
              ['==', ['get', 'current'], 1],
              '#FFC72C',
              ['get', 'regionColor'],
            ],
          },
        });
        if (map.getStyle().glyphs)
          map.addLayer({
            id: 'starts-label',
            type: 'symbol',
            source: 'starts',
            layout: {
              'text-field': t('components.DayMap.cf1dfa079c'),
              'text-size': 11,
              'text-offset': [0, 1.2],
              'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
            },
            paint: {
              'text-color': MAP_INK,
              'text-halo-color': MAP_CANVAS,
              'text-halo-width': 1.2,
            },
          });
      });

      upsert(map, 'stops', { type: 'FeatureCollection', features: jobFeatures }, () => {
        map.addLayer({
          id: 'stops-circle',
          type: 'circle',
          source: 'stops',
          paint: {
            'circle-radius': [
              'case',
              ['==', ['get', 'current'], 1],
              16,
              ['==', ['get', 'selected'], 1],
              16,
              13,
            ],
            'circle-color': ['get', 'color'],
            'circle-stroke-width': [
              'case',
              ['==', ['get', 'current'], 1],
              5,
              ['==', ['get', 'selected'], 1],
              4,
              2.5,
            ],
            'circle-stroke-color': ['get', 'regionColor'],
          },
        });
        if (map.getStyle().glyphs)
          map.addLayer({
            id: 'stops-label',
            type: 'symbol',
            source: 'stops',
            layout: {
              'text-field': ['to-string', ['get', 'sequence']],
              'text-size': 14,
              'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
            },
            paint: { 'text-color': MAP_CANVAS },
          });
      });

      upsert(map, 'lunches', { type: 'FeatureCollection', features: lunchFeatures }, () => {
        map.addLayer({
          id: 'lunch-circle',
          type: 'circle',
          source: 'lunches',
          paint: {
            'circle-radius': ['case', ['==', ['get', 'current'], 1], 14, 12],
            'circle-color': MAP_LUNCH_FILL,
            'circle-stroke-width': ['case', ['==', ['get', 'current'], 1], 5, 3],
            'circle-stroke-color': [
              'case',
              ['==', ['get', 'current'], 1],
              '#FFC72C',
              MAP_LUNCH_STROKE,
            ],
          },
        });
        if (map.getStyle().glyphs)
          map.addLayer({
            id: 'lunch-label',
            type: 'symbol',
            source: 'lunches',
            layout: {
              'text-field': t('components.DayMap.69a29fbff8'),
              'text-size': 11,
              'text-offset': [0, 1.2],
              'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
            },
            paint: {
              'text-color': '#8A4B12',
              'text-halo-color': MAP_CANVAS,
              'text-halo-width': 1.2,
            },
          });
      });

      upsert(map, 'unassigned', { type: 'FeatureCollection', features: unassignedFeatures }, () => {
        map.addLayer({
          id: 'unassigned-circle',
          type: 'circle',
          source: 'unassigned',
          paint: {
            'circle-radius': ['case', ['==', ['get', 'selected'], 1], 16, 13],
            'circle-color': ['get', 'regionColor'],
            'circle-stroke-width': 2,
            'circle-stroke-color': MAP_INK,
          },
        });
      });

      upsert(map, 'handoffs', { type: 'FeatureCollection', features: handoffFeatures }, () => {
        map.addLayer({
          id: 'handoff-point',
          type: 'circle',
          source: 'handoffs',
          paint: {
            'circle-radius': 8,
            'circle-color': '#2563EB',
            'circle-stroke-width': 3,
            'circle-stroke-color': MAP_CANVAS,
          },
        });
      });

      const fitKey = `${retry}:${forceLocal}:${selectedEngineerId ?? 'all'}:${selectedRequestId ?? ''}:${soloRequestId ?? ''}`;
      if (fittedKeyRef.current !== fitKey) {
        fittedKeyRef.current = fitKey;
        const focusPoint =
          soloPoint ?? (selectedRequestId ? requestMapPoint(snapshot, selectedRequestId) : null);
        if (focusPoint) {
          map.resize();
          map.easeTo({
            center: [focusPoint.lon, focusPoint.lat],
            ...(soloPoint ? { zoom: 14.2 } : {}),
            padding: { top: 0, bottom: 0, left: 0, right: 0 },
            duration: 400,
          });
          return true;
        }
        const bounds = new maplibregl.LngLatBounds();
        const fitProjections = selectedEngineerId
          ? projections.filter((projection) => projection.engineerId === selectedEngineerId)
          : projections;
        for (const projection of fitProjections) {
          for (const node of projection.graph.mapNodes) {
            bounds.extend([node.lon, node.lat]);
          }
        }
        for (const feature of unassignedFeatures) {
          bounds.extend(feature.geometry.coordinates as [number, number]);
        }
        if (!bounds.isEmpty()) {
          map.fitBounds(bounds, { padding: 72, maxZoom: 13, duration: 400 });
        }
      }
      return true;
    };

    apply();
    const onStyle = () => {
      apply();
    };
    map.on('style.load', onStyle);
    map.once('load', onStyle);
    map.on('zoomend', onStyle);
    return () => {
      map.off('style.load', onStyle);
      map.off('load', onStyle);
      map.off('zoomend', onStyle);
    };
  }, [
    selectedEngineerId,
    selectedRequestId,
    soloRequestId,
    snapshot,
    progressByEngineer,
    completedByEngineer,
    handoffs,
    forceLocal,
    retry,
  ]);

  useEffect(() => {
    const map = mapRef.current;
    soloMarkerRef.current?.remove();
    soloMarkerRef.current = null;
    if (!map || !soloRequestId || !mapReady) return;
    const point = requestMapPoint(snapshot, soloRequestId);
    if (!point) return;
    const pin = document.createElement('div');
    pin.setAttribute('aria-hidden', 'true');
    const request = snapshot.requests.find((item) => item.id === soloRequestId);
    const jobs = snapshot.plan.plan?.routes
      .find((route) => route.stops.some((stop) => stop.requestId === soloRequestId))
      ?.stops.filter((stop) => stop.kind === 'job');
    const sequence = jobs ? jobs.findIndex((stop) => stop.requestId === soloRequestId) + 1 : 0;
    const emergency = request?.workCategory === 'emergency';
    pin.className = `flex size-[22px] items-center justify-center rounded-full border-[3px] text-[11px] font-semibold text-white shadow-lg ${
      emergency
        ? sequence > 0
          ? 'border-figma-danger bg-figma-muted'
          : 'border-figma-ink bg-figma-danger'
        : 'border-figma-ink bg-figma-bee'
    }`;
    if (emergency && sequence > 0) pin.textContent = String(sequence);
    const marker = new maplibregl.Marker({ element: pin, anchor: 'center' })
      .setLngLat([point.lon, point.lat])
      .addTo(map);
    soloMarkerRef.current = marker;
    return () => {
      marker.remove();
      if (soloMarkerRef.current === marker) soloMarkerRef.current = null;
    };
  }, [mapReady, snapshot, soloRequestId]);

  return (
    <>
      <section
        ref={containerRef}
        aria-label={t('components.DayMap.b44875750d')}
        aria-busy={!mapReady && !mapFailed}
        data-map-ready={mapReady}
        className="absolute inset-0 h-full w-full"
      />
      {!soloRequestId && !mapReady && !mapFailed ? (
        <div className="absolute top-14 left-3 rounded-xl bg-white px-3 py-2 text-xs text-muted">
          {t('components.DayMap.9514ff87b5')}
        </div>
      ) : null}
      {!soloRequestId && (localMap || mapFailed) ? (
        <div
          role="status"
          className="absolute top-3 left-3 right-3 rounded-xl bg-white px-3 py-2 text-xs text-ink shadow"
        >
          {mapFailed ? t('components.DayMap.0aca4d7172') : t('components.DayMap.bcc5576431')}
          {localMap && !forceLocal && !mapFailed ? (
            <button
              type="button"
              className="ml-2 underline"
              onClick={() => setRetry((value) => value + 1)}
            >
              {t('components.DayMap.b650521777')}
            </button>
          ) : null}
        </div>
      ) : null}
      {soloRequestId ? null : (
        <div className="pointer-events-none absolute bottom-3 left-3 rounded-xl bg-white/90 px-3 py-2 text-[11px] text-muted shadow">
          {localMap || mapFailed
            ? t('components.DayMap.2c7bb29d64')
            : t('components.DayMap.fd6bf6cb1a')}
        </div>
      )}
      <div className="absolute right-2 bottom-1 rounded bg-white/90 px-2 text-[10px] text-muted">
        ©{' '}
        <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
          {t('components.DayMap.980ca2cea8')}
        </a>
        {' · '}
        {localMap ? (
          <a href="https://opendatacommons.org/licenses/odbl/1-0/" target="_blank" rel="noreferrer">
            {t('components.DayMap.8656c5d416')}
          </a>
        ) : (
          <a href="https://carto.com/attributions" target="_blank" rel="noreferrer">
            {t('components.DayMap.c4911d01c1')}
          </a>
        )}
      </div>
    </>
  );
}

function pickRequest(
  event: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] },
  onSelectRef: { current: (requestId: string) => void },
) {
  const id = event.features?.[0]?.properties?.requestId;
  if (typeof id === 'string') {
    onSelectRef.current(id);
  }
}

function upsert(
  map: maplibregl.Map,
  id: string,
  data: { type: 'FeatureCollection'; features: Array<Record<string, unknown>> },
  addLayers: () => void,
) {
  const source = map.getSource(id);
  if (isGeoJsonSource(source)) {
    source.setData(data);
    return;
  }
  map.addSource(id, { type: 'geojson', data });
  addLayers();
}

function isGeoJsonSource(
  source: maplibregl.Source | undefined,
): source is maplibregl.GeoJSONSource {
  return source !== undefined && source.type === 'geojson';
}
