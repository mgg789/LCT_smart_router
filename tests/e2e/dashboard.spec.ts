import { z } from 'zod';
import { expect, readPlan, signIn, test } from './fixtures';

test('live plan renders the local map and replans when an engineer goes offline', async ({
  page,
  live,
}, testInfo) => {
  await signIn(page);
  await expect(page.getByText('5 назначены', { exact: false })).toBeVisible();
  await expect(page.locator('[data-map-ready="true"]')).toBeVisible();
  await expect(
    page.getByText('Сохранённая карта района демо · улицы, парки и водоёмы'),
  ).toBeVisible();
  await page.getByRole('button', { name: /Smoke East Engineer/ }).click();
  await expect(
    page.getByText('Почему маршрут Smoke East Engineer такой', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/транспорт авто/)).toBeVisible();
  await page.getByRole('button', { name: 'Инженеры', exact: true }).click();
  // The controlled switch reflects the accepted server state, not an optimistic click.
  await page.getByRole('switch', { name: 'Отключить Smoke East Engineer' }).click();
  await expect
    .poll(
      async () =>
        (await readPlan(live.api)).assignments.filter((item) => item.status === 'unassigned')
          .length,
      { timeout: 60_000 },
    )
    .toBe(5);
  await expect(page.getByRole('switch', { name: 'Включить Smoke East Engineer' })).toBeEnabled();
  await expect(
    page.getByRole('switch', { name: 'Включить Smoke East Engineer' }),
  ).not.toBeChecked();
  await page.getByRole('switch', { name: 'Включить Smoke East Engineer' }).click();
  await expect
    .poll(
      async () =>
        (await readPlan(live.api)).assignments.filter((item) => item.status === 'assigned').length,
      { timeout: 60_000 },
    )
    .toBe(5);
  await expect(page.getByRole('switch', { name: 'Отключить Smoke East Engineer' })).toBeChecked();
  await page.getByRole('button', { name: 'План дня', exact: true }).click();
  await expect(page.getByText('5 назначены', { exact: false })).toBeVisible();
  expect((await readPlan(live.api)).revision).toBeGreaterThan(live.plan.revision);
  await expect(page.locator('[data-map-ready="true"]')).toBeVisible();
  await testInfo.attach('day-after-replanning', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
});

test('connection loss preserves the real day, disables writes and recovers after reload', async ({
  page,
  context,
  live,
}) => {
  await signIn(page);
  const importButton = page.getByRole('button', { name: 'Загрузить датасет из ТЗ или свой файл' });
  await expect(importButton).toBeEnabled();
  const ids = live.plan.assignments.map((item) => item.requestId).sort();
  await context.route('**/api/**', (route) => route.abort('connectionrefused'));
  await expect(importButton).toBeDisabled({ timeout: 20_000 });
  await page.reload();
  await expect(page.getByText('5 назначены', { exact: false })).toBeVisible();
  await expect(importButton).toBeDisabled();
  await page.getByRole('button', { name: 'Инженеры', exact: true }).click();
  await expect(page.getByRole('switch', { name: 'Отключить Smoke East Engineer' })).toBeDisabled();
  // Read only persisted request identities; the UI cannot quietly substitute recorded demo data.
  const stored = z
    .object({ snapshot: z.object({ requests: z.array(z.object({ id: z.string() })) }) })
    .parse(
      await page.evaluate((): unknown =>
        JSON.parse(sessionStorage.getItem('lct.saved-day.v1') ?? 'null'),
      ),
    );
  expect(stored.snapshot.requests.map((item) => item.id).sort()).toEqual(ids);
  await context.unroute('**/api/**');
  await expect(importButton).toBeEnabled({ timeout: 20_000 });
  await expect(page.getByRole('switch', { name: 'Отключить Smoke East Engineer' })).toBeEnabled();
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
  await expect(page.getByLabel('Email', { exact: true })).toBeVisible({ timeout: 20_000 });
  expect(await page.evaluate(() => sessionStorage.getItem('lct.saved-day.v1'))).toBeNull();
  await expect(page.getByRole('button', { name: /Smoke East Engineer/ })).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
});
