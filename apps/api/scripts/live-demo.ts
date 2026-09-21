import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from 'dotenv';
import { z } from 'zod';
import { buildLiveDemo } from '../src/orchestrator/demo-stand/live-demo-package';

export { buildLiveDemo } from '../src/orchestrator/demo-stand/live-demo-package';

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
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    return response.json();
  };
  const login = z.object({ token: z.string() }).parse(
    await call('/auth/dispatcher/password', undefined, {
      email: process.env.DISPATCHER_EMAIL,
      password: process.env.DISPATCHER_PASSWORD,
    }),
  );
  const existing = z
    .object({ requests: z.array(z.unknown()) })
    .parse(await call('/dispatch/requests', login.token));
  if (existing.requests.length)
    throw new Error(
      'Contour is not empty. Use a separate database or explicitly reset through the dispatcher UI.',
    );
  const workDate =
    process.env.LIVE_DEMO_DATE ??
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Moscow',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  const result = z
    .object({ requestsCreated: z.number(), engineersCreated: z.number() })
    .passthrough();
  const datasetRoot = resolve(root, process.env.DATASET_ROOT ?? 'data/dataset/anonymized');
  const raw = await call(
    '/dispatch/data/upload',
    login.token,
    buildLiveDemo(workDate, datasetRoot),
  );
  const summary = result.parse(raw);
  console.log(
    `LIVE demo prepared: ${summary.requestsCreated} requests, ${summary.engineersCreated} engineers, ${workDate} 09:00–20:00 Europe/Moscow. Day has not been started.`,
  );
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'LIVE demo preparation failed');
    process.exitCode = 1;
  });
}
