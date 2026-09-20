import { describe, expect, it } from 'vitest';
import {
  ENGINEER_NAME_MAX,
  filterEngineers,
  formatNotificationCount,
  isCompletedStop,
  MAIN_DASHBOARD,
  MAIN_REQUEST_COUNT,
  POLICY_OPTIONS,
  requestCountLabel,
  routeStopStatusLabel,
  truncateEnd,
  visibleNotifications,
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
    expect(MAIN_DASHBOARD.notifications).toHaveLength(3);
    const first = MAIN_DASHBOARD.notifications[0];
    if (!first) throw new Error('Fixture must include a notification');
    expect(
      visibleNotifications([...MAIN_DASHBOARD.notifications, { ...first, id: 'extra' }]),
    ).toHaveLength(3);
  });

  it('renders completed route stops as a green uppercase label', () => {
    expect(isCompletedStop('выполнено')).toBe(true);
    expect(routeStopStatusLabel('выполнено')).toBe('ВЫПОЛНЕНО');
    expect(isCompletedStop('сейчас - визит 45 мин')).toBe(false);
    expect(routeStopStatusLabel('в пути 18 мин')).toBe('в пути 18 мин');
  });

  it('cuts long display names at the end so they cannot cover the km suffix', () => {
    expect(truncateEnd('Алексей Соколов')).toBe('Алексей Соколов');
    expect(truncateEnd('Бригада Мельниково')).toBe('Бригада Мельнико…');
    expect(truncateEnd('Бригада Восточная 7')).toBe('Бригада Восточна…');
    expect(truncateEnd('Бригада Восточная 7').length).toBe(ENGINEER_NAME_MAX + 1);
    expect(truncateEnd('  Ольга Белова  ')).toBe('Ольга Белова');
  });

  it('filters engineers by a case-insensitive name fragment', () => {
    const found = filterEngineers(MAIN_DASHBOARD.engineers, 'волк');
    expect(found).toHaveLength(1);
    expect(found[0]?.id).toBe('volkova');
    expect(filterEngineers(MAIN_DASHBOARD.engineers, '')).toHaveLength(
      MAIN_DASHBOARD.engineers.length,
    );
  });
});
