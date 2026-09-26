import assert from 'node:assert/strict';
import test from 'node:test';
import { decisionState, moscowClock } from '../../src/orchestrator/alerts/alert-decision-context';

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

test('moscow clock uses the plus-three offset', () => {
  assert.equal(moscowClock(Date.parse('2026-09-26T07:30:00Z') / 1000), '10:30');
});
