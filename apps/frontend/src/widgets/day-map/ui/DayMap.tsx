import { useQuery } from '@tanstack/react-query';
import type { Map as MapLibreMap, StyleSpecification } from 'maplibre-gl';
import maplibregl from 'maplibre-gl';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PlanRouteView } from '@/entities/plan';
import type { RequestView } from '@/entities/request';
import { BRIGHT_STYLE_URL, blankStyle } from '../lib/mapStyle';
import { boundsOf, buildRequestPoints, buildRouteLine } from '../model/mapFeatures';
import 'maplibre-gl/dist/maplibre-gl.css';

export interface DayMapProps {
  requests: RequestView[];
  route: PlanRouteView | null;
  selectedRequestId: string | null;
  onSelectRequest: (requestId: string) => void;
}

const POINTS_SOURCE = 'day-requests';
const ROUTE_SOURCE = 'day-route';

/** Colours match the day's language elsewhere on the screen. */
const STATE_COLOR: maplibregl.ExpressionSpecification = [
  'match',
  ['get', 'state'],
  'unassigned',
  '#ffc72c',
  'completed',
  '#33c200',
  'running',
  '#0a7347',
  '#272930',
];

/**
 * Fetches the basemap style once, and falls back to a plain background when the
 * tile service cannot be reached — the plan stays readable with no network.
 */
function useBasemapStyle() {
  return useQuery<{ style: StyleSpecification; remote: boolean }>({
    queryKey: ['basemap', BRIGHT_STYLE_URL],
    staleTime: Number.POSITIVE_INFINITY,
    retry: 1,
    queryFn: async () => {
      try {
        const response = await fetch(BRIGHT_STYLE_URL, { signal: AbortSignal.timeout(8000) });
        if (!response.ok) throw new Error(`style ${response.status}`);
        return { style: (await response.json()) as StyleSpecification, remote: true };
      } catch {
        return { style: blankStyle(), remote: false };
      }
    },
  });
}

/**
 * The day on a map: every request that has coordinates, and the selected crew's
 * route through them.
 *
 * Legs are straight dashed segments on purpose. The contract gives stop
 * coordinates and no road geometry, so drawing a road would be an invention —
 * a dashed straight line states exactly what the plan knows (D-29).
 */
export function DayMap({ requests, route, selectedRequestId, onSelectRequest }: DayMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const selectRef = useRef(onSelectRequest);
  selectRef.current = onSelectRequest;

  const [layersReady, setLayersReady] = useState(false);
  const basemap = useBasemapStyle();
  const points = useMemo(() => buildRequestPoints(requests), [requests]);
  const line = useMemo(() => buildRouteLine(route), [route]);
  /** The stops of the selected route, so the camera can frame just that crew. */
  const routeRequests = useMemo(() => {
    if (!route) return [];
    const ids = new Set(route.stops.map((stop) => stop.requestId).filter(Boolean));
    return requests.filter((request) => ids.has(request.id));
  }, [route, requests]);
  const hasGlyphs = basemap.data?.remote ?? false;

  // One map instance per style; the style only resolves once.
  useEffect(() => {
    const container = containerRef.current;
    const style = basemap.data?.style;
    if (!container || !style) return;

    const map = new maplibregl.Map({
      container,
      style,
      center: [37.62, 55.75],
      zoom: 9,
      attributionControl: { compact: true },
    });
    mapRef.current = map;

    map.on('load', () => {
      map.addSource(ROUTE_SOURCE, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addSource(POINTS_SOURCE, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      map.addLayer({
        id: 'day-route-line',
        type: 'line',
        source: ROUTE_SOURCE,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#272930', 'line-width': 2, 'line-dasharray': [2, 2] },
      });
      map.addLayer({
        id: 'day-request-circles',
        type: 'circle',
        source: POINTS_SOURCE,
        paint: {
          'circle-radius': ['case', ['==', ['get', 'selected'], true], 11, 7],
          'circle-color': STATE_COLOR,
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
        },
      });
      if (hasGlyphs) {
        map.addLayer({
          id: 'day-request-badges',
          type: 'symbol',
          source: POINTS_SOURCE,
          filter: ['==', ['get', 'selected'], true],
          layout: {
            'text-field': ['get', 'badge'],
            // Naming the font matters: the default one is absent from this
            // style's glyph set and every label request 404s.
            'text-font': ['Noto Sans Bold'],
            'text-size': 11,
            'text-offset': [0, -1.6],
          },
          paint: { 'text-color': '#272930', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
        });
      }

      map.on('click', 'day-request-circles', (event) => {
        const id = event.features?.[0]?.properties?.requestId;
        if (typeof id === 'string') selectRef.current(id);
      });
      map.on('mouseenter', 'day-request-circles', () => {
        map.getCanvas().style.cursor = 'pointer';
      });
      map.on('mouseleave', 'day-request-circles', () => {
        map.getCanvas().style.cursor = '';
      });

      setLayersReady(true);
    });

    return () => {
      setLayersReady(false);
      map.remove();
      mapRef.current = null;
    };
  }, [basemap.data?.style, hasGlyphs]);

  // Data updates ride on the existing instance; the map is never rebuilt for them.
  // They wait on an explicit readiness flag rather than on an `idle` event: once
  // the map settles, `idle` stops firing and a late listener would never run.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !layersReady) return;

    const marked = {
      ...points,
      features: points.features.map((feature) => ({
        ...feature,
        properties: {
          ...feature.properties,
          selected: feature.properties.requestId === selectedRequestId,
        },
      })),
    };

    (map.getSource(POINTS_SOURCE) as maplibregl.GeoJSONSource | undefined)?.setData(marked);
    (map.getSource(ROUTE_SOURCE) as maplibregl.GeoJSONSource | undefined)?.setData(line);
  }, [layersReady, points, line, selectedRequestId]);

  // Frame the crew being looked at; with no route, frame the whole day. Re-framing
  // is keyed on the route, so polling the plan does not yank the camera around.
  const framedRef = useRef<string | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !layersReady) return;

    const key = route?.engineerId ?? 'all';
    if (framedRef.current === key) return;

    const bounds = route ? boundsOf(buildRequestPoints(routeRequests)) : boundsOf(points);
    if (!bounds) return;

    framedRef.current = key;
    map.fitBounds(bounds, { padding: 64, maxZoom: 14, animate: false });
  }, [layersReady, points, route, routeRequests]);

  return (
    <div className="relative min-h-[280px] flex-1 overflow-hidden rounded-[20px] bg-surface">
      {/* h-full, not inset-0: maplibre-gl.css forces position:relative on this node. */}
      <div className="h-full w-full" ref={containerRef} />
      {basemap.isPending ? (
        <p className="absolute inset-0 grid place-items-center text-[15px] text-ink/55">
          Загружаем карту…
        </p>
      ) : null}
      {basemap.data && !basemap.data.remote ? (
        <p className="absolute right-3 bottom-3 left-3 rounded-xl bg-surface/90 px-3 py-2 text-[12px] text-ink/70">
          Подложка недоступна — точки и маршрут показаны без неё.
        </p>
      ) : null}
    </div>
  );
}
