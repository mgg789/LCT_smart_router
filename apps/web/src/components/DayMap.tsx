import maplibregl from 'maplibre-gl';
import { useEffect, useRef, useState } from 'react';
import type { LiveRouteProgress } from '../api/live';
import type { DashboardSnapshot } from '../api/types';
import { remainingRouteForLiveMap, unassignedRequests } from '../domain/dashboard';
import { localMapStyle } from '../domain/localBasemap';
import { regionStyle, requestRegion, routeRegion } from '../domain/regions';
import { mapRouteSegments } from '../domain/travel';
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

/**
 * Projects the factual part of a LIVE route. A completed job remains the edge
 * anchor until the next job is explicitly started; lunch is a two-leg span.
 */
export function liveProgressSegments(progress: LiveRouteProgress): LiveProgressSegment[] {
  if (progress.phase === 'lunch' && progress.lunch && progress.next) {
    return [
      { from: progress.anchor, to: progress.lunch },
      { from: progress.lunch, to: progress.next },
    ];
  }
  if (progress.phase === 'traveling' && progress.next) {
    return [{ from: progress.anchor, to: progress.next }];
  }
  return [];
}

/** Current factual vertices: job anchor and the lunch point while lunch is active. */
export function liveProgressPoints(
  progress: LiveRouteProgress,
): readonly LiveRouteProgress['anchor'][] {
  return progress.phase === 'lunch' && progress.lunch
    ? [progress.anchor, progress.lunch]
    : [progress.anchor];
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
      // The map is a live forward-looking graph. Completed and cancelled vertices
      // stay in the dispatcher timeline/history but are not shown as future map points.
      const routes = selectedRoutes
        .map((route) => remainingRouteForLiveMap(snapshot, route))
        .filter((route): route is NonNullable<typeof route> => route !== null);
      const viewingUnassigned = unassignedRequests(snapshot).some(
        (request) => request.id === selectedRequestId,
      );
      const showUnassigned = selectedEngineerId === null || viewingUnassigned;

      const lineFeatures = routes.flatMap((route) => {
        const region = routeRegion(snapshot, route);
        return mapRouteSegments(route).map((segment) => ({
          type: 'Feature' as const,
          properties: {
            engineerId: route.engineerId,
            selected: !selectedEngineerId || route.engineerId === selectedEngineerId ? 1 : 0,
            approximate: segment.approximate ? 1 : 0,
            color: engineerColor(route.engineerId),
            regionColor: regionStyle(region).color,
            travelSource: segment.source,
          },
          geometry: {
            type: 'LineString' as const,
            coordinates: segment.coordinates,
          },
        }));
      });

      const progressLines = [...(progressByEngineer ?? [])].flatMap(([engineerId, progress]) => {
        if (
          !progress ||
          progress.phase === 'not_started' ||
          progress.phase === 'on_site' ||
          (selectedEngineerId !== null && selectedEngineerId !== engineerId)
        )
          return [];
        return liveProgressSegments(progress).map((segment) => {
          const { from: point, to: next } = segment;
          return {
            type: 'Feature' as const,
            properties: { engineerId, color: engineerColor(engineerId) },
            geometry: {
              type: 'LineString' as const,
              coordinates: [[point.lon, point.lat] as const, [next.lon, next.lat] as const],
            },
          };
        });
      });

      const startFeatures = routes.flatMap((route) => {
        const progress = progressByEngineer?.get(route.engineerId) ?? null;
        if (progress && progress.anchor.kind !== 'start') return [];
        const start = progress?.anchor;
        return [
          {
            type: 'Feature' as const,
            properties: {
              engineerId: route.engineerId,
              selected: !selectedEngineerId || route.engineerId === selectedEngineerId ? 1 : 0,
              color: engineerColor(route.engineerId),
              regionColor: regionStyle(routeRegion(snapshot, route)).color,
            },
            geometry: {
              type: 'Point' as const,
              coordinates: start ? [start.lon, start.lat] : [route.startLon, route.startLat],
            },
          },
        ];
      });

      const stopFeatures = routes.flatMap((route) =>
        route.stops.flatMap((stop, index) => {
          if (stop.kind === 'lunch') {
            return [
              {
                type: 'Feature' as const,
                properties: {
                  engineerId: route.engineerId,
                  selected: !selectedEngineerId || route.engineerId === selectedEngineerId ? 1 : 0,
                },
                geometry: {
                  type: 'Point' as const,
                  coordinates: [stop.lon, stop.lat],
                },
              },
            ];
          }
          if (!stop.requestId) {
            return [];
          }
          const request = snapshot.requests.find((item) => item.id === stop.requestId);
          const sequence = route.stops
            .slice(0, index + 1)
            .filter((item) => item.kind === 'job').length;
          return [
            {
              type: 'Feature' as const,
              properties: {
                requestId: stop.requestId,
                sequence,
                skillMark: request ? skillMark(request.requiredSkill) : '',
                engineerId: route.engineerId,
                selected: stop.requestId === selectedRequestId ? 1 : 0,
                color: engineerColor(route.engineerId),
                regionColor: regionStyle(request ? requestRegion(snapshot, request) : null).color,
              },
              geometry: {
                type: 'Point' as const,
                coordinates: [stop.lon, stop.lat],
              },
            },
          ];
        }),
      );

      const progressFeatures = routes.flatMap((route) => {
        const progress = progressByEngineer?.get(route.engineerId) ?? null;
        if (!progress) return [];
        const points = liveProgressPoints(progress);
        return points.flatMap((point) => {
          if (point.kind === 'start') return [];
          const request = point.requestId
            ? snapshot.requests.find((item) => item.id === point.requestId)
            : null;
          return [
            {
              type: 'Feature' as const,
              properties: {
                ...(point.requestId ? { requestId: point.requestId } : {}),
                engineerId: route.engineerId,
                sequence: '•',
                skillMark:
                  point.kind === 'lunch' ? 'Обед' : request ? skillMark(request.requiredSkill) : '',
                color: point.kind === 'lunch' ? '#E07A2F' : engineerColor(route.engineerId),
                regionColor: '#ffffff',
                current: 1,
                lunch: point.kind === 'lunch' ? 1 : 0,
              },
              geometry: { type: 'Point' as const, coordinates: [point.lon, point.lat] },
            },
          ];
        });
      });

      // A replan can temporarily omit an engineer's route while that engineer is
      // still on a confirmed job. The progress record is sufficient to keep the
      // current vertex on the map in that narrow gap.
      const orphanProgressFeatures = [...(progressByEngineer ?? [])].flatMap(
        ([engineerId, progress]) => {
          if (
            !progress ||
            routes.some((route) => route.engineerId === engineerId) ||
            (selectedEngineerId !== null && selectedEngineerId !== engineerId)
          ) {
            return [];
          }
          return liveProgressPoints(progress).flatMap((point) => {
            if (point.kind === 'start') return [];
            return [
              {
                type: 'Feature' as const,
                properties: {
                  ...(point.requestId ? { requestId: point.requestId } : {}),
                  engineerId,
                  sequence: '•',
                  skillMark: point.kind === 'lunch' ? 'Обед' : '',
                  color: point.kind === 'lunch' ? '#E07A2F' : engineerColor(engineerId),
                  regionColor: '#ffffff',
                  current: 1,
                  lunch: point.kind === 'lunch' ? 1 : 0,
                },
                geometry: { type: 'Point' as const, coordinates: [point.lon, point.lat] },
              },
            ];
          });
        },
      );

      const lunchFeatures = [
        ...stopFeatures,
        ...progressFeatures,
        ...orphanProgressFeatures,
      ].filter((feature) => !('requestId' in feature.properties));
      const jobFeatures = [...stopFeatures, ...progressFeatures, ...orphanProgressFeatures].filter(
        (feature) => 'requestId' in feature.properties,
      );

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
            'circle-stroke-width': 3,
            'circle-stroke-color': ['get', 'regionColor'],
          },
        });
        if (map.getStyle().glyphs)
          map.addLayer({
            id: 'starts-label',
            type: 'symbol',
            source: 'starts',
            layout: {
              'text-field': 'Старт плана',
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
            'circle-radius': 8,
            'circle-color': '#FFE7C2',
            'circle-stroke-width': 3,
            'circle-stroke-color': '#E07A2F',
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
        const fitRoutes = selectedEngineerId
          ? routes.filter((route) => route.engineerId === selectedEngineerId)
          : routes;
        for (const route of fitRoutes) {
          bounds.extend([route.startLon, route.startLat]);
          for (const stop of route.stops) {
            bounds.extend([stop.lon, stop.lat]);
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
