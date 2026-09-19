import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from 'dotenv';
import { z } from 'zod';
import type { UploadDataPackageInput } from '../src/orchestrator/imports/upload-import.service';

const geocodesSchema = z.object({
  entries: z.array(z.object({
    address: z.string(),
    location: z.object({ lat: z.number(), lon: z.number() }),
  })).min(15),
});

/** Builds a deterministic synthetic 09:00–20:00 Moscow day using cached real map nodes. */
export function buildLiveDemo(workDate: string, root: string): UploadDataPackageInput {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate)) throw new Error('Expected YYYY-MM-DD');
  const start = Date.parse(`${workDate}T09:00:00+03:00`) / 1000;
  if (!Number.isSafeInteger(start) || new Date(start * 1000).toISOString().slice(0, 10) !== workDate) {
    throw new Error('Invalid calendar date');
  }
  const end = start + 11 * 3600;
  const geocodes = geocodesSchema.parse(JSON.parse(readFileSync(
    resolve(root, 'data/dataset/geocoded/east.json'), 'utf8',
  )));
  const depot = geocodes.entries[0];
  if (!depot) throw new Error('Missing cached depot');
  const digest = createHash('sha256').update(`live-demo-v1-${workDate}`).digest('hex');
  const operationId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  return {
    operationId, schemaVersion: '1.0', mode: 'new_region', region: 'east',
    sourceVersion: `live-demo-v1-${workDate}`,
    depot: { addressText: depot.address, ...depot.location },
    engineers: ['Алексей Волков', 'Михаил Орлов'].map((displayName, index) => ({
      externalId: `live-engineer-${index + 1}`, displayName,
      skills: ['local', 'connection', 'emergency'], transportType: 'car',
      start: depot.location, shiftStartAt: start, shiftEndAt: end,
    })),
    requests: geocodes.entries.slice(1, 15).map((point, index) => ({
      externalId: `live-request-${String(index + 1).padStart(2, '0')}`,
      addressText: point.address, ...point.location,
      serviceDurationSec: 1800,
      windowStartAt: start + 20 * 60 + Math.floor(index / 2) * 75 * 60,
      windowEndAt: end,
      priority: 'normal', requiredSkill: 'local', workType: 'local_repair',
    })),
  };
}

/** Imports only into an empty local contour; never resets an existing working set. */
async function main(): Promise<void> {
  let root = __dirname;
  while (!existsSync(resolve(root, 'pnpm-workspace.yaml'))) {
    const parent = dirname(root);
    if (parent === root) throw new Error('Cannot locate the LCT workspace');
    root = parent;
  }
  config({ path: resolve(root, '.env'), quiet: true });
  const base = new URL(process.env.LIVE_DEMO_BASE_URL ?? 'http://127.0.0.1:8000');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) {
    throw new Error('LIVE demo preparation is restricted to a local contour');
  }
  const call = async (path: string, token?: string, body?: unknown): Promise<unknown> => {
    const response = await fetch(new URL(`/api/v1${path}`, base), {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    return response.json();
  };
  const login = z.object({ token: z.string() }).parse(await call('/auth/dispatcher/password', undefined, {
    email: process.env.DISPATCHER_EMAIL, password: process.env.DISPATCHER_PASSWORD,
  }));
  const existing = z.object({ requests: z.array(z.unknown()) }).parse(await call('/dispatch/requests', login.token));
  if (existing.requests.length) throw new Error('Contour is not empty. Use a separate database or explicitly reset through the dispatcher UI.');
  const workDate = process.env.LIVE_DEMO_DATE ?? new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  const result = z.object({ requestsCreated: z.number(), engineersCreated: z.number() }).passthrough();
  const raw = await call('/dispatch/data/upload', login.token, buildLiveDemo(workDate, root));
  const summary = result.parse(raw);
  console.log(`LIVE demo prepared: ${summary.requestsCreated} requests, ${summary.engineersCreated} engineers, ${workDate} 09:00–20:00 Europe/Moscow. Day has not been started.`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'LIVE demo preparation failed');
    process.exitCode = 1;
  });
}
