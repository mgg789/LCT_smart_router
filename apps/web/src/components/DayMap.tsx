import maplibregl from 'maplibre-gl';
import { useEffect, useRef, useState } from 'react';
import type { LiveRouteProgress } from '../api/live';
import type { DashboardSnapshot, PlanRouteView } from '../api/types';
import { routeVertices, unassignedRequests } from '../domain/dashboard';
import {
  type LiveGraphNode,
  type LiveGraphProjection,
  projectLiveGraph,
} from '../domain/liveGraph';
import { localMapStyle } from '../domain/localBasemap';
import { ONLINE_MAP_STYLE, watchMapStartup } from '../domain/mapAvailability';
import {
  MAP_CANVAS,
  MAP_INK,
  MAP_LUNCH_FILL,
  MAP_LUNCH_STROKE,
  MAP_ROUTE_DASH_PX,
  MAP_ROUTE_GAP_PX,
  mapPaintColor,
  metersPerPixel,
  pillDashLine,
} from '../domain/mapPaint';
import { regionStyle, requestRegion, routeRegion } from '../domain/regions';
import { requestMapPoint } from '../domain/requestPoint';
import { type MapRouteSegment, mapRouteSegments, routeLineKind } from '../domain/travel';
import { engineerColor, skillMark } from '../lib/reasons';

const OSRM_LINE = '#8A8F98';
const MAP_API_LINE = '#16A34A';

function routeStroke(segment: Pick<MapRouteSegment, 'approximate' | 'source' | 'geometryProvider'>, engineerId: string) {
  const kind = routeLineKind(segment);
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
  if (progress.phase !== 'traveling' || !progress.next) return null;
  const [from, to] = progress.lunch
    ? progress.occurredAt < progress.lunch.at
      ? [progress.anchor, progress.lunch]
      : [progress.lunch, progress.next]
    : [progress.anchor, progress.next];
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
  const preferred = new Map<string, VisiblePlannedSegment>();
  for (const segment of mapRouteSegments(route)) {
    const first = segment.coordinates[0];
    const last = segment.coordinates[segment.coordinates.length - 1];
    if (!first || !last) continue;
    const from = resolveVisibleEndpoint(route, graph.mapNodes, first);
    const to = resolveVisibleEndpoint(route, graph.mapNodes, last);
    if (!from || !to || from.key === to.key) continue;
    const key = `${from.key}->${to.key}`;
    if (!graph.mapSegments.some((edge) => edge.key === key)) continue;
    const rank = (value: MapRouteSegment) =>
      value.approximate
        ? 0
        : value.source === 'traffic_api'
          ? 3
          : value.source === 'route_api'
            ? 2
            : 1;
    const existing = preferred.get(key);
    if (!existing || rank(segment) > rank(existing))
      preferred.set(key, { ...segment, fromKey: from.key, toKey: to.key });
  }
  return [...preferred.values()];
}

