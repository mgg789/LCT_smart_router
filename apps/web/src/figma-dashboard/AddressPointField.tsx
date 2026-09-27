import maplibregl from 'maplibre-gl';
import { useEffect, useRef, useState } from 'react';
import { geocodeAddress } from '../api/client';
import type { DispatchRegion } from '../api/regions';
import type { GeocodeHit } from '../api/types';
import { localMapStyle } from '../domain/localBasemap';
import { browserMapOnline, ONLINE_MAP_STYLE, watchMapStartup } from '../domain/mapAvailability';
import { t } from '../i18n';

const FIELD =
  'mt-[8px] h-[56px] w-full rounded-[20px] border border-figma-ink/15 bg-white px-[18px] font-medium text-[18px] tracking-[-0.3px] text-figma-ink outline-none placeholder:text-figma-hint focus:border-figma-ink';

/**
 * Address search via LocationIQ autocomplete plus an OSM click map.
 * A map click sets coordinates without reverse geocoding.
 */
export function AddressPointField({
  id,
  label,
  token,
  addressText,
  lat,
  lon,
  onAddressChange,
  onResolved,
  onMapPick,
  offices,
}: {
  id: string;
  label: string;
  token: string | null;
  addressText: string;
  lat: number | null;
  lon: number | null;
  onAddressChange: (value: string) => void;
  onResolved: (hit: GeocodeHit) => void;
  onMapPick: (lat: number, lon: number) => void;
  offices?: DispatchRegion[];
}) {
  const [hits, setHits] = useState<GeocodeHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  useEffect(() => {
    if (!token || addressText.trim().length < 3 || lat !== null) {
      setHits([]);
      return;
    }
    const handle = window.setTimeout(() => {
      setSearching(true);
      setSearchError(null);
      void geocodeAddress(token, { q: addressText.trim() })
        .then((next) => setHits(next))
        .catch((cause: unknown) => {
          setHits([]);
          setSearchError(
            cause instanceof Error
              ? cause.message
              : t('figma-dashboard.AddressPointField.d2b6fd7fec'),
          );
        })
        .finally(() => setSearching(false));
    }, 400);
    return () => window.clearTimeout(handle);
  }, [addressText, lat, token]);

  return (
    <div className="mt-[20px]">
      <label className="block font-semibold text-[16px] text-figma-ink" htmlFor={id}>
        {label}
        <input
          id={id}
          value={addressText}
          onChange={(event) => onAddressChange(event.target.value)}
          placeholder={t('figma-dashboard.AddressPointField.b9c33d62d8')}
          className={FIELD}
        />
      </label>
      {searching ? (
        <p className="mt-[8px] text-[13px] text-figma-muted">
          {t('figma-dashboard.AddressPointField.56fc5471cc')}
        </p>
      ) : null}
      {searchError ? <p className="mt-[8px] text-[13px] text-figma-danger">{searchError}</p> : null}
      {hits.length > 0 ? (
        <ul className="mt-[8px] overflow-hidden rounded-[16px] border border-figma-ink/10">
          {hits.map((hit) => (
            <li key={`${hit.lat}:${hit.lon}:${hit.displayName}`}>
              <button
                type="button"
                onClick={() => {
                  onResolved(hit);
                  setHits([]);
                }}
                className="w-full px-[16px] py-[10px] text-left font-medium text-[15px] text-figma-ink hover:bg-figma-canvas"
              >
                {hit.displayName}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="mt-[10px] font-medium text-[13px] text-figma-muted">
        {t('figma-dashboard.AddressPointField.16a42e402a')}
        {lat !== null && lon !== null
          ? t('figma-dashboard.AddressPointField.0ad59713fc', {
              value0: lat.toFixed(5),
              value1: lon.toFixed(5),
            })
          : ''}
      </p>
      <OsmPointMap lat={lat} lon={lon} onPick={onMapPick} offices={offices} />
    </div>
  );
}

function OsmPointMap({
  lat,
  lon,
  onPick,
  offices,
}: {
  lat: number | null;
  lon: number | null;
  onPick: (lat: number, lon: number) => void;
  offices?: DispatchRegion[];
}) {
  const host = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const pickRef = useRef(onPick);
  const initialCenter = useRef<[number, number]>([lon ?? 37.6173, lat ?? 55.7558]);
  pickRef.current = onPick;

  useEffect(() => {
    if (!host.current || mapRef.current) return;
    const local = !browserMapOnline();
    const map = new maplibregl.Map({
      container: host.current,
      style: local ? localMapStyle() : ONLINE_MAP_STYLE,
      center: initialCenter.current,
      zoom: 11,
      attributionControl: false,
    });
    const stopWatching = local ? null : watchMapStartup(map, () => map.setStyle(localMapStyle()));
    map.on('click', (event) => {
      pickRef.current(event.lngLat.lat, event.lngLat.lng);
    });
    mapRef.current = map;
    return () => {
      stopWatching?.();
      markerRef.current?.remove();
      markerRef.current = null;
      map.remove();
      mapRef.current = null;
    };
    // The map is created once for the field lifetime; marker updates follow lat/lon.
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const markers = (offices ?? []).flatMap((office) => {
      if (office.lat === null || office.lon === null) return [];
      const marker = new maplibregl.Marker({ color: '#262830' })
        .setLngLat([office.lon, office.lat])
        .setPopup(new maplibregl.Popup({ offset: 20 }).setText(office.region))
        .addTo(map);
      marker.getElement().title = office.region;
      marker.getElement().addEventListener('click', (event) => event.stopPropagation());
      return [marker];
    });
    if (markers.length > 0) {
      const bounds = new maplibregl.LngLatBounds();
      for (const marker of markers) bounds.extend(marker.getLngLat());
      map.fitBounds(bounds, { padding: 40, maxZoom: 11, duration: 0 });
    }
    return () => {
      for (const marker of markers) marker.remove();
    };
  }, [offices]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || lat === null || lon === null) return;
    if (!markerRef.current) {
      markerRef.current = new maplibregl.Marker({ color: '#ffc72c' })
        .setLngLat([lon, lat])
        .addTo(map);
    } else {
      markerRef.current.setLngLat([lon, lat]);
    }
    map.easeTo({ center: [lon, lat], duration: 250 });
  }, [lat, lon]);

  return (
    <div
      ref={host}
      className="mt-[8px] h-[220px] w-full overflow-hidden rounded-[20px] bg-figma-canvas"
    />
  );
}
