import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { dispatcherApi, expect, planSchema, readPlan, signIn, test } from './fixtures';

test('stopped Router leaves the last applied plan intact @router-down', async ({ playwright }) => {
  const anonymous = await playwright.request.newContext();
  const token = await dispatcherApi(anonymous);
  await anonymous.dispose();
  const api = await playwright.request.newContext({
    baseURL: 'http://api:8000',
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
  try {
    const previous = planSchema.parse(
      JSON.parse(await readFile('artifacts/last-plan.json', 'utf8')),
    );
    await expect
      .poll(async () => {
        const response = await api.get('/health/services');
        const health = z
          .object({ services: z.object({ router: z.object({ status: z.string() }) }) })
          .parse(await response.json());
        return health.services.router.status;
      })
      .toBe('down');
    // Router is optional for serving stored business state (docs/api.md health contract).
    expect((await api.get('/health/ready')).status()).toBe(200);
    expect((await api.get('/health/live')).status()).toBe(200);
    const plan = await readPlan(api);
    expect(plan.revision).toBeGreaterThanOrEqual(previous.revision);
    expect(
      plan.assignments
        .map(({ requestId, engineerId, status }) => ({ requestId, engineerId, status }))
        .sort((left, right) => left.requestId.localeCompare(right.requestId)),
    ).toEqual(
      previous.assignments
        .map(({ requestId, engineerId, status }) => ({ requestId, engineerId, status }))
        .sort((left, right) => left.requestId.localeCompare(right.requestId)),
    );
  } finally {
    await api.dispose();
  }
});

test('restarted Router restores routing health without losing requests @router-recovery', async ({
  playwright,
  page,
}) => {
  const anonymous = await playwright.request.newContext();
  const token = await dispatcherApi(anonymous);
  await anonymous.dispose();
  const api = await playwright.request.newContext({
    baseURL: 'http://api:8000',
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
  try {
    await expect.poll(async () => (await api.get('/health/ready')).status()).toBe(200);
    await expect
      .poll(async () => {
        const response = await api.get('/health/services');
        return z
          .object({ services: z.object({ router: z.object({ status: z.string() }) }) })
          .parse(await response.json()).services.router.status;
      })
      .toBe('ok');
    const previous = planSchema.parse(
      JSON.parse(await readFile('artifacts/last-plan.json', 'utf8')),
    );
    const plan = await readPlan(api);
    expect(plan.assignments.map((item) => item.requestId).sort()).toEqual(
      previous.assignments.map((item) => item.requestId).sort(),
    );
    // The real browser must also be usable after the backend dependency returns.
    await signIn(page);
    await expect(page.getByText('0 без назначения', { exact: false })).toBeVisible();
  } finally {
    await api.dispose();
  }
});
