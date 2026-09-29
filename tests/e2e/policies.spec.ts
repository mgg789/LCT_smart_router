import { randomUUID } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import { z } from 'zod';
import { expect, readPlan, signIn, test } from './fixtures';

/** Wait for the workday-start publication, not an arbitrary sleep or revision guess. */
async function waitForAppliedTask(api: APIRequestContext) {
  await expect
    .poll(
      async () => {
        const response = await api.get('/api/v1/dispatch/plan');
        expect(response.ok()).toBe(true);
        return z.object({ routerPhase: z.string() }).parse(await response.json()).routerPhase;
      },
      { timeout: 30_000 },
    )
    .toBe('ready');
}

test('plan metrics lead to a real FIFO comparison without applying another policy', async ({
  page,
  live,
}) => {
  await signIn(page);
  // Overlapping work creates a shortage while retaining an eligible reserve template.
  // Removing the only engineer makes covering infeasible too (there is no template).
  const now = Math.floor(Date.now() / 1000);
  for (let index = 0; index < 4; index += 1) {
    const created = await live.api.post('/api/v1/dispatch/requests', {
      data: {
        operationId: randomUUID(),
        contactName: `Reserve comparison ${index + 1}`,
        addressText: 'Город Москва, пр-кт.Волгоградский, д. 128 к 5',
        lat: 55.7062794,
        lon: 37.7738951,
        workType: 'outage',
        windowStartAt: now + 3600,
        windowEndAt: now + 7200,
      },
    });
    expect(created.status()).toBe(201);
  }
  await expect
    .poll(async () => (await readPlan(live.api)).assignments.length, { timeout: 30_000 })
    .toBe(live.plan.assignments.length + 4);
  await waitForAppliedTask(live.api);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Метрики плана', exact: true })).toBeVisible();
  const before = await readPlan(live.api);
  expect(before.assignments.filter((item) => item.status === 'unassigned').length).toBeGreaterThan(
    0,
  );
  await page.getByRole('button', { name: 'Метрики плана', exact: true }).click();
  await page.getByRole('button', { name: 'Сравнить политики', exact: true }).click();
  const calculate = page.getByRole('button', { name: /^(Сравнить|Пересчитать)$/ });
  await expect(calculate).toBeVisible();
  await expect(calculate).toBeEnabled({ timeout: 30_000 });
  await calculate.click();
  const coverage = page.getByRole('region', { name: 'Сколько заявок удаётся назначить' });
  await expect(coverage).toBeVisible({ timeout: 30_000 });
  await expect(
    coverage.getByRole('listitem').filter({ hasText: 'FIFO · базовая из ТЗ' }),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: 'Дорога на назначение' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Доля опозданий' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Задействованные инженеры' })).toBeVisible();
  const reserve = page.getByRole('checkbox', { name: /Показать «Полное покрытие»/ });
  await reserve.scrollIntoViewIfNeeded();
  const reserveLabel = reserve.locator('..');
  const beforeToggle = await reserveLabel.boundingBox();
  if (!beforeToggle) throw new Error('Reserve toggle has no layout box');
  await reserveLabel.click();
  await expect(reserve).toBeChecked();
  await expect
    .poll(async () =>
      Math.abs(
        ((await reserveLabel.boundingBox())?.y ?? Number.POSITIVE_INFINITY) - beforeToggle.y,
      ),
    )
    .toBeLessThan(1);
  await reserveLabel.click();
  await expect(reserve).not.toBeChecked();
  await expect
    .poll(async () =>
      Math.abs(
        ((await reserveLabel.boundingBox())?.y ?? Number.POSITIVE_INFINITY) - beforeToggle.y,
      ),
    )
    .toBeLessThan(1);
  await page
    .getByRole('group', { name: 'Вид сравнения' })
    .getByRole('button', { name: 'Таблица', exact: true })
    .click();
  await expect(page.getByText('Пробег на заявку', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole('table')).toBeVisible();
  // Comparing candidates must not move the applied-plan pointer.
  expect((await readPlan(live.api)).revision).toBe(before.revision);
});

