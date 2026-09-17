import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { demoScenarios, recordedScenario } from '../demo/scenarios';
import { LOCAL_MAP_BOUNDS, localMapStyle } from './localBasemap';

const point = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);
const collection = z.object({
  type: z.literal('FeatureCollection'),
  features: z.array(
    z.object({
      type: z.literal('Feature'),
      id: z.number().int(),
      properties: z.object({
        kind: z.enum(['road', 'water', 'park']),
        class: z.string(),
        name: z.string(),
      }),
      geometry: z.discriminatedUnion('type', [
        z.object({ type: z.literal('LineString'), coordinates: z.array(point).min(2) }),
        z.object({
          type: z.literal('Polygon'),
          coordinates: z.array(z.array(point).min(4)).min(1),
        }),
      ]),
    }),
  ),
});

describe('real local demo basemap', () => {
  it('contains valid attributed OSM geometry and matches its provenance hash', () => {
    const bytes = readFileSync(new URL('../../public/maps/east-demo.geojson', import.meta.url));
    const data = collection.parse(JSON.parse(bytes.toString('utf8')));
    const manifest = z
      .object({ fileSha256: z.string(), featureCount: z.number(), license: z.literal('ODbL-1.0') })
      .parse(
        JSON.parse(
          readFileSync(new URL('../../public/maps/manifest.json', import.meta.url), 'utf8'),
        ),
      );
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(manifest.fileSha256);
    expect(data.features.length).toBe(manifest.featureCount);
    expect(data.features.filter((f) => f.properties.kind === 'road').length).toBeGreaterThan(1000);
    expect(data.features.some((f) => f.properties.kind === 'water')).toBe(true);
    expect(data.features.some((f) => f.properties.kind === 'park')).toBe(true);
    expect(new Set(data.features.map((f) => f.id)).size).toBe(data.features.length);
  });

  it('covers every recorded request and engineer start in all presentation scenarios', () => {
    const [west, south, east, north] = LOCAL_MAP_BOUNDS;
    for (const scenario of demoScenarios) {
      const snapshot = recordedScenario(scenario.id).snapshot;
      const points = [
        ...snapshot.requests.map((r) => [r.lon, r.lat]),
        ...snapshot.engineers.map((e) => [e.homeLon, e.homeLat]),
      ];
      for (const [lon, lat] of points) {
        expect(lon).toBeGreaterThanOrEqual(west);
        expect(lon).toBeLessThanOrEqual(east);
        expect(lat).toBeGreaterThanOrEqual(south);
        expect(lat).toBeLessThanOrEqual(north);
      }
    }
  });

  it('renders a local street source without remote fonts, tiles or sprites', () => {
    const style = localMapStyle();
    expect(style.sources['local-basemap']).toMatchObject({
      type: 'geojson',
      data: '/maps/east-demo.geojson',
    });
    expect(style.layers.some((layer) => layer.id === 'local-roads')).toBe(true);
    expect(style.glyphs).toBeUndefined();
    expect(style.sprite).toBeUndefined();
    expect(JSON.stringify(style)).not.toContain('https://');
  });
});
