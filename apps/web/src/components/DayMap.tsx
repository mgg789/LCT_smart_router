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
import { regionStyle, requestRegion, routeRegion } from '../domain/regions';
import { type MapRouteSegment, mapRouteSegments } from '../domain/travel';
import { engineerColor, skillMark } from '../lib/reasons';

interface DayMapProps {
  readonly snapshot: DashboardSnapshot;
  readonly selectedEngineerId: string | null;
  readonly selectedRequestId: string | null;
  /** Server-owned positions survive a remaining-day route rebuild. */
  readonly progressByEngineer?: ReadonlyMap<string, LiveRouteProgress | null>;
  readonly onSelectRequest: (requestId: string) => void;
}

export interface LiveProgressSegment {
  readonly from: LiveRouteProgress['anchor'];
  readonly to: LiveRouteProgress['anchor'];
}

/** Router geometry retained for a visible planned edge. */
export interface VisiblePlannedSegment extends MapRouteSegment {
  readonly fromKey: string;
  readonly toKey: string;
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
  return mapRouteSegments(route).flatMap((segment) => {
    const first = segment.coordinates[0];
    const last = segment.coordinates[segment.coordinates.length - 1];
    if (!first || !last) return [];
    const from = resolveVisibleEndpoint(route, graph.mapNodes, first);
    const to = resolveVisibleEndpoint(route, graph.mapNodes, last);
    if (!from || !to || from.key === to.key) return [];
    return [{ ...segment, fromKey: from.key, toKey: to.key }];
  });
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
  return point.lon === coordinate[0] && point.lat === coordinate[1];
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

const STYLE_URL = 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json';

export function DayMap({
  snapshot,
  selectedEngineerId,
  selectedRequestId,
  progressByEngineer,
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
        style: forceLocal ? localMapStyle() : STYLE_URL,
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
    const timeout = window.setTimeout(() => {
      if (!map.isStyleLoaded()) activateLocalMap();
    }, 6000);
    map.on('error', activateLocalMap);
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    map.on('click', 'stops-circle', (event) => pickRequest(event, onSelectRef));
    map.on('click', 'unassigned-circle', (event) => pickRequest(event, onSelectRef));
    const observer = new ResizeObserver(() => map.resize());
    observer.observe(container);
    mapRef.current = map;
    return () => {
      observer.disconnect();
      window.clearTimeout(timeout);
      map.off('error', activateLocalMap);
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
      const allRoutes = snapshot.plan.plan?.routes ?? [];
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
        return {
          engineerId,
          route,
          graph: projectLiveGraph(
            route,
            progressByEngineer?.get(engineerId) ?? null,
            visibleRequestIds,
          ),
        };
      });
      const viewingUnassigned = unassignedRequests(snapshot).some(
        (request) => request.id === selectedRequestId,
      );
      const showUnassigned = selectedEngineerId === null || viewingUnassigned;

      const lineFeatures = projections.flatMap(({ engineerId, route, graph }) => {
        const region = route ? routeRegion(snapshot, route) : null;
        const planned = route ? visiblePlannedSegments(route, graph) : [];
        const geometryKeys = new Set(
          planned.map((segment) => `${segment.fromKey}->${segment.toKey}`),
        );
        const segments = [
          ...planned.map((segment) => ({
            approximate: segment.approximate,
            source: segment.source,
            coordinates: segment.coordinates,
          })),
          ...graph.mapSegments
            .filter((segment) => !geometryKeys.has(segment.key))
            .map((segment) => ({
              approximate: true,
              source: 'approximate' as const,
              coordinates: [
                [segment.from.lon, segment.from.lat] as const,
                [segment.to.lon, segment.to.lat] as const,
              ],
            })),
        ];
        return segments.map((segment) => ({
          type: 'Feature' as const,
          properties: {
            engineerId,
            selected: !selectedEngineerId || engineerId === selectedEngineerId ? 1 : 0,
            approximate: segment.approximate ? 1 : 0,
            color: engineerColor(engineerId),
            regionColor: regionStyle(region).color,
            travelSource: segment.source,
          },
          geometry: {
            type: 'LineString' as const,
            coordinates: segment.coordinates,
          },
        }));
      });

      const progressLines = projections.flatMap(({ engineerId, graph }) =>
        graph.activeSegments.map((segment) => {
          return {
            type: 'Feature' as const,
            properties: { engineerId, color: engineerColor(engineerId) },
            geometry: {
              type: 'LineString' as const,
              coordinates: [
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
              color: engineerColor(engineerId),
              regionColor: regionStyle(route ? routeRegion(snapshot, route) : null).color,
              current: graph.activeNodeKeys.has(start.key) ? 1 : 0,
            },
            geometry: {
              type: 'Point' as const,
              coordinates: [start.lon, start.lat],
            },
          },
        ];
      });

      const stopFeatures = projections.flatMap(({ engineerId, graph }) =>
        graph.mapNodes.flatMap((node, index) => {
          if (node.kind === 'start') return [];
          if (node.kind === 'lunch') {
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
                  coordinates: [node.lon, node.lat],
                },
              },
            ];
          }
          if (!node.requestId) {
            return [];
          }
          const request = snapshot.requests.find((item) => item.id === node.requestId);
          const sequence = graph.mapNodes
            .slice(0, index + 1)
            .filter((item) => item.kind === 'job').length;
          return [
            {
              type: 'Feature' as const,
              properties: {
                requestId: node.requestId,
                sequence,
                skillMark: request ? skillMark(request.requiredSkill) : '',
                engineerId,
                selected: node.requestId === selectedRequestId ? 1 : 0,
                color: engineerColor(engineerId),
                regionColor: regionStyle(request ? requestRegion(snapshot, request) : null).color,
                current: graph.activeNodeKeys.has(node.key) ? 1 : 0,
              },
              geometry: {
                type: 'Point' as const,
                coordinates: [node.lon, node.lat],
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
                regionColor: regionStyle(requestRegion(snapshot, request)).color,
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
          paint: {
            'line-color': '#ffffff',
            'line-width': ['case', ['==', ['get', 'selected'], 1], 7, 5],
          },
        });
        map.addLayer({
          id: 'routes-line',
          type: 'line',
          source: 'routes',
          paint: {
            'line-color': ['get', 'color'],
            'line-width': ['case', ['==', ['get', 'selected'], 1], 3.5, 2],
            'line-dasharray': [
              'case',
              ['==', ['get', 'approximate'], 1],
              ['literal', [2, 2]],
              ['literal', [1, 0]],
            ],
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
            'circle-radius': 7,
            'circle-color': '#ffffff',
            'circle-stroke-width': ['case', ['==', ['get', 'current'], 1], 5, 3],
            'circle-stroke-color': [
              'case',
              ['==', ['get', 'current'], 1],
              '#FFD100',
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
              'text-color': '#202124',
              'text-halo-color': '#ffffff',
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
              12,
              ['==', ['get', 'selected'], 1],
              10,
              8,
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
              'text-field': [
                'concat',
                ['to-string', ['get', 'sequence']],
                ' ',
                ['get', 'skillMark'],
              ],
              'text-size': 11,
              'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
            },
            paint: { 'text-color': '#ffffff' },
          });
      });

      upsert(map, 'lunches', { type: 'FeatureCollection', features: lunchFeatures }, () => {
        map.addLayer({
          id: 'lunch-circle',
          type: 'circle',
          source: 'lunches',
          paint: {
            'circle-radius': ['case', ['==', ['get', 'current'], 1], 11, 8],
            'circle-color': '#FFE7C2',
            'circle-stroke-width': ['case', ['==', ['get', 'current'], 1], 5, 3],
            'circle-stroke-color': ['case', ['==', ['get', 'current'], 1], '#FFD100', '#E07A2F'],
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
              'text-halo-color': '#ffffff',
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
            'circle-radius': ['case', ['==', ['get', 'selected'], 1], 10, 8],
            'circle-color': ['get', 'regionColor'],
            'circle-stroke-width': 2,
            'circle-stroke-color': '#202124',
          },
        });
      });

      const fitKey = `${retry}:${forceLocal}:${selectedEngineerId ?? 'all'}:${selectedRequestId ?? ''}`;
      if (fittedKeyRef.current !== fitKey) {
        fittedKeyRef.current = fitKey;
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
    return () => {
      map.off('style.load', onStyle);
      map.off('load', onStyle);
    };
  }, [selectedEngineerId, selectedRequestId, snapshot, progressByEngineer, forceLocal, retry]);

  return (
    <>
      <section
        ref={containerRef}
        aria-label="Карта маршрутов"
        aria-busy={!mapReady && !mapFailed}
        data-map-ready={mapReady}
        className="absolute inset-0 h-full w-full"
      />
      {!mapReady && !mapFailed ? (
        <div className="absolute top-14 left-3 rounded-xl bg-white px-3 py-2 text-xs text-muted">
          Загружаем карту…
        </div>
      ) : null}
      {localMap || mapFailed ? (
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
      <div className="pointer-events-none absolute bottom-3 left-3 rounded-xl bg-white/90 px-3 py-2 text-[11px] text-muted shadow">
        {selectedEngineerId
          ? 'Показан план выбранного инженера. Пунктир — схематичная связь точек, сплошная линия — геометрия дороги.'
          : 'План дня без live-позиции инженеров. Пунктир — схематичная связь точек, сплошная линия — геометрия дороги.'}
      </div>
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
