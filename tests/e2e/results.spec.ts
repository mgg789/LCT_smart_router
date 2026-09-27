import { expect, signIn, test } from './fixtures';

test('day and month results show factual team analytics without closing the shift', async ({
  page,
  live,
}) => {
  expect(live.plan.assignments.length).toBeGreaterThan(0);
  await signIn(page);
  await page.getByRole('button', { name: 'Меню пользователя' }).click();
  await page.getByRole('button', { name: 'Завершить день', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Результат рабочего дня' });
  await expect(dialog.getByRole('heading', { name: 'Команда за день' })).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Передаём следующей смене' })).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: 'Сохранить результат и завершить день' }),
  ).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Месяц', exact: true }).click();
  const monthly = page.getByRole('dialog', { name: 'Итоги месяца' });
  await expect(monthly.getByRole('heading', { name: 'Команда в цифрах' })).toBeVisible();
  await expect(monthly.getByRole('heading', { name: 'Вклад инженеров' })).toBeVisible();
  await expect(monthly.getByRole('button', { name: 'Скачать PDF', exact: true })).toBeEnabled();
  const download = page.waitForEvent('download');
  await monthly.getByRole('button', { name: 'Скачать PDF', exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/^navix-\d{4}-\d{2}\.pdf$/);
  await monthly.getByRole('button', { name: 'День', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'Команда за день' })).toBeVisible();
});