test('previous routes survive reload and restore through a new server revision', async ({
  page,
  live,
}) => {
  await signIn(page);
  await waitForAppliedTask(live.api);
  const before = await readPlan(live.api);
  const response = await live.api.post('/api/v1/dispatch/policy', {
    data: { operationId: randomUUID(), policyId: 'eco' },
  });
  expect(response.ok()).toBe(true);
  await expect
    .poll(async () => (await readPlan(live.api)).revision)
    .toBeGreaterThan(before.revision);
  await waitForAppliedTask(live.api);
  const historySchema = z.object({
    current: z.object({ revision: z.number(), routes: z.array(z.unknown()) }),
    previous: z.object({ revision: z.number(), routes: z.array(z.unknown()) }),
    eligibility: z.object({ eligible: z.boolean(), reason: z.string().nullable() }),
  });
  const historyResponse = await live.api.get('/api/v1/dispatch/plan/previous');
  expect(historyResponse.ok()).toBe(true);
  const history = historySchema.parse(await historyResponse.json());
  expect(history.eligibility, 'unchanged task with another policy allows exact undo').toEqual({
    eligible: true,
    reason: null,
  });
  await page.reload();
  await page.getByRole('button', { name: 'Политики', exact: true }).click();
  await page.getByRole('button', { name: 'Меню пользователя', exact: true }).click();
  await page.getByRole('button', { name: 'Прошлый план', exact: true }).click();
  const controls = page.getByRole('dialog', { name: 'Выбор плана' });
  await expect(
    page.getByRole('region', { name: 'Карта маршрутов', includeHidden: true }),
  ).toBeVisible();
  const mapRegion = page.getByRole('region', { name: 'Карта маршрутов', includeHidden: true });
  const veil = page.locator('[data-plan-history-veil]');
  await expect(veil).not.toHaveClass(/backdrop-blur/);
  const capsuleBox = await controls.boundingBox();
  const mapBox = await mapRegion.boundingBox();
  const confirmBox = await controls
    .getByRole('button', { name: 'Выбрать этот', exact: true })
    .boundingBox();
  if (!capsuleBox || !mapBox || !confirmBox) {
    throw new Error('Plan history chooser or map bounds were not rendered');
  }
  const mapCenter = mapBox.x + mapBox.width / 2;
  const capsuleCenter = capsuleBox.x + capsuleBox.width / 2;
  const confirmCenter = confirmBox.x + confirmBox.width / 2;
  expect(Math.abs(capsuleCenter - mapCenter)).toBeLessThanOrEqual(2);
  expect(Math.abs(confirmCenter - capsuleCenter)).toBeLessThanOrEqual(2);
  const previous = controls.getByRole('button', {
    name: `До · ${history.previous.revision}`,
    exact: true,
  });
  await previous.click();
  await expect(previous).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(controls).toBeVisible();
  for (let index = 0; index < 5; index += 1) {
    await page.keyboard.press('Tab');
    expect(await controls.evaluate((element) => element.contains(document.activeElement))).toBe(
      true,
    );
  }
  await controls.getByRole('button', { name: 'Выбрать этот', exact: true }).click();
  await expect.poll(async () => (await readPlan(live.api)).origin).toBe('restore');
  const restored = await readPlan(live.api);
  expect(restored.revision).toBeGreaterThan(history.current.revision);
  await waitForAppliedTask(live.api);
  const restoredHistory = await live.api.get('/api/v1/dispatch/plan/previous');
  expect(restoredHistory.ok()).toBe(true);
  // Compare durable routes; /plan may enrich their display geometry asynchronously.
  expect(historySchema.parse(await restoredHistory.json()).current.routes).toEqual(
    history.previous.routes,
  );
});

test('ordinary-replanning switch persists without changing the working plan', async ({
  page,
  live,
}) => {
  await signIn(page);
  await waitForAppliedTask(live.api);
  const before = await readPlan(live.api);
  const open = async () => {
    await page.getByRole('button', { name: /^Политика:/ }).click();
    // A hover during expansion scrolls the clipped panel and loses its target as it grows.
    await expect(
      page.getByRole('button', { name: 'Ручное управление', exact: true }),
    ).toBeInViewport({
      ratio: 1,
    });
  };
  await open();
  const toggle = page.getByRole('button', { name: /^Перестройка по обычным/ });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  for (const label of [
    'Рассчитать обеды',
    'Прогнозировать пробки',
    'Маршруты с метро',
    'Передача оборудования',
    'Строгое время',
    'Перестройка по обычным',
  ]) {
    const control = page.getByRole('button', { name: new RegExp(`^${label}`) });
    await control.hover();
    await expect(control.getByRole('tooltip')).toBeVisible();
    await page.mouse.move(0, 0);
    await expect(control.getByRole('tooltip')).not.toBeVisible();
  }
  await toggle.focus();
  await expect(toggle.getByRole('tooltip')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(toggle.getByRole('tooltip')).not.toBeVisible();
  // Escape closes the panel as well as its hint; reopen before the next action.
  await open();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  expect((await readPlan(live.api)).revision).toBe(before.revision);
  await page.reload();
  await open();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  expect((await readPlan(live.api)).revision).toBe(before.revision);
});
