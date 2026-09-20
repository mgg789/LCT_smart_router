import { describe, expect, it } from 'vitest';
import { moscowAt } from '../lib/time';
import { arrivalHeadline, engineerHeaderStamp, formatMinutesRu, formatPlanTime, formatPlanWindow } from './engineerClock';

describe('engineerClock', () => {
  it('builds the Figma header stamp in Moscow', () => {
    expect(engineerHeaderStamp(Date.UTC(2026, 8, 15, 17, 14, 0))).toBe('15 сентября, 20:14');
  });

  it('drops the leading hour zero on cards', () => {
    expect(formatPlanTime(moscowAt('2026-09-15', 9, 17))).toBe('9:17');
    expect(formatPlanTime(moscowAt('2026-09-15', 12, 20))).toBe('12:20');
    expect(formatPlanWindow(moscowAt('2026-09-15', 9, 0), moscowAt('2026-09-15', 10, 20))).toBe(
      '9:00-10:20',
    );
  });

  it('declines minutes in the list language', () => {
    expect(formatMinutesRu(60)).toBe('1 минута');
    expect(formatMinutesRu(120)).toBe('2 минуты');
    expect(formatMinutesRu(2700)).toBe('45 минут');
  });

  it('titles the request screen as time-until-arrival', () => {
    const start = moscowAt('2026-09-15', 12, 20);
    expect(arrivalHeadline(start, (start - 25 * 60) * 1000)).toBe('Через 25 минут');
    expect(arrivalHeadline(start, start * 1000)).toBe('Сейчас');
  });
});
