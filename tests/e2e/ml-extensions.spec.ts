import { expect, readPlan, signIn, test } from './fixtures';

test('import warnings allow cancellation before a confirmed immutable upload', async ({
  page,
  live,
}) => {
  await signIn(page);
  const before = await readPlan(live.api);
  const now = Math.floor(Date.now() / 1000);
  const file = {
    schemaVersion: '1.0',
    mode: 'new_region',
    region: 'ml_test',
    sourceVersion: 'ml-e2e-v1',
    depot: { addressText: 'Тестовый офис', lat: 55.75, lon: 37.61 },
    engineers: [
      {
        externalId: 'ml-engineer-1',
        displayName: 'Инженер ML-проверки',
        skills: ['connection'],
        transportType: 'car',
        start: { lat: 55.75, lon: 37.61 },
        shiftStartAt: now,
        shiftEndAt: now + 8 * 3600,
      },
    ],
    requests: [
      {
        externalId: 'ml-e2e-1',
        addressText: 'г. Москва, Тестовая улица, д. 1',
        lat: 55.75,
        lon: 37.61,
        serviceDurationSec: 600,
        windowStartAt: now,
        windowEndAt: now + 23 * 3600,
        priority: 'normal',
        requiredSkill: 'connection',
      },
    ],
  };
  await page.getByRole('button', { name: 'Загрузить данные', exact: true }).click();
  const modal = page.getByRole('dialog', { name: 'Загрузить данные' });
  await modal
    .locator('input[type=file]')
    .first()
    .setInputFiles({
      name: 'ml.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(file)),
    });
  await modal.getByRole('button', { name: 'Применить', exact: true }).click();
  await expect(modal.getByRole('region', { name: 'Проверка данных' })).toBeVisible();
  expect((await readPlan(live.api)).revision).toBe(before.revision);
  await modal.getByRole('button', { name: 'Отменить', exact: true }).click();
  await expect(modal.getByRole('region', { name: 'Проверка данных' })).toBeHidden();
  expect((await readPlan(live.api)).revision).toBe(before.revision);
  await modal.getByRole('button', { name: 'Применить', exact: true }).click();
  await modal.getByRole('button', { name: 'Загрузить так', exact: true }).click();
  await expect(modal.getByText('Данные загружены', { exact: true })).toBeVisible();
  await expect(modal.getByText('Заявки: +1, инженеры: +1', { exact: true })).toBeVisible();
});

test('calibration shows honest missing-history status without changing the plan', async ({
  page,
  live,
}, testInfo) => {
  await signIn(page);
  const before = await readPlan(live.api);
  await page.getByRole('button', { name: 'Меню пользователя', exact: true }).click();
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  const modal = page.getByRole('dialog');
  await modal.getByRole('button', { name: 'AI', exact: true }).click();
  await expect(modal.getByText('Покрытие фактами', { exact: true })).toBeVisible();
  const weather = modal.getByRole('region', { name: 'Погодная калибровка' });
  await expect(weather).toBeVisible();
  await expect(weather.getByText('Недостаточно истории', { exact: true })).toBeVisible();
  await expect(weather).toContainText('Покрытие данными не является оценкой точности');
  expect((await readPlan(live.api)).revision).toBe(before.revision);
  await testInfo.attach('calibration-status', {
    body: await modal.screenshot(),
    contentType: 'image/png',
  });
});
