import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { geocodePackageSchema } from '../../src/orchestrator/imports/dataset-import.service';
import { normalizeAddress, parseSyntheticFile } from '../../src/orchestrator/imports/dataset.parser';

/** Repo root, resolved from the compiled test location under `apps/api/dist-test/test/unit`. */
const repoRoot = resolve(__dirname, '../../../../..');

const REGIONS = ['east', 'south_central', 'southeast'] as const;

// Moscow + the Moscow Oblast south; every dataset address must sit inside. Anything
// outside is a homonym hit (a same-named street in another city) that leaked through.
const VIEWBOX = { minLat: 54.2, maxLat: 56.3, minLon: 35.8, maxLon: 39.8 };

describe('official dataset geocode packages', () => {
  for (const region of REGIONS) {
    it(`${region}: schema, provenance, coverage of the TZ addresses`, () => {
      const raw: unknown = JSON.parse(
        readFileSync(resolve(repoRoot, 'data/dataset/geocoded', `${region}.json`), 'utf8'),
      );
      const parsed = geocodePackageSchema.safeParse(raw);
      assert.equal(parsed.success, true, 'geocode package must match geocodePackageSchema');
      if (!parsed.success) {
        return;
      }
      assert.match(parsed.data.version ?? '', /locationiq-\d{4}-\d{2}-\d{2}$/);
      assert.match(parsed.data.source, /LocationIQ/);

      const points = new Map<string, { lat: number; lon: number }>();
      for (const entry of parsed.data.entries) {
        const address = normalizeAddress(entry.address);
        assert.equal(points.has(address), false, `duplicate address: ${address}`);
        points.set(address, entry.location);
        assert.ok(
          entry.location.lat > VIEWBOX.minLat &&
            entry.location.lat < VIEWBOX.maxLat &&
            entry.location.lon > VIEWBOX.minLon &&
            entry.location.lon < VIEWBOX.maxLon,
          `${address} resolved outside Moscow Oblast: ${JSON.stringify(entry.location)}`,
        );
      }

      const datasetBytes = readFileSync(
        resolve(repoRoot, 'data/dataset/anonymized', `${region}_synthetic_data.csv`),
      );
      const dataset = parseSyntheticFile(region, datasetBytes, 3 * 3600);
      const required = dataset.requests.map((request) => normalizeAddress(request.addressText));
      if (dataset.depot) {
        required.push(normalizeAddress(dataset.depot.addressText));
      }
      for (const address of required) {
        assert.ok(points.has(address), `geocode package misses dataset address: ${address}`);
      }
    });
  }
});
