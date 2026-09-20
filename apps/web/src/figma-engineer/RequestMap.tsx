import maplibregl from 'maplibre-gl';
import { useEffect, useRef, useState } from 'react';
import { localMapStyle } from '../domain/localBasemap';

/** Real request coordinates on the shared offline-capable street map. */
export function RequestMap({ lat, lon }: { lat: number; lon: number }) {
  const container = useRef<HTMLDivElement>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    if (!container.current) return;
    let map: maplibregl.Map | undefined;
    const resize = new ResizeObserver(() => map?.resize());
    resize.observe(container.current);
    setUnavailable(false);
    try {
      map = new maplibregl.Map({
        container: container.current,
        style: localMapStyle(),
        center: [lon, lat],
        zoom: 14,
      });
      new maplibregl.Marker().setLngLat([lon, lat]).addTo(map);
      map.on('error', () => setUnavailable(true));
    } catch {
      setUnavailable(true);
    }
    return () => {
      resize.disconnect();
      map?.remove();
    };
  }, [lat, lon]);
  return (
    <>
      <div ref={container} className="absolute inset-0" aria-label="Местоположение заявки" />
      {unavailable ? (
        <p role="status" className="absolute left-2 top-2 rounded bg-white p-2 text-figma-ink">
          Карта недоступна. Адрес и навигация доступны ниже.
        </p>
      ) : null}
    </>
  );
}
