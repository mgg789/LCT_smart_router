import { expect, test } from '@playwright/test';

/**
 * The sign-in path against a live System Layer.
 *
 * It is skipped when the API is not answering, so the suite stays runnable on a
 * machine without the contour — but when the contour is up, this is the only
 * test that proves the contract holds end to end.
 *
 * The code is read off the screen: with no SMTP configured the API returns it in
 * the answer (`AUTH_DEV_EXPOSE_CODES`), and the page shows it for exactly that
 * reason.
 */
const DISPATCHER_EMAIL = process.env.E2E_DISPATCHER_EMAIL ?? 'dispatcher@example.test';

test.describe('sign-in against the live API', () => {
  test.beforeEach(async ({ request }) => {
    const live = await request.get('http://127.0.0.1:8000/health/live').catch(() => null);
    test.skip(!live?.ok(), 'System Layer is not running on 127.0.0.1:8000');
  });

  test('a dispatcher signs in with a code and lands on the day', async ({ page }) => {
    await page.goto('/login');

    await page.getByLabel('Email').fill(DISPATCHER_EMAIL);
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Новый код' }).click();

    const hint = page.getByText(/сервер вернул код/);
    await expect(hint).toBeVisible({ timeout: 15_000 });

    const code = (await hint.innerText()).match(/\d{6}/)?.[0];
    expect(code, 'the API should expose a code while SMTP is off').toBeTruthy();

    for (const [index, digit] of [...(code ?? '')].entries()) {
      await page.getByLabel(`Цифра ${index + 1}`).fill(digit);
    }
    await page.getByRole('button', { name: 'Войти' }).click();

    await expect(page).toHaveURL(/\/plan$/);
    await expect(page.getByRole('link', { name: 'План дня' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    // The pill carries a real title from `GET /dispatch/policies`, not a fallback.
    await expect(page.getByRole('button', { name: /^Политика: / })).not.toHaveText(
      /нет связи|загружаем/,
    );
  });

  test('a wrong code is refused without a session', async ({ page }) => {
    await page.goto('/login');

    await page.getByLabel('Email').fill(DISPATCHER_EMAIL);
    await page.getByRole('checkbox').check();
    for (const index of [1, 2, 3, 4, 5, 6]) {
      await page.getByLabel(`Цифра ${index}`).fill('0');
    }
    await page.getByRole('button', { name: 'Войти' }).click();

    await expect(page.getByRole('alert')).toHaveText(/Код не подошёл или истёк/);
    await expect(page).toHaveURL(/\/login$/);
  });
});
