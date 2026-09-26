import { expect, it } from 'vitest';
import { tomorrowRequestRows } from './tomorrowRequests';

it('lists tomorrow requests from morning to evening and keeps the number to eight characters', () => {
  const rows = tomorrowRequestRows(
    [
      request('ce741e6d-aaaa-bbbb-cccc-dddddddddddd', '15:00', 'Подключение'),
      request('aa11bb22-aaaa-bbbb-cccc-dddddddddddd', '09:30', 'Авария'),
      request(
        'cancelled1-aaaa-bbbb-cccc-dddddddddddd',
        '10:00',
        'Сегодня',
        'cancelled',
        '2026-09-26',
      ),
      request('draft0001-aaaa-bbbb-cccc-dddddddddddd', '11:00', 'Черновик', 'draft'),
    ],
    '2026-09-26',
  );
  expect(rows.map((row) => row.number)).toEqual(['aa11bb22', 'ce741e6d']);
  expect(rows.map((row) => row.type)).toEqual(['Авария', 'Подключение']);
  expect(rows[0]?.window.startsWith('09:30')).toBe(true);
  expect(rows.every((row) => row.number.length === 8)).toBe(true);
});

function request(
  id: string,
  clock: string,
  type: string,
  lifecycle: 'submitted' | 'cancelled' | 'draft' = 'submitted',
  day = '2026-09-27',
) {
  const [hours, minutes] = clock.split(':').map(Number);
  const start = Date.parse(`${day}T${clock}:00+03:00`) / 1000;
  return {
    id,
    lifecycle,
    windowStartAt: Number.isFinite(hours) && Number.isFinite(minutes) ? start : 0,
    windowEndAt: start + 2 * 60 * 60,
    workTypeTitle: type,
  };
}
