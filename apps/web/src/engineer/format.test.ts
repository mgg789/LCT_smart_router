import { describe, expect, it } from 'vitest';
import { formatCountdown, formatWindowCountdown } from './format';

describe('engineer window countdown', () => {
  it('names time left until the window opens, then until it closes', () => {
    expect(formatCountdown(100, 100)).toBe('время вышло');
    expect(formatCountdown(100, 100 + 90 * 60)).toBe('1 ч 30 мин');
    expect(formatWindowCountdown(100, 200, 400)).toBe('до окна 1 мин');
    expect(formatWindowCountdown(250, 200, 400)).toBe('до конца окна 2 мин');
    expect(formatWindowCountdown(400, 200, 400)).toBe('окно закрыто');
  });
});
