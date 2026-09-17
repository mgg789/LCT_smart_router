import maplibregl from 'maplibre-gl';
import { useEffect, useRef, useState } from 'react';
import type { DashboardSnapshot } from '../api/types';
import { unassignedRequests } from '../domain/dashboard';
import { regionStyle, requestRegion, routeRegion } from '../domain/regions';
import { mapRouteSegments } from '../domain/travel';
import { engineerColor } from '../lib/reasons';

interface DayMapProps {
  readonly forceLocal?: boolean;
  readonly snapshot: DashboardSnapshot;
  readonly selectedEngineerId: string | null;
  readonly selectedRequestId: string | null;
  readonly onSelectRequest: (requestId: string) => void;
}

const STYLE_URL = 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json';

export function DayMap({
  forceLocal = false,
  snapshot,
  selectedEngineerId,
  selectedRequestId,
  onSelectRequest,
}: DayMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const onSelectRef = useRef(onSelectRequest);
  const fittedKeyRef = useRef<string | null>(null);
  const [localMap, setLocalMap] = useState(forceLocal);
  const [mapFailed, setMapFailed] = useState(false);
  onSelectRef.current = onSelectRequest;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    setLocalMap(forceLocal);
    setMapFailed(false);
    fittedKeyRef.current = null;
    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container,
        style: forceLocal ? localStyle() : STYLE_URL,
        center: [37.62, 55.75],
        zoom: 11.4,
        attributionControl: false,
      });
    } catch {
      setMapFailed(true);
      return;
    }
    let fallback = forceLocal;
    const activateLocalMap = () => {
      if (fallback) return;
      fallback = true;
      setLocalMap(true);
      map.setStyle(localStyle());
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
      map.remove();
      mapRef.current = null;
    };
  }, [forceLocal]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }

    const apply = () => {
      if (mapRef.current !== map || !map.isStyleLoaded()) {
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

      const startFeatures = routes.map((route) => ({
        type: 'Feature' as const,
        properties: {
          engineerId: route.engineerId,
          selected: !selectedEngineerId || route.engineerId === selectedEngineerId ? 1 : 0,
          color: engineerColor(route.engineerId),
          regionColor: regionStyle(routeRegion(snapshot, route)).color,
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
                selected: request.id === selectedRequestId ? 1 : 0,
                regionColor: regionStyle(requestRegion(snapshot, request)).color,
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
            'circle-radius': ['case', ['==', ['get', 'selected'], 1], 10, 8],
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

      const fitKey = `${forceLocal}:${selectedEngineerId ?? 'all'}:${selectedRequestId ?? ''}`;
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
  }, [selectedEngineerId, selectedRequestId, snapshot, forceLocal]);

  return (
    <>
      <div ref={containerRef} className="absolute inset-0 h-full w-full" />
      {localMap || mapFailed ? (
        <div
          role="status"
          className="absolute top-3 left-3 right-3 rounded-xl bg-white px-3 py-2 text-xs text-ink shadow"
        >
          {mapFailed
            ? 'Карта недоступна в этом браузере. Используйте список заявок и таймлайн.'
            : 'Локальная схема без подложки улиц · точки и маршруты доступны'}
        </div>
      ) : null}
      <div className="pointer-events-none absolute bottom-3 left-3 rounded-xl bg-white/90 px-3 py-2 text-[11px] text-muted shadow">
        {selectedEngineerId
          ? 'Показан план выбранного инженера. Пунктир — схематичная связь точек, сплошная линия — геометрия дороги.'
          : 'План дня без live-позиции инженеров. Пунктир — схематичная связь точек, сплошная линия — геометрия дороги.'}
      </div>
    </>
  );
}

/** Network-free geographic canvas; never presents invented streets as map data. */
function localStyle(): maplibregl.StyleSpecification {
  return {
    version: 8,
    sources: {},
    layers: [
      { id: 'local-background', type: 'background', paint: { 'background-color': '#fafaf8' } },
    ],
  };
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
