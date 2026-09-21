import type { StyleSpecification } from 'maplibre-gl';

/**
 * OSM Bright from OpenFreeMap: no API key, OpenStreetMap data under ODbL.
 *
 * This is an external dependency of the demo contour — a deliberate choice by the
 * owner (19.09.2026) over the offline GeoJSON basemap, which only covered the
 * east demo district.
 */
export const BRIGHT_STYLE_URL = 'https://tiles.openfreemap.org/styles/bright';

/**
 * What the map falls back to when the tile service cannot be reached.
 *
 * The basemap disappears, the day does not: stops and routes are drawn from the
 * plan itself and keep working with no network at all.
 */
export function blankStyle(): StyleSpecification {
  return {
    version: 8,
    sources: {},
    layers: [
      {
        id: 'blank-background',
        type: 'background',
        paint: { 'background-color': '#eef0f2' },
      },
    ],
  };
}
