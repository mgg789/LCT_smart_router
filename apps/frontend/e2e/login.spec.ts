import { expect, test } from '@playwright/test';

/**
 * Smoke check of the sign-in screen. It deliberately does not touch the API: the
 * full code flow needs a live System Layer and belongs to the smoke gate, not here.
 */
test('sign-in screen renders its fields', async ({ page }) => {
  await page.goto('/login');

  await expect(page.getByLabel('Email')).toBeVisible();
  await expect(page.getByLabel('Цифра 1')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Новый код' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Войти' })).toBeVisible();
});

test('an anonymous visitor is sent to sign-in', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveURL(/\/login$/);
});
