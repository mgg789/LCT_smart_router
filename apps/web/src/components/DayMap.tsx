import maplibregl from 'maplibre-gl';
import { useEffect, useRef } from 'react';
import type { DashboardSnapshot } from '../api/types';
import { plannedActivity, routeLegs, unassignedRequests } from '../domain/dashboard';
import { engineerColor } from '../lib/reasons';

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
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const onSelectRef = useRef(onSelectRequest);
  const fittedKeyRef = useRef<string | null>(null);
  onSelectRef.current = onSelectRequest;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const map = new maplibregl.Map({
      container,
      style: STYLE_URL,
      center: [37.62, 55.75],
      zoom: 11.4,
      attributionControl: false,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    map.on('click', 'stops-circle', (event) => pickRequest(event, onSelectRef));
    map.on('click', 'unassigned-circle', (event) => pickRequest(event, onSelectRef));
    const observer = new ResizeObserver(() => map.resize());
    observer.observe(container);
    mapRef.current = map;
    return () => {
      observer.disconnect();
      map.remove();
      mapRef.current = null;
    };
  }, []);

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
        const activity = plannedActivity(snapshot, route.engineerId);
        return routeLegs(route).map((leg) => ({
          type: 'Feature' as const,
          properties: {
            engineerId: route.engineerId,
            selected: !selectedEngineerId || route.engineerId === selectedEngineerId ? 1 : 0,
            active: activity?.kind === 'traveling' && activity.legIndex === leg.index ? 1 : 0,
            color: engineerColor(route.engineerId),
          },
          geometry: {
            type: 'LineString' as const,
            coordinates: [
              [leg.from.lon, leg.from.lat],
              [leg.to.lon, leg.to.lat],
            ],
          },
        }));
      });

      const startFeatures = routes.map((route) => ({
        type: 'Feature' as const,
        properties: {
          engineerId: route.engineerId,
          selected: !selectedEngineerId || route.engineerId === selectedEngineerId ? 1 : 0,
          color: engineerColor(route.engineerId),
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
                  active:
                    plannedActivity(snapshot, route.engineerId)?.kind === 'lunch' &&
                    snapshot.nowAt >= stop.startAt &&
                    snapshot.nowAt < stop.endAt
                      ? 1
                      : 0,
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
          const activity = plannedActivity(snapshot, route.engineerId);
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
                active:
                  activity?.kind === 'on_site' && activity.requestId === stop.requestId ? 1 : 0,
                color: engineerColor(route.engineerId),
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
            'line-width': [
              'case',
              ['==', ['get', 'active'], 1],
              10,
              ['==', ['get', 'selected'], 1],
              7,
              5,
            ],
          },
        });
        map.addLayer({
          id: 'routes-line',
          type: 'line',
          source: 'routes',
          paint: {
            'line-color': ['get', 'color'],
            'line-width': [
              'case',
              ['==', ['get', 'active'], 1],
              6,
              ['==', ['get', 'selected'], 1],
              3.5,
              2,
            ],
            'line-opacity': [
              'case',
              ['==', ['get', 'active'], 1],
              1,
              ['==', ['get', 'selected'], 1],
              0.9,
              0.35,
            ],
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
            'circle-stroke-color': ['get', 'color'],
          },
        });
        map.addLayer({
          id: 'starts-label',
          type: 'symbol',
          source: 'starts',
          layout: {
            'text-field': 'Старт',
            'text-size': 11,
            'text-offset': [0, 1.2],
            'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
          },
          paint: { 'text-color': '#202124', 'text-halo-color': '#ffffff', 'text-halo-width': 1.2 },
        });
      });

      upsert(map, 'stops', { type: 'FeatureCollection', features: jobFeatures }, () => {
        map.addLayer({
          id: 'stops-halo',
          type: 'circle',
          source: 'stops',
          filter: ['==', ['get', 'active'], 1],
          paint: {
            'circle-radius': 18,
            'circle-color': ['get', 'color'],
            'circle-opacity': 0.22,
          },
        });
        map.addLayer({
          id: 'stops-circle',
          type: 'circle',
          source: 'stops',
          paint: {
            'circle-radius': [
              'case',
              ['==', ['get', 'active'], 1],
              12,
              ['==', ['get', 'selected'], 1],
              10,
              8,
            ],
            'circle-color': ['get', 'color'],
            'circle-stroke-width': ['case', ['==', ['get', 'active'], 1], 4, 2],
            'circle-stroke-color': '#ffffff',
          },
        });
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
          id: 'lunch-halo',
          type: 'circle',
          source: 'lunches',
          filter: ['==', ['get', 'active'], 1],
          paint: {
            'circle-radius': 16,
            'circle-color': '#E07A2F',
            'circle-opacity': 0.25,
          },
        });
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
          paint: { 'text-color': '#8A4B12', 'text-halo-color': '#ffffff', 'text-halo-width': 1.2 },
        });
      });

      upsert(map, 'activity', { type: 'FeatureCollection', features: [] }, () => {});

      upsert(map, 'unassigned', { type: 'FeatureCollection', features: unassignedFeatures }, () => {
        map.addLayer({
          id: 'unassigned-circle',
          type: 'circle',
          source: 'unassigned',
          paint: {
            'circle-radius': ['case', ['==', ['get', 'selected'], 1], 10, 8],
            'circle-color': '#FED305',
            'circle-stroke-width': 2,
            'circle-stroke-color': '#202124',
          },
        });
      });

      const fitKey = `${selectedEngineerId ?? 'all'}:${selectedRequestId ?? ''}`;
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

    if (apply()) {
      return;
    }
    const onStyle = () => {
      apply();
    };
    map.on('styledata', onStyle);
    map.once('load', onStyle);
    return () => {
      map.off('styledata', onStyle);
      map.off('load', onStyle);
    };
  }, [selectedEngineerId, selectedRequestId, snapshot]);

  return (
    <>
      <div ref={containerRef} className="absolute inset-0 h-full w-full" />
      <div className="pointer-events-none absolute bottom-3 left-3 rounded-xl bg-white/90 px-3 py-2 text-[11px] text-muted shadow">
        {selectedEngineerId
          ? 'Показан маршрут выбранного инженера. Крестик в карточке заявки возвращает общий план.'
          : 'Общий план дня: все маршруты. В пути подсвечивается участок, не точка — GPS нет.'}
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
