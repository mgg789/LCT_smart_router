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
  await waitForAppliedTask(live.api);
  const before = await readPlan(live.api);
  await page.getByRole('button', { name: 'Метрики плана', exact: true }).click();
  await page.getByRole('button', { name: 'Сравнить политики', exact: true }).click();
  const calculate = page.getByRole('button', { name: /^(Сравнить|Пересчитать)$/ });
  await expect(calculate).toBeVisible();
  await calculate.click();
  const coverage = page.getByRole('region', { name: 'Сколько заявок удаётся назначить' });
  await expect(coverage).toBeVisible({ timeout: 30_000 });
  await expect(coverage.getByRole('listitem').filter({ hasText: 'FIFO · базовое' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Дорога на назначение' })).toBeVisible();
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
  const controls = page.getByRole('region', { name: 'Сравнение маршрутов до и после' });
  const previous = controls.getByRole('button', {
    name: `До · ${history.previous.revision}`,
    exact: true,
  });
  await previous.click();
  await expect(previous).toHaveAttribute('aria-pressed', 'true');
  await controls.getByRole('button', { name: 'Вернуть прежний план', exact: true }).click();
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
