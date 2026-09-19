import maplibregl from 'maplibre-gl';
import { useEffect, useRef, useState } from 'react';
import type { DashboardSnapshot } from '../api/types';
import { unassignedRequests } from '../domain/dashboard';
import { localMapStyle } from '../domain/localBasemap';
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
import { mapRouteSegments } from '../domain/travel';
import { engineerColor, skillMark } from '../lib/reasons';

interface DayMapProps {
  readonly snapshot: DashboardSnapshot;
  readonly selectedEngineerId: string | null;
  readonly selectedRequestId: string | null;
  readonly onSelectRequest: (requestId: string) => void;
}

const STYLE_URL = 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json';

export function DayMap({
  snapshot,
  selectedEngineerId,
  selectedRequestId,
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
      const routes = selectedEngineerId
        ? allRoutes.filter((route) => route.engineerId === selectedEngineerId)
        : allRoutes;
      const viewingUnassigned = unassignedRequests(snapshot).some(
        (request) => request.id === selectedRequestId,
      );
      const showUnassigned = selectedEngineerId === null || viewingUnassigned;

      const zoom = map.getZoom();
      const sampleLat = routes[0]?.startLat ?? 55.75;
      const dashMeters = metersPerPixel(sampleLat, zoom) * MAP_ROUTE_DASH_PX;
      const gapMeters = metersPerPixel(sampleLat, zoom) * MAP_ROUTE_GAP_PX;
      const lineFeatures = routes.flatMap((route) => {
        const region = routeRegion(snapshot, route);
        return mapRouteSegments(route).flatMap((segment) => {
          const paths = segment.approximate
            ? pillDashLine(segment.coordinates, dashMeters, gapMeters)
            : [segment.coordinates.map((point) => [point[0], point[1]] as [number, number])];
          return paths.map((coordinates) => ({
            type: 'Feature' as const,
            properties: {
              engineerId: route.engineerId,
              selected: !selectedEngineerId || route.engineerId === selectedEngineerId ? 1 : 0,
              approximate: segment.approximate ? 1 : 0,
              color: mapPaintColor(engineerColor(route.engineerId)),
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

      const startFeatures = routes.map((route) => ({
        type: 'Feature' as const,
        properties: {
          engineerId: route.engineerId,
          selected: !selectedEngineerId || route.engineerId === selectedEngineerId ? 1 : 0,
          color: mapPaintColor(engineerColor(route.engineerId)),
          regionColor: mapPaintColor(regionStyle(routeRegion(snapshot, route)).color),
        },
        geometry: {
          type: 'Point' as const,
          coordinates: [route.startLon, route.startLat],
        },
      }));

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
                color: mapPaintColor(engineerColor(route.engineerId)),
                regionColor: mapPaintColor(
                  regionStyle(request ? requestRegion(snapshot, request) : null).color,
                ),
              },
              geometry: {
                type: 'Point' as const,
                coordinates: [stop.lon, stop.lat],
              },
            },
          ];
        }),
      );

      const lunchFeatures = stopFeatures.filter((feature) => !('requestId' in feature.properties));
      const jobFeatures = stopFeatures.filter((feature) => 'requestId' in feature.properties);

      const unassignedFeatures = (showUnassigned ? unassignedRequests(snapshot) : []).flatMap(
        (request) => {
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
        },
      );

      upsert(map, 'routes', { type: 'FeatureCollection', features: lineFeatures }, () => {
        map.addLayer({
          id: 'routes-casing',
          type: 'line',
          source: 'routes',
          layout: {
            'line-cap': 'round',
            'line-join': 'round',
          },
          paint: {
            'line-color': MAP_CANVAS,
            'line-width': ['case', ['==', ['get', 'selected'], 1], 9, 7],
          },
        });
        map.addLayer({
          id: 'routes-line',
          type: 'line',
          source: 'routes',
          layout: {
            'line-cap': 'round',
            'line-join': 'round',
          },
          paint: {
            'line-color': ['get', 'color'],
            'line-width': ['case', ['==', ['get', 'selected'], 1], 5, 3.5],
            'line-opacity': ['case', ['==', ['get', 'selected'], 1], 0.9, 0.35],
          },
        });
      });

      upsert(map, 'starts', { type: 'FeatureCollection', features: startFeatures }, () => {
        map.addLayer({
          id: 'starts-square',
          type: 'circle',
          source: 'starts',
          paint: {
            'circle-radius': 11,
            'circle-color': MAP_CANVAS,
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
            'circle-radius': ['case', ['==', ['get', 'selected'], 1], 16, 13],
            'circle-color': ['get', 'color'],
            'circle-stroke-width': ['case', ['==', ['get', 'selected'], 1], 4, 2.5],
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
            'circle-radius': 12,
            'circle-color': MAP_LUNCH_FILL,
            'circle-stroke-width': 3,
            'circle-stroke-color': MAP_LUNCH_STROKE,
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
      syncOverlayPaint(map);

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
    const onZoom = () => {
      apply();
    };
    map.on('style.load', onStyle);
    map.once('load', onStyle);
    map.on('zoomend', onZoom);
    return () => {
      map.off('style.load', onStyle);
      map.off('load', onStyle);
      map.off('zoomend', onZoom);
    };
  }, [selectedEngineerId, selectedRequestId, snapshot, forceLocal, retry]);

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

/** Keeps overlay paint/layout current after the first addLayer. */
function syncOverlayPaint(map: maplibregl.Map): void {
  for (const layer of ['routes-casing', 'routes-line'] as const) {
    if (!map.getLayer(layer)) continue;
    map.setLayoutProperty(layer, 'line-cap', 'round');
    map.setLayoutProperty(layer, 'line-join', 'round');
  }
  if (map.getLayer('routes-casing')) {
    map.setPaintProperty('routes-casing', 'line-color', MAP_CANVAS);
    map.setPaintProperty('routes-casing', 'line-width', [
      'case',
      ['==', ['get', 'selected'], 1],
      9,
      7,
    ]);
  }
  if (map.getLayer('routes-line')) {
    map.setPaintProperty('routes-line', 'line-width', [
      'case',
      ['==', ['get', 'selected'], 1],
      5,
      3.5,
    ]);
  }
  if (map.getLayer('starts-square')) {
    map.setPaintProperty('starts-square', 'circle-color', MAP_CANVAS);
  }
  if (map.getLayer('starts-label')) {
    map.setPaintProperty('starts-label', 'text-color', MAP_INK);
    map.setPaintProperty('starts-label', 'text-halo-color', MAP_CANVAS);
  }
  if (map.getLayer('stops-label')) {
    map.setPaintProperty('stops-label', 'text-color', MAP_CANVAS);
  }
  if (map.getLayer('lunch-circle')) {
    map.setPaintProperty('lunch-circle', 'circle-color', MAP_LUNCH_FILL);
    map.setPaintProperty('lunch-circle', 'circle-stroke-color', MAP_LUNCH_STROKE);
  }
  if (map.getLayer('lunch-label')) {
    map.setPaintProperty('lunch-label', 'text-halo-color', MAP_CANVAS);
  }
  if (map.getLayer('unassigned-circle')) {
    map.setPaintProperty('unassigned-circle', 'circle-stroke-color', MAP_INK);
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
