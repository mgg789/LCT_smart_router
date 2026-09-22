import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { Skill } from '../../generated/prisma/client';
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

/** Current import-package source for the public 14/3 live-demo seed. */
export const LIVE_DEMO_PACKAGE_PREFIX = 'upload:east:live-demo-v2-';

/** Previous 14/2 source prefix retained for existing imported demo packages. */
export const LEGACY_LIVE_DEMO_PACKAGE_PREFIX = 'upload:east:live-demo-v1-';

/** Prefixes accepted when looking up a live-demo package across the seed upgrade. */
export const LIVE_DEMO_PACKAGE_PREFIXES = [
  LIVE_DEMO_PACKAGE_PREFIX,
  LEGACY_LIVE_DEMO_PACKAGE_PREFIX,
] as const;

/** Deterministic sourceVersion of the 14/3 package for one Moscow civil date. */
export function liveDemoSourceVersion(workDate: string): string {
  return `live-demo-v2-${workDate}`;
}

/** ImportPackage.source written by UploadImportService for the 14/3 seed. */
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

/** Builds a deterministic 09:00–20:00 Moscow day using cached real map nodes. */
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
  // This point is an existing geocoded request location near Kuzminki/Okskaya.
  // It keeps the walking engineer's first edge short while the second required
  // walking request is in the Taganskaya area, where the offline metro graph can win.
  const walkingStart = geocodes.entries[7];
  if (!walkingStart) throw new Error('Missing cached walking-engineer start');
  const demoSkills: Skill[] = ['local', 'connection', 'emergency'];
  const digest = createHash('sha256').update(`live-demo-v2-${workDate}`).digest('hex');
  const operationId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  return {
    operationId,
    schemaVersion: '1.0',
    mode: 'new_region',
    region: 'east',
    sourceVersion: liveDemoSourceVersion(workDate),
    depot: { addressText: depot.address, ...depot.location },
    engineers: [
      ...(['Алексей Волков', 'Михаил Орлов'] as const).map((displayName, index) => ({
        externalId: `live-engineer-${index + 1}`,
        displayName,
        skills: [...demoSkills],
        transportType: 'car' as const,
        start: depot.location,
        shiftStartAt: start,
        shiftEndAt: end,
      })),
      {
        externalId: 'live-engineer-3',
        displayName: 'Ирина Соколова',
        skills: [...demoSkills],
        transportType: 'walk' as const,
        start: walkingStart.location,
        shiftStartAt: start,
        shiftEndAt: end,
      },
    ],
    requests: geocodes.entries.slice(1, 15).map((point, index) => {
      // The first point is close to the walking start; the second is near
      // Taganskaya and is deliberately placed in the following window so both
      // required-walk jobs can appear on one executable route.
      const windowOffset = index === 1 ? 75 * 60 : Math.floor(index / 2) * 75 * 60;
      return {
        externalId: `live-request-${String(index + 1).padStart(2, '0')}`,
        addressText: point.address,
        ...point.location,
        serviceDurationSec: 1800,
        windowStartAt: start + 20 * 60 + windowOffset,
        windowEndAt: start + 80 * 60 + windowOffset,
        priority: 'normal' as const,
        requiredSkill: 'local' as const,
        ...(index < 2 ? { requiredTransport: 'walk' as const } : {}),
        workType: 'local_repair',
      };
    }),
  };
}
