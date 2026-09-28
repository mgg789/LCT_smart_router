import type { StyleSpecification } from 'maplibre-gl';

/** Offline OSM coverage for the whole MKAD interior and the three official regions, west/south/east/north in WGS84. */
export const LOCAL_MAP_BOUNDS = [37.35, 54.8, 38.2, 55.93] as const;

/** Local street/water/park layers below route overlays; never needs remote tiles or glyphs. */
export function localMapStyle(): StyleSpecification {
  return {
    version: 8,
    sources: {
      'local-basemap': {
        type: 'geojson',
        data: '/maps/official-regions.geojson',
        attribution: '© OpenStreetMap contributors · ODbL',
      },
    },
    layers: [
      { id: 'local-background', type: 'background', paint: { 'background-color': '#fafaf8' } },
      {
        id: 'local-parks',
        type: 'fill',
        source: 'local-basemap',
        filter: ['all', ['==', '$type', 'Polygon'], ['==', 'kind', 'park']],
        paint: { 'fill-color': '#e4eddd' },
      },
      {
        id: 'local-water',
        type: 'fill',
        source: 'local-basemap',
        filter: ['all', ['==', '$type', 'Polygon'], ['==', 'kind', 'water']],
        paint: { 'fill-color': '#d7eaf2' },
      },
      {
        id: 'local-waterways',
        type: 'line',
        source: 'local-basemap',
        filter: ['all', ['==', '$type', 'LineString'], ['==', 'kind', 'water']],
        paint: { 'line-color': '#c1dce8', 'line-width': 3 },
      },
      {
        id: 'local-road-casing',
        type: 'line',
        source: 'local-basemap',
        filter: ['==', 'kind', 'road'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#d9d9d5',
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1, 13, 4, 16, 10],
        },
      },
      {
        id: 'local-roads',
        type: 'line',
        source: 'local-basemap',
        filter: ['==', 'kind', 'road'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#ffffff',
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.5, 13, 2.5, 16, 8],
        },
      },
      {
        id: 'local-major-roads',
        type: 'line',
        source: 'local-basemap',
        filter: ['in', 'class', 'motorway', 'trunk', 'primary', 'secondary'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#f5df9a',
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1, 13, 2.5, 16, 6],
        },
      },
    ],
  };
}
