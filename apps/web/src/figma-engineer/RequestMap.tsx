import maplibregl from 'maplibre-gl';
import { useEffect, useRef, useState } from 'react';
import { LOCAL_MAP_BOUNDS, localMapStyle } from '../domain/localBasemap';
import { ONLINE_MAP_STYLE, watchMapStartup } from '../domain/mapAvailability';

/** Real request coordinates on the shared offline-capable street map. */
export function RequestMap({ lat, lon }: { lat: number; lon: number }) {
  const container = useRef<HTMLElement>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    if (!container.current) return;
    let map: maplibregl.Map | undefined;
    let stopWatching: (() => void) | undefined;
    let local = !navigator.onLine;
    const outsideCoverage =
      lon < LOCAL_MAP_BOUNDS[0] ||
      lon > LOCAL_MAP_BOUNDS[2] ||
      lat < LOCAL_MAP_BOUNDS[1] ||
      lat > LOCAL_MAP_BOUNDS[3];
    const fallback = () => {
      if (local || !map) return;
      local = true;
      setUnavailable(outsideCoverage);
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
    setUnavailable(local && outsideCoverage);
    try {
      map = new maplibregl.Map({
        container: container.current,
        style: local ? localMapStyle() : ONLINE_MAP_STYLE,
        center: [lon, lat],
        zoom: 14,
      });
      new maplibregl.Marker().setLngLat([lon, lat]).addTo(map);
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
      map?.remove();
    };
  }, [lat, lon]);
  return (
    <>
      <section
        ref={container}
        className="absolute inset-0"
        style={{ position: 'absolute' }}
        aria-label="Местоположение заявки"
      />
      {unavailable ? (
        <p role="status" className="absolute left-2 top-2 rounded bg-white p-2 text-figma-ink">
          Карта недоступна. Адрес и навигация доступны ниже.
        </p>
      ) : null}
    </>
  );
}
