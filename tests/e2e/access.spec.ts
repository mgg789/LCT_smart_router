import { z } from 'zod';
import { expect, signIn, test } from './fixtures';

test('dispatcher creates and revokes an integration key through the UI', async ({ page, live }) => {
  await signIn(page);
  await page.getByRole('button', { name: 'Меню пользователя', exact: true }).click();
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await page.getByRole('button', { name: 'API', exact: true }).click();
  await page.getByLabel('Название', { exact: true }).fill('Regression client');
  await page.getByRole('combobox', { name: 'Права', exact: true }).selectOption('client');
  const createdResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/v1/auth/tokens') && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Создать', exact: true }).click();
  const created = z
    .object({ id: z.string(), token: z.string() })
    .parse(await (await createdResponse).json());
  await expect(page.getByText('Токен создан — скопируйте сейчас', { exact: true })).toBeVisible();
  const headers = { Authorization: `Bearer ${created.token}` };
  expect((await live.api.get('/api/v1/auth/session', { headers })).status()).toBe(200);
  // A client-category key must never gain dispatcher access.
  expect((await live.api.get('/api/v1/dispatch/plan', { headers })).status()).toBe(403);
  await page.reload();
  await page.getByRole('button', { name: 'Меню пользователя', exact: true }).click();
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await page.getByRole('button', { name: 'API', exact: true }).click();
  await expect(page.getByText('Regression client', { exact: true })).toBeVisible();
  await expect(page.locator('code')).toHaveCount(0);
  await page.getByRole('button', { name: 'Отозвать', exact: true }).click();
  await page.getByRole('button', { name: 'Точно отозвать?', exact: true }).click();
  await expect(page.getByText('Отозван', { exact: true })).toBeVisible();
  expect((await live.api.get('/api/v1/auth/session', { headers })).status()).toBe(401);
});

test('engineer signs in by a real code on mobile and sees the assigned day', async ({
  page,
  live,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/engineer');
  await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
  if (!live.engineer.email) throw new Error('Seed engineer must have a login address');
  await page.getByLabel('Email', { exact: true }).fill(live.engineer.email);
  const codeResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/v1/auth/login-code') && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  const { devCode } = z
    .object({ devCode: z.string().regex(/^\d{6}$/) })
    .parse(await (await codeResponse).json());
  await page.getByLabel('Цифра 1 из 6', { exact: true }).fill(devCode);
  await expect(page.getByRole('heading', { name: 'Список заявок' })).toBeVisible();
  await expect(page.locator('main article')).toHaveCount(5);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await testInfo.attach('engineer-mobile-day', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Список заявок' })).toBeVisible();
  await page.getByRole('button', { name: 'Меню', exact: true }).click();
  await page.getByRole('button', { name: 'Выйти', exact: true }).click();
  await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
});
