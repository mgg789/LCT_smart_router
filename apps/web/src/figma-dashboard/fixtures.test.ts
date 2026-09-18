import { describe, expect, it } from 'vitest';
import { MAIN_DASHBOARD, POLICY_OPTIONS } from './fixtures';

describe('Figma MAIN fixture', () => {
  it('keeps the mockup copy for the static first-pass page', () => {
    expect(MAIN_DASHBOARD.dateLabel).toBe('15 сентября, 2026');
    expect(MAIN_DASHBOARD.request.number).toBe('Заявка № 1042');
    expect(MAIN_DASHBOARD.engineers).toHaveLength(4);
    expect(MAIN_DASHBOARD.engineers[0]?.name).toBe('Алексей Соколов');
    expect(MAIN_DASHBOARD.unassigned.reason).toBe('Нет инженера с нужным навыком');
    expect(POLICY_OPTIONS).toContain(MAIN_DASHBOARD.defaultPolicy);
    expect(POLICY_OPTIONS[2]).toBe('Бережнее к окнам');
  });
});
