import { z } from 'zod';
import { expect, readPlan, signIn, test } from './fixtures';

test('live plan renders the local map and replans when an engineer goes offline', async ({
  page,
  live,
}, testInfo) => {
  await signIn(page);
  await expect(page.getByText('0 без назначения', { exact: false })).toBeVisible();
  await expect(page.locator('[data-map-ready="true"]')).toBeVisible();
  await expect(
    page.getByText('Сохранённая карта района демо · улицы, парки и водоёмы'),
  ).toBeVisible();
  await page
    .getByRole('button')
    .filter({ has: page.getByTitle('Smoke East Engineer') })
    .click();
  await expect(page.getByText('Как они повлияли', { exact: true })).toBeVisible();
  await expect(page.getByText(/транспорт авто/)).toBeVisible();
  await page.getByRole('button', { name: 'Инженеры', exact: true }).click();
  // The dossier action reflects accepted server state, not an optimistic toggle.
  await page.getByRole('button', { name: 'Снять со смены', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await readPlan(live.api)).assignments.filter((item) => item.status === 'unassigned')
          .length,
      { timeout: 60_000 },
    )
    .toBe(5);
  await expect(page.getByRole('button', { name: 'Вернуть на смену', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Вернуть на смену', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await readPlan(live.api)).assignments.filter((item) => item.status === 'assigned').length,
      { timeout: 60_000 },
    )
    .toBe(5);
  await expect(page.getByRole('button', { name: 'Снять со смены', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'План дня', exact: true }).click();
  await expect(page.getByText('0 без назначения', { exact: false })).toBeVisible();
  expect((await readPlan(live.api)).revision).toBeGreaterThan(live.plan.revision);
  await expect(page.locator('[data-map-ready="true"]')).toBeVisible();
  await testInfo.attach('day-after-replanning', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
});

test('connection loss preserves the real day, disables writes and recovers', async ({
  page,
  context,
  live,
}) => {
  await signIn(page);
  await expect(page.getByRole('button', { name: 'Загрузить данные', exact: true })).toBeVisible();
  const ids = live.plan.assignments.map((item) => item.requestId).sort();
  await page.getByRole('button', { name: 'Инженеры', exact: true }).click();
  const availabilityRequest = '**/api/v1/dispatch/engineers/*/availability';
  await context.route(availabilityRequest, (route) => route.abort('internetdisconnected'));
  await page.getByRole('button', { name: 'Снять со смены', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Снять со смены', exact: true })).toBeDisabled({
    timeout: 20_000,
  });
  // Read only persisted request identities; the UI cannot quietly substitute recorded demo data.
  const stored = z
    .object({ snapshot: z.object({ requests: z.array(z.object({ id: z.string() })) }) })
    .parse(
      await page.evaluate((): unknown =>
        JSON.parse(sessionStorage.getItem('lct.saved-day.v1') ?? 'null'),
      ),
  );
  expect(stored.snapshot.requests.map((item) => item.id).sort()).toEqual(ids);
  await context.unroute(availabilityRequest);
  await expect(page.getByRole('button', { name: 'Снять со смены', exact: true })).toBeEnabled();
  expect((await readPlan(live.api)).assignments.map((item) => item.requestId).sort()).toEqual(ids);
});

test('revoking a live session clears cached work and returns the browser to login', async ({
  page,
  live,
}) => {
  await signIn(page);
  // Obtain the real browser session through a request, then revoke it on the backend.
  const browserToken = await page.evaluate(() => sessionStorage.getItem('lct.dispatcher.session'));
  expect(browserToken).toBeTruthy();
  const response = await live.api.delete('/api/v1/auth/session', {
    headers: { Authorization: `Bearer ${browserToken}` },
  });
  expect(response.ok()).toBe(true);
  await expect(page.getByLabel('Почта', { exact: true })).toBeVisible({ timeout: 20_000 });
  expect(await page.evaluate(() => sessionStorage.getItem('lct.saved-day.v1'))).toBeNull();
  await expect(page.getByRole('button', { name: /Smoke East Engineer/ })).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel('Почта', { exact: true })).toBeVisible();
});
