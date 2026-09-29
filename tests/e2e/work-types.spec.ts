import { z } from 'zod';
import { expect, signIn, test } from './fixtures';

test('dispatcher and anonymous client share grouped work types and a red emergency action', async ({
  page,
  live,
}, testInfo) => {
  expect(live.plan.assignments.length).toBeGreaterThan(0);
  const catalogue = await live.api.get('/api/v1/client/work-types');
  expect(catalogue.ok()).toBe(true);
  const { workTypes } = z
    .object({ workTypes: z.array(z.object({ code: z.string(), serviceDurationSec: z.number() })) })
    .parse(await catalogue.json());
  expect(workTypes.find((row) => row.code === 'outage')?.serviceDurationSec).toBe(100 * 60);
  await signIn(page);
  await page.getByRole('button', { name: 'Добавить', exact: true }).click();
  const dispatcherPicker = page.getByRole('combobox', { name: 'Тип заявки', exact: true });
  await expect(dispatcherPicker.locator('option')).toHaveCount(16);
  const dispatcherTypes = await dispatcherPicker
    .locator('option')
    .evaluateAll((options) =>
      options.map((item) => ({ code: (item as HTMLOptionElement).value, title: item.textContent })),
    );
  await page.getByRole('button', { name: 'Авария', exact: true }).click();
  await expect(dispatcherPicker).toHaveValue('outage');
  await expect(page.getByRole('button', { name: 'Авария', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByLabel('Начало окна')).toBeDisabled();
  await expect(page.getByText('Направим первую свободную бригаду')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('dispatcher-emergency.png'), fullPage: true });
  await page.goto('/client');
  await expect(page.getByRole('tab', { name: 'Форма', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const clientPicker = page.getByRole('combobox', { name: 'Тип заявки', exact: true });
  await expect(clientPicker).toHaveValue('');
  await expect(clientPicker.locator('option[value=""]')).toHaveCount(1);
  // The client requires an explicit choice; its placeholder is not a work type.
  const clientWorkTypes = clientPicker.locator('option:not([value=""])');
  await expect(clientWorkTypes).toHaveCount(16);
  expect(
    await clientWorkTypes.evaluateAll((options) =>
      options.map((item) => ({
        code: (item as HTMLOptionElement).value,
        title: item.textContent,
      })),
    ),
  ).toEqual(dispatcherTypes);
  await expect(page.getByRole('button', { name: 'Авария', exact: true })).toHaveCount(0);
  await clientPicker.selectOption('outage');
  await expect(clientPicker).toHaveValue('outage');
  await expect(page.getByText('Направим первую свободную бригаду')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('client-emergency.png'), fullPage: true });
  await clientPicker.selectOption('no_link');

  await expect(page.getByText('Направим первую свободную бригаду')).not.toBeVisible();
});
