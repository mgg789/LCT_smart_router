import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { explicitWindow, snapAddress, visitWindows } from '../../src/orchestrator/ai/mini-ai.service';

describe('visit windows for System one', () => {
  it('keeps two clocks the text already named and offers two fallback slots', () => {
    assert.deepEqual(visitWindows(['09:30', '11:00']), ['09:30–11:00', '10:00–12:00', '14:00–16:00']);
  });

  it('widens a single clock by two hours without leaving the day', () => {
    assert.deepEqual(visitWindows(['22:15']), ['22:15–23:15', '10:00–12:00', '14:00–16:00']);
  });

  it('offers morning, midday and evening when the text has no clock', () => {
    assert.deepEqual(visitWindows([]), ['09:00–12:00', '12:00–15:00', '15:00–18:00']);
  });

  it('snaps a long chosen line down to the street it already contains', () => {
    assert.equal(snapAddress('Нужно настроить Wi-Fi в квартире, Ленина 4', ['Ленина 4']), 'Ленина 4');
    assert.equal(snapAddress('Приезжайте с 10:00 до 12:00.', ['на Тверской 7']), 'на Тверской 7');
    assert.equal(snapAddress('не указан', []), '');
  });

  it('keeps an hour range written without minutes', () => {
    assert.deepEqual(explicitWindow('свободен с 13 до 16, адрес проспект'), {
      start: '13:00',
      end: '16:00',
    });
  });
});