function resolveVisibleEndpoint(
  route: PlanRouteView,
  visibleNodes: readonly LiveGraphNode[],
  coordinate: readonly [number, number],
): LiveGraphNode | null {
  const direct = visibleNodes.find((node) => hasCoordinate(node, coordinate));
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
 * anchor until the next job is explicitly started; lunch is a two-leg span.
 */
export function liveProgressSegments(progress: LiveRouteProgress): readonly LiveProgressSegment[] {
  return projectLiveGraph(null, progress).activeSegments.map((segment) => ({
    from: pointWithoutProjectionFields(segment.from),
    to: pointWithoutProjectionFields(segment.to),
  }));
}

/** Current factual vertices: job anchor and the lunch point while lunch is active. */
export function liveProgressPoints(
  progress: LiveRouteProgress,
): readonly LiveRouteProgress['anchor'][] {
  const graph = projectLiveGraph(null, progress);
  return graph.mapNodes
    .filter((node) =>
      node.kind === progress.anchor.kind && node.requestId === progress.anchor.requestId
        ? true
        : progress.lunch !== null && node.kind === 'lunch',
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
  onSelectRequest,
}: DayMapProps) {
  const [forceLocal, setForceLocal] = useState(!navigator.onLine);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const update = () => setForceLocal(!navigator.onLine);
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
    const observer = new ResizeObserver(() => map.resize());
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
          graph: projectLiveGraph(route, progress, visibleRequestIds),
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
          planned.some((segment) => {
            const first = segment.coordinates[0];
            const last = segment.coordinates.at(-1);
            return first && last && hasCoordinate(from, first) && hasCoordinate(to, last);
          });
        const segments = [
          ...planned.map((segment) => ({
            approximate: segment.approximate,
            source: segment.source,
            geometryProvider: segment.geometryProvider,
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
                const first = candidate.coordinates[0];
                const last = candidate.coordinates.at(-1);
                return (
                  first &&
                  last &&
                  hasCoordinate(segment.from, first) &&
                  hasCoordinate(segment.to, last)
                );
              })
            : null;
          return {
            type: 'Feature' as const,
            properties: { engineerId, color: mapPaintColor(engineerColor(engineerId)) },
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

      const stopFeatures = projections.flatMap(({ engineerId, graph, progress }) =>
        graph.mapNodes.flatMap((node, index) => {
          if (node.kind === 'start') return [];
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
                color: mapPaintColor(engineerColor(engineerId)),
                regionColor: mapPaintColor(
                  regionStyle(request ? requestRegion(snapshot, request) : null).color,
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
                regionColor: mapPaintColor(regionStyle(requestRegion(snapshot, request)).color),
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
              'text-field': 'Начало дня',
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
              'text-field': 'Обед',
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

      const fitKey = `${retry}:${forceLocal}:${selectedEngineerId ?? 'all'}:${selectedRequestId ?? ''}:${soloRequestId ?? ''}`;
      if (fittedKeyRef.current !== fitKey) {
        fittedKeyRef.current = fitKey;
        if (soloPoint) {
          map.resize();
          map.easeTo({ center: [soloPoint.lon, soloPoint.lat], zoom: 14.2, duration: 400 });
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
    pin.className = 'size-[22px] rounded-full border-[3px] border-figma-ink bg-figma-bee shadow-lg';
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
        aria-label="Карта маршрутов"
        aria-busy={!mapReady && !mapFailed}
        data-map-ready={mapReady}
        className="absolute inset-0 h-full w-full"
      />
      {!soloRequestId && !mapReady && !mapFailed ? (
        <div className="absolute top-14 left-3 rounded-xl bg-white px-3 py-2 text-xs text-muted">
          Загружаем карту…
        </div>
      ) : null}
      {!soloRequestId && (localMap || mapFailed) ? (
        <div
          role="status"
          className="absolute top-3 left-3 right-3 rounded-xl bg-white px-3 py-2 text-xs text-ink shadow"
        >
          {mapFailed
            ? 'Карта недоступна в этом браузере. Используйте список заявок и таймлайн.'
            : 'Сохранённая карта района демо · улицы, парки и водоёмы'}
          {localMap && !forceLocal && !mapFailed ? (
            <button
              type="button"
              className="ml-2 underline"
              onClick={() => setRetry((value) => value + 1)}
            >
              Повторить онлайн-карту
            </button>
          ) : null}
        </div>
      ) : null}
      {soloRequestId ? null : (
        <div className="pointer-events-none absolute bottom-3 left-3 rounded-xl bg-white/90 px-3 py-2 text-[11px] text-muted shadow">
          {selectedEngineerId
            ? 'Показан план выбранного инженера. Пунктир — геоцентры, серая линия — OSRM, зелёная — маршрут 2ГИС или Яндекс.'
            : 'План дня без live-позиции инженеров. Пунктир — геоцентры, серая линия — OSRM, зелёная — маршрут 2ГИС или Яндекс.'}
        </div>
      )}
      <div className="absolute right-2 bottom-1 rounded bg-white/90 px-2 text-[10px] text-muted">
        ©{' '}
        <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
          OpenStreetMap contributors
        </a>
        {' · '}
        {localMap ? (
          <a href="https://opendatacommons.org/licenses/odbl/1-0/" target="_blank" rel="noreferrer">
            ODbL
          </a>
        ) : (
          <a href="https://carto.com/attributions" target="_blank" rel="noreferrer">
            CARTO
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
