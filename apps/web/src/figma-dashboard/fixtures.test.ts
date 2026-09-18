import { describe, expect, it } from 'vitest';
import {
  MAIN_DASHBOARD,
  MAIN_REQUEST_COUNT,
  POLICY_OPTIONS,
  filterEngineers,
  formatNotificationCount,
  requestCountLabel,
} from './fixtures';

describe('Figma MAIN fixture', () => {
  it('keeps a varied demo roster for search, routes and the request panel', () => {
    expect(MAIN_DASHBOARD.dateLabel).toBe('15 сентября, 2026');
    expect(MAIN_DASHBOARD.engineers.length).toBeGreaterThanOrEqual(6);
    expect(MAIN_DASHBOARD.engineers[0]?.request.number).toBe('Заявка № 1042');
    expect(MAIN_DASHBOARD.engineers.some((item) => item.stops.length === 1)).toBe(true);
    expect(MAIN_DASHBOARD.engineers.some((item) => item.stops.length >= 5)).toBe(true);
    expect(POLICY_OPTIONS).toContain(MAIN_DASHBOARD.defaultPolicy);
  });

  it('formats notification badges and request counts', () => {
    expect(formatNotificationCount(1)).toBe('1');
    expect(formatNotificationCount(12)).toBe('12');
    expect(formatNotificationCount(99)).toBe('99');
    expect(formatNotificationCount(100)).toBe('99+');
    expect(requestCountLabel(MAIN_REQUEST_COUNT)).toMatch(/заявк/);
  });

  it('filters engineers by a case-insensitive name fragment', () => {
    const found = filterEngineers(MAIN_DASHBOARD.engineers, 'волк');
    expect(found).toHaveLength(1);
    expect(found[0]?.id).toBe('volkova');
    expect(filterEngineers(MAIN_DASHBOARD.engineers, '')).toHaveLength(MAIN_DASHBOARD.engineers.length);
  });
});
