import maplibregl from 'maplibre-gl';
import { useEffect, useRef, useState } from 'react';
import { LOCAL_MAP_BOUNDS, localMapStyle } from '../domain/localBasemap';
import { ONLINE_MAP_STYLE, watchMapStartup } from '../domain/mapAvailability';
import { CLIENT_MAP_CENTER, type ClientMapPoint } from './clientPreview';

/**
 * Street map for the client request form. Starts without a pin; a click
 * places one, later clicks move it. Shared by the compact and expanded views.
 */
export function ClientPickMap({
  point,
  onPick,
}: {
  point: ClientMapPoint | null;
  onPick?: (next: ClientMapPoint) => void;
}) {
  const container = useRef<HTMLElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const onPickRef = useRef(onPick);
  const [unavailable, setUnavailable] = useState(false);
  onPickRef.current = onPick;

  useEffect(() => {
    if (!container.current) return;
    let map: maplibregl.Map | undefined;
    let stopWatching: (() => void) | undefined;
    let local = !navigator.onLine;
    const fallback = () => {
      if (local || !map) return;
      local = true;
      setUnavailable(true);
      map.setStyle(localMapStyle());
    };
    const online = () => {
      if (!map) return;
      local = false;
      setUnavailable(false);
      map.setStyle(ONLINE_MAP_STYLE);
      stopWatching?.();
      stopWatching = watchMapStartup(map, fallback);
    };
    const resize = new ResizeObserver(() => map?.resize());
    resize.observe(container.current);
    try {
      map = new maplibregl.Map({
        container: container.current,
        style: local ? localMapStyle() : ONLINE_MAP_STYLE,
        center: [CLIENT_MAP_CENTER.lon, CLIENT_MAP_CENTER.lat],
        zoom: 13,
      });
      mapRef.current = map;
      map.on('click', (event) => {
        onPickRef.current?.({ lat: event.lngLat.lat, lon: event.lngLat.lng });
      });
      map.on('error', (event) => {
        if (local && 'sourceId' in event && event.sourceId === 'local-basemap')
          setUnavailable(true);
      });
      stopWatching = watchMapStartup(map, fallback);
      window.addEventListener('offline', fallback);
      window.addEventListener('online', online);
    } catch {
      setUnavailable(true);
    }
    return () => {
      resize.disconnect();
      stopWatching?.();
      window.removeEventListener('offline', fallback);
      window.removeEventListener('online', online);
      markerRef.current?.remove();
      markerRef.current = null;
      map?.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (point === null) {
      markerRef.current?.remove();
      markerRef.current = null;
      return;
    }
    const outside =
      point.lon < LOCAL_MAP_BOUNDS[0] ||
      point.lon > LOCAL_MAP_BOUNDS[2] ||
      point.lat < LOCAL_MAP_BOUNDS[1] ||
      point.lat > LOCAL_MAP_BOUNDS[3];
    if (outside && !navigator.onLine) setUnavailable(true);
    if (markerRef.current) {
      markerRef.current.setLngLat([point.lon, point.lat]);
    } else {
      markerRef.current = new maplibregl.Marker().setLngLat([point.lon, point.lat]).addTo(map);
    }
  }, [point]);

  return (
    <>
      <section
        ref={container}
        className="absolute inset-0"
        style={{ position: 'absolute' }}
        aria-label="Карта адреса заявки"
      />
      {unavailable ? (
        <p role="status" className="absolute left-2 top-2 rounded bg-white p-2 text-figma-ink">
          Карта недоступна. Адрес можно ввести текстом.
        </p>
      ) : null}
    </>
  );
}
