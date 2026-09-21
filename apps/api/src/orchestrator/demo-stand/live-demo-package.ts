import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { UploadDataPackageInput } from '../imports/upload-import.service';

const geocodesSchema = z.object({
  entries: z
    .array(
      z.object({
        address: z.string(),
        location: z.object({ lat: z.number(), lon: z.number() }),
      }),
    )
    .min(15),
});

/** Import-package source used to recognise the public 14/2 live-demo seed. */
export const LIVE_DEMO_PACKAGE_PREFIX = 'upload:east:live-demo-v1-';

/** Deterministic sourceVersion of the 14/2 package for one Moscow civil date. */
export function liveDemoSourceVersion(workDate: string): string {
  return `live-demo-v1-${workDate}`;
}

/** ImportPackage.source written by UploadImportService for the 14/2 seed. */
export function liveDemoPackageSource(workDate: string): string {
  return `${LIVE_DEMO_PACKAGE_PREFIX}${workDate}`;
}

/**
 * Cached East geocode file next to the official CSV directory.
 *
 * `DATASET_ROOT` points at `…/anonymized`; the live-demo coordinates live in the
 * sibling `geocoded/east.json` that the container already mounts.
 */
export function liveDemoGeocodePath(datasetRoot: string): string {
  return resolve(datasetRoot, '..', 'geocoded', 'east.json');
}

/** Builds a deterministic synthetic 09:00–20:00 Moscow day using cached real map nodes. */
export function buildLiveDemo(workDate: string, datasetRoot: string): UploadDataPackageInput {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate)) throw new Error('Expected YYYY-MM-DD');
  const start = Date.parse(`${workDate}T09:00:00+03:00`) / 1000;
  if (
    !Number.isSafeInteger(start) ||
    new Date(start * 1000).toISOString().slice(0, 10) !== workDate
  ) {
    throw new Error('Invalid calendar date');
  }
  const end = start + 11 * 3600;
  const geocodes = geocodesSchema.parse(
    JSON.parse(readFileSync(liveDemoGeocodePath(datasetRoot), 'utf8')),
  );
  const depot = geocodes.entries[0];
  if (!depot) throw new Error('Missing cached depot');
  const digest = createHash('sha256').update(`live-demo-v1-${workDate}`).digest('hex');
  const operationId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  return {
    operationId,
    schemaVersion: '1.0',
    mode: 'new_region',
    region: 'east',
    sourceVersion: liveDemoSourceVersion(workDate),
    depot: { addressText: depot.address, ...depot.location },
    engineers: ['Алексей Волков', 'Михаил Орлов'].map((displayName, index) => ({
      externalId: `live-engineer-${index + 1}`,
      displayName,
      skills: ['local', 'connection', 'emergency'],
      transportType: 'car',
      start: depot.location,
      shiftStartAt: start,
      shiftEndAt: end,
    })),
    requests: geocodes.entries.slice(1, 15).map((point, index) => ({
      externalId: `live-request-${String(index + 1).padStart(2, '0')}`,
      addressText: point.address,
      ...point.location,
      serviceDurationSec: 1800,
      windowStartAt: start + 20 * 60 + Math.floor(index / 2) * 75 * 60,
      windowEndAt: start + 80 * 60 + Math.floor(index / 2) * 75 * 60,
      priority: 'normal',
      requiredSkill: 'local',
      workType: 'local_repair',
    })),
  };
}
