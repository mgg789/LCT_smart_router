import { z } from 'zod';
import { expect, signIn, test } from './fixtures';

const stateSchema = z.object({
  mode: z.enum(['auto', 'manual']),
  modeVersion: z.number(),
  appliedResult: z.object({ inputHash: z.string() }).nullable(),
  plan: z.object({
    revision: z.number(),
    origin: z.enum(['auto', 'manual']),
    routes: z.array(
      z.object({
        engineerId: z.string(),
        stops: z.array(z.object({ requestId: z.string().nullable(), kind: z.string() })),
      }),
    ),
  }),
});

test('MANUAL requires a reason, persists reordered work and explicitly returns AUTO', async ({
  page,
  live,
}, info) => {
  const read = async () =>
    stateSchema.parse(await (await live.api.get('/api/v1/dispatch/plan')).json());
  await signIn(page);
  await expect
    .poll(
      async () => {
        const snapshot = z
          .object({ inputHash: z.string() })
          .parse(await (await live.api.get('/api/v1/dispatch/debug/snapshot')).json());
        return (await read()).appliedResult?.inputHash === snapshot.inputHash;
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  await page.reload();
  const open = async () => {
    await page.getByRole('button', { name: /^Политика:/ }).click();
    await page.getByRole('button', { name: 'Ручное управление', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
  };
  await open();
  await expect(page.getByRole('button', { name: 'Включить MANUAL', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Отмена', exact: true }).click();
  expect((await read()).mode).toBe('auto');
  await open();
  await page.getByLabel('Причина перехода').fill('E2E: customer agreed to a new visit order');
  await page.getByRole('button', { name: 'Включить MANUAL', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Ручное управление', exact: true })).toBeVisible();
  const before = await read();
  expect(before.mode).toBe('manual');
  const route = before.plan.routes.find((item) => item.engineerId === live.engineer.id);
  expect(route).toBeTruthy();
  const order = route?.stops.flatMap((stop) => (stop.requestId ? [stop.requestId] : [])) ?? [];
  expect(order.length).toBeGreaterThan(1);
  const first = order[0];
  const second = order[1];
  if (!first || !second) throw new Error('Two editable jobs are required');
  await page.getByLabel('Инженер', { exact: true }).selectOption(live.engineer.id);
  const queueItems = page
    .getByRole('list', { name: 'Очередь неначатых заявок' })
    .getByRole('listitem');
  await queueItems.nth(0).dragTo(queueItems.nth(1));
  await expect(page.getByTestId('manual-preview')).toBeVisible();
  await page.getByRole('button', { name: 'Сохранить ручное изменение', exact: true }).click();
  await expect(page.getByTestId('manual-preview')).toBeHidden();
  const after = await read();
  expect(after.plan.revision).toBeGreaterThan(before.plan.revision);
  expect(
    after.plan.routes
      .find((item) => item.engineerId === live.engineer.id)
      ?.stops.flatMap((stop) => (stop.requestId ? [stop.requestId] : [])),
  ).toEqual([second, first, ...order.slice(2)]);
  // Repeated edits cross the polling interval; a coalesced read must return the
  // current snapshot to the editor instead of a false "plan unavailable" outcome.
  for (let repeat = 0; repeat < 2; repeat += 1) {
    await page
      .getByRole('button', { name: /^Опустить / })
      .first()
      .click();
    await page.getByRole('button', { name: 'Сохранить ручное изменение', exact: true }).click();
    await expect(page.getByTestId('manual-preview')).toBeHidden();
    await expect(page.getByRole('dialog').getByRole('alert')).toHaveCount(0);
  }
  const saved = await read();
  await page.reload();
  await expect(
    page.getByText('Ручной порядок. Линии соединяют точки;', { exact: false }),
  ).toBeVisible();
  expect((await read()).plan.revision).toBe(saved.plan.revision);
  await page.getByRole('button', { name: 'MANUAL · Управление планом', exact: true }).click();
  await page.getByText(/^Журнал ручного управления/).click();
  await expect(
    page.getByText('E2E: customer agreed to a new visit order', { exact: true }),
  ).toBeVisible();
  await info.attach('manual-plan-and-audit', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
  await page.getByRole('button', { name: 'Вернуть AUTO…', exact: true }).click();
  expect((await read()).mode).toBe('manual');
  await page.getByRole('button', { name: 'Подтвердить AUTO', exact: true }).click();
  await expect.poll(async () => (await read()).plan.origin, { timeout: 60_000 }).toBe('auto');
  expect((await read()).mode).toBe('auto');
});
