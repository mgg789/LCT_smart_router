import { randomUUID } from 'node:crypto';
import { expect, readRequestIds, signIn, test } from './fixtures';

test('tabular analysis and conversion do not mutate the working plan', async ({ live }) => {
  expect(
    (
      await live.api.post('/api/v1/dispatch/mode', {
        data: {
          operationId: randomUUID(),
          mode: 'manual',
          reason: 'E2E import and settings verification',
        },
      })
    ).ok(),
  ).toBe(true);
  const before = await readRequestIds(live.api);
  const source = {
    fileName: 'requests.tsv',
    payloadBase64: Buffer.from(
      'ID\tАдрес\tШирота\tДолгота\ncustom-1\tТестовая улица, 1\t55.75\t37.61\n',
    ).toString('base64'),
  };
  const analysisResponse = await live.api.post('/api/v1/dispatch/data/tabular/analyze', {
    data: source,
  });
  expect(analysisResponse.ok()).toBe(true);
  const analysis = await analysisResponse.json();
  expect(analysis.format).toBe('tsv');
  expect(analysis.columns.addressText).toBe(1);
  const options = {
    mode: 'append_requests',
    region: 'east',
    workDate: '2026-09-27',
    columns: analysis.columns,
    defaults: {
      duration: '30',
      windowStart: '09:00',
      windowEnd: '18:00',
      requiredSkill: 'local',
      priority: 'normal',
    },
    durationUnit: 'minutes',
    depot: { addressText: '' },
    engineers: {
      count: 1,
      transportType: 'car',
      skills: ['local'],
      shiftStart: '09:00',
      shiftEnd: '18:00',
    },
    edits: [],
  };
  const converted = await live.api.post('/api/v1/dispatch/data/tabular/convert', {
    data: { source, options },
  });
  expect(converted.ok()).toBe(true);
  const result = await converted.json();
  expect(result.issues).toEqual([]);
  expect(result.file.requests).toHaveLength(1);
  expect(result.file.requests[0].serviceDurationSec).toBe(1800);
  expect(result.file.engineers).toBeUndefined();
  expect(result.file.depot).toBeUndefined();
  expect(await readRequestIds(live.api)).toEqual(before);
});

test('table review can return without import and prepares approved missing values', async ({
  page,
  live,
}) => {
  await signIn(page);
  expect(
    (
      await live.api.post('/api/v1/dispatch/mode', {
        data: {
          operationId: randomUUID(),
          mode: 'manual',
          reason: 'E2E import and settings verification',
        },
      })
    ).ok(),
  ).toBe(true);
  const before = await readRequestIds(live.api);
  await page.getByRole('button', { name: 'Загрузить данные', exact: true }).click();
  const upload = page.getByRole('dialog', { name: 'Загрузить данные', exact: true });
  const input = upload.locator('input[type=file]').first();
  const file = {
    name: 'review.tsv',
    mimeType: 'text/tab-separated-values',
    buffer: Buffer.from('ID\tАдрес\tШирота\tДолгота\nreview-1\tТестовая улица, 1\t55.75\t37.61\n'),
  };
  await input.setInputFiles(file);
  const review = page.getByRole('dialog', { name: 'Проверка таблицы: review.tsv', exact: true });
  await expect(review).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(review).toBeVisible();
  await review.getByRole('button', { name: 'Вернуться', exact: true }).click();
  await expect(review).toBeHidden();
  expect(await readRequestIds(live.api)).toEqual(before);
  await input.setInputFiles(file);
  await expect(review).toBeVisible();
  await review.getByLabel('Режим', { exact: true }).selectOption('append_requests');
  await review.getByLabel('Регион', { exact: true }).fill('east');
  await review.getByRole('button', { name: 'Проверить заполнение', exact: true }).click();
  await expect(review).toBeHidden();
  await expect(upload.getByRole('button', { name: 'Применить', exact: true })).toBeEnabled();
  expect(await readRequestIds(live.api)).toEqual(before);
});
