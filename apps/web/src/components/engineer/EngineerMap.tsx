import maplibregl from 'maplibre-gl';
import { useEffect, useRef, useState } from 'react';
import { localMapStyle } from '../../domain/localBasemap';

export interface EngineerMapMarker {
  readonly id: string;
  readonly lat: number;
  readonly lon: number;
  readonly kind: 'job' | 'lunch' | 'start' | 'wait';
  readonly label: string;
}

interface EngineerMapProps {
  readonly markers: readonly EngineerMapMarker[];
  readonly line: ReadonlyArray<{ readonly lat: number; readonly lon: number }>;
}

const STYLE_URL = 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json';

/** Compact MapLibre view of the signed-in crew's stops. */
export function EngineerMap({ markers, line }: EngineerMapProps) {
  const [forceLocal, setForceLocal] = useState(!navigator.onLine);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [mapFailed, setMapFailed] = useState(false);

  useEffect(() => {
    const update = () => setForceLocal(!navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    setMapFailed(false);
    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container,
        style: forceLocal ? localMapStyle() : STYLE_URL,
        center: [markers[0]?.lon ?? 37.62, markers[0]?.lat ?? 55.75],
        zoom: markers.length <= 1 ? 14 : 11.4,
        attributionControl: false,
      });
    } catch {
      setMapFailed(true);
      return;
    }
    let fallback = forceLocal;
    const activateLocal = () => {
      if (fallback) return;
      fallback = true;
      map.setStyle(localMapStyle());
    };
    const timeout = window.setTimeout(() => {
      if (!map.isStyleLoaded()) activateLocal();
    }, 6000);
    map.on('error', activateLocal);
    const draw = () => {
      const lineFeatures =
        line.length >= 2
          ? [
              {
                type: 'Feature' as const,
                properties: {},
                geometry: {
                  type: 'LineString' as const,
                  coordinates: line.map((point) => [point.lon, point.lat]),
                },
              },
            ]
          : [];
      upsertSource(map, 'engineer-line', { type: 'FeatureCollection', features: lineFeatures });
      if (!map.getLayer('engineer-line')) {
        map.addLayer({
          id: 'engineer-line',
          type: 'line',
          source: 'engineer-line',
          paint: { 'line-color': '#202124', 'line-width': 3, 'line-opacity': 0.7 },
        });
      }
      const pointFeatures = markers.map((marker) => ({
        type: 'Feature' as const,
        properties: { kind: marker.kind, label: marker.label },
        geometry: { type: 'Point' as const, coordinates: [marker.lon, marker.lat] },
      }));
      upsertSource(map, 'engineer-stops', { type: 'FeatureCollection', features: pointFeatures });
      if (!map.getLayer('engineer-stops')) {
        map.addLayer({
          id: 'engineer-stops',
          type: 'circle',
          source: 'engineer-stops',
          paint: {
            'circle-radius': 9,
            'circle-color': [
              'match',
              ['get', 'kind'],
              'lunch',
              '#FFE7C2',
              'start',
              '#ffffff',
              '#202124',
            ],
            'circle-stroke-width': 2,
            'circle-stroke-color': [
              'match',
              ['get', 'kind'],
              'lunch',
              '#E07A2F',
              'start',
              '#5f6368',
              '#fed305',
            ],
          },
        });
      }
      const first = markers[0];
      if (first) {
        const bounds = new maplibregl.LngLatBounds([first.lon, first.lat], [first.lon, first.lat]);
        for (const marker of markers) {
          bounds.extend([marker.lon, marker.lat]);
        }
        map.fitBounds(bounds, { padding: 48, maxZoom: 15, duration: 0 });
      }
    };
    map.on('load', draw);
    map.on('styledata', () => {
      if (map.isStyleLoaded()) draw();
    });
    return () => {
      window.clearTimeout(timeout);
      map.remove();
    };
  }, [forceLocal, line, markers]);

  if (mapFailed) {
    return (
      <div className="flex h-64 items-center justify-center rounded-2xl bg-canvas text-sm text-muted">
        Карта недоступна
      </div>
    );
  }

  return <div ref={containerRef} className="h-64 w-full overflow-hidden rounded-2xl bg-canvas" />;
}

function upsertSource(
  map: maplibregl.Map,
  id: string,
  data: Parameters<maplibregl.GeoJSONSource['setData']>[0],
): void {
  const existing = map.getSource(id);
  if (existing && existing instanceof maplibregl.GeoJSONSource) {
    existing.setData(data);
    return;
  }
  map.addSource(id, { type: 'geojson', data });
}
