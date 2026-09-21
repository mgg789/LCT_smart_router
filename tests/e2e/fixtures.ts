import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { type APIRequestContext, test as base, expect, type Page } from '@playwright/test';
import { z } from 'zod';

const run = promisify(execFile);
const sessionSchema = z.object({ token: z.string().min(1) });
const engineerSchema = z.object({ id: z.string(), email: z.string().nullable() });
/** Preserve route geometry, timing and reasons for the full-plan outage comparison. */
export const planSchema = z
  .object({
    revision: z.number().int(),
    assignments: z.array(
      z
        .object({
          requestId: z.string(),
          status: z.string(),
          engineerId: z.string().nullable(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

type LiveDay = {
  api: APIRequestContext;
  engineer: z.infer<typeof engineerSchema>;
  plan: z.infer<typeof planSchema>;
};

/** Read an actual applied plan; absence or malformed contracts must fail the test. */
export async function readPlan(api: APIRequestContext) {
  const response = await api.get('/api/v1/dispatch/plan');
  expect(response.ok()).toBe(true);
  return z.object({ plan: planSchema }).parse(await response.json()).plan;
}

/** Authenticate through the real API using only disposable contour credentials. */
export async function dispatcherApi(request: APIRequestContext) {
  const response = await request.post('http://api:8000/api/v1/auth/dispatcher/password', {
    data: { email: process.env.DISPATCHER_EMAIL, password: process.env.DISPATCHER_PASSWORD },
  });
  expect(response.status()).toBe(201);
  return sessionSchema.parse(await response.json()).token;
}

/** Exercise the visible password form, never inject a browser auth/storage fixture. */
export async function signIn(page: Page) {
  await page.goto('/');
  expect(await page.evaluate(() => window.isSecureContext), 'private CI origin is trusted').toBe(
    true,
  );
  await page.getByRole('button', { name: 'Войти паролем', exact: true }).click();
  await page.getByLabel('Почта', { exact: true }).fill(process.env.DISPATCHER_EMAIL ?? '');
  await page.getByLabel('Пароль', { exact: true }).fill(process.env.DISPATCHER_PASSWORD ?? '');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  const start = page.getByRole('button', { name: 'Начать рабочий день', exact: true });
  const plan = page.getByRole('button', { name: 'План дня', exact: true });
  // After smoke the chrome («Загрузить данные») is already on screen with «План дня».
  // Wait only for the day controls; `.first()` keeps strict mode if both exist.
  await expect(start.or(plan).first()).toBeVisible({ timeout: 45_000 });
  if (await start.isVisible()) {
    await start.click();
    await expect(start).toBeHidden();
  }
  await expect(plan).toBeVisible({ timeout: 45_000 });
}

/**
 * Open dispatcher Settings from the avatar menu.
 * Selecting a menu item unmounts the dropdown; Playwright then reports
 * "element was detached" even when the dialog already opened. Retry until
 * the dialog is visible instead of treating that detach as a failed click.
 */
export async function openDispatcherSettings(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Настройки' });
  const avatar = page.getByRole('button', { name: 'Меню пользователя', exact: true });
  const item = page.getByRole('button', { name: 'Настройки', exact: true });

  await expect(async () => {
    if (await dialog.isVisible()) return;
    await expect(avatar).toBeVisible({ timeout: 5_000 });
    if ((await avatar.getAttribute('aria-expanded')) !== 'true') {
      await avatar.click({ timeout: 5_000 });
    }
    await expect(item).toBeVisible({ timeout: 3_000 });
    await item.click({ timeout: 5_000 });
    await expect(dialog).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
}

/** Isolated serial fixtures: real seed per test, external network blocked, error evidence. */
export const test = base.extend<{ live: LiveDay; browserHealth: undefined }>({
  browserHealth: [
    async ({ page, context }, use, testInfo) => {
      const errors: string[] = [];
      const consoleMessages: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => {
        if (['warning', 'error'].includes(message.type())) consoleMessages.push(message.text());
      });
      await context.route('**/*', (route) => {
        const url = new URL(route.request().url());
        return ['http:', 'https:'].includes(url.protocol) && url.origin !== 'http://localhost'
          ? route.abort('blockedbyclient')
          : route.continue();
      });
      await use(undefined);
      await testInfo.attach('browser-console', {
        body: JSON.stringify({ errors, consoleMessages }, null, 2),
        contentType: 'application/json',
      });
      expect(errors, 'uncaught browser errors').toEqual([]);
    },
    { auto: true },
  ],
  live: async ({ playwright }, use, testInfo) => {
    // Reuse the established public-API seed, golden-node calculation and urgent-event gate.
    // One extra attempt covers a leftover LIVE poll racing the empty reset; Playwright
    // itself still has retries: 0 so a real product failure is not hidden.
    const runSmoke = () =>
      run(process.execPath, ['apps/api/dist-test/scripts/smoke.js'], {
        timeout: 100_000,
        maxBuffer: 2 * 1024 * 1024,
      });
    let stdout = '';
    let stderr = '';
    let lastCause: unknown;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const result = await runSmoke();
        stdout = result.stdout;
        stderr = result.stderr;
        lastCause = undefined;
        break;
      } catch (cause: unknown) {
        lastCause = cause;
        const failure = z.object({ stdout: z.string(), stderr: z.string() }).safeParse(cause);
        if (failure.success) {
          await testInfo.attach(`seed-smoke-failure-${attempt}`, {
            body: failure.data.stdout + failure.data.stderr,
            contentType: 'text/plain',
          });
          stdout = failure.data.stdout;
          stderr = failure.data.stderr;
        }
      }
    }
    if (lastCause) {
      throw lastCause;
    }
    await testInfo.attach('seed-smoke', { body: stdout + stderr, contentType: 'text/plain' });
    expect(stdout).toContain('SMOKE GATE GREEN');
    const anonymous = await playwright.request.newContext();
    const token = await dispatcherApi(anonymous);
    await anonymous.dispose();
    const api = await playwright.request.newContext({
      baseURL: 'http://api:8000',
      extraHTTPHeaders: { Authorization: `Bearer ${token}` },
    });
    try {
      const response = await api.get('/api/v1/dispatch/engineers');
      expect(response.ok()).toBe(true);
      const { engineers } = z
        .object({ engineers: z.array(engineerSchema).length(1) })
        .parse(await response.json());
      const engineer = engineers[0];
      if (!engineer) throw new Error('Smoke engineer missing');
      const plan = await readPlan(api);
      expect(plan.assignments).toHaveLength(5);
      await use({ api, engineer, plan });
      // The next phase stops Router and checks that this exact applied plan survives.
      await mkdir('artifacts', { recursive: true });
      await writeFile('artifacts/last-plan.json', JSON.stringify(await readPlan(api)));
    } finally {
      await api.dispose();
    }
  },
});

export { expect };
