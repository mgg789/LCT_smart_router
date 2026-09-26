import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decisionState,
  moscowClock,
  tomorrowCrewLine,
} from '../../src/orchestrator/alerts/alert-decision-context';

test('decision cards name the price of a last-resort action', () => {
  const text = decisionState({
    code: 'time_risk',
    reasons: ['визит не успевает в окно'],
    facts: 'окно клиента 10:00–12:00, навык подключение, регион восточный',
    windows: ['1. Иванов 11:00–12:00'],
    engineers: ['Петров: вне линии, заявок 0'],
    actions: ['reschedule', 'remove_shift', 'move_window'],
  });
  assert.match(text, /reschedule — крайний/);
  assert.match(text, /Клиент ждёт ещё сутки/);
  assert.match(text, /remove_shift — крайний/);
  assert.match(text, /без вопроса инженеру/);
  assert.match(text, /окно клиента 10:00–12:00/);
  assert.match(text, /1\. Иванов 11:00–12:00/);
});

test('tomorrow window states the crew that must be on shift at that hour', () => {
  const start = Date.parse('2026-09-26T07:00:00Z') / 1000;
  const text = tomorrowCrewLine({
    windowStartAt: start,
    windowEndAt: start + 2 * 60 * 60,
    others: [
      {
        id: 'ce741e6d-1111-1111-1111-111111111111',
        windowStartAt: start + 86_400,
        windowEndAt: start + 86_400 + 2 * 60 * 60,
      },
      {
        id: 'aa22bb33-1111-1111-1111-111111111111',
        windowStartAt: start + 86_400 + 6 * 60 * 60,
        windowEndAt: start + 86_400 + 8 * 60 * 60,
      },
    ],
  });
  assert.match(text, /уже 1 заявка/);
  assert.match(text, /ce741e6d/);
  assert.doesNotMatch(text, /aa22bb33/);
  assert.match(text, /1 инженер должен выйти на смену, чтобы одновременно решать заявку/);
  assert.match(text, /одновременно будут 2 заявки: 2 инженера должны выйти на смену/);
});

test('moscow clock uses the plus-three offset', () => {
  assert.equal(moscowClock(Date.parse('2026-09-26T07:30:00Z') / 1000), '10:30');
});
