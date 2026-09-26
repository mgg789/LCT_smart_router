import { describe, expect, it } from 'vitest';
import { formatKmPerAssigned, POLICY_PAGE_CAPTION, perAssigned } from './PolicyComparisonView';

describe('Figma policy comparison page', () => {
  it('keeps only the short identical-conditions caption', () => {
    expect(POLICY_PAGE_CAPTION).toBe('Одинаковые заявки и дорожные условия');
    expect(POLICY_PAGE_CAPTION.length).toBeLessThan(60);
  });

  it('normalizes route cost by assigned work without treating an empty plan as free', () => {
    expect(perAssigned(1064, 10)).toBe(106.4);
    expect(perAssigned(0, 0)).toBeNull();
    expect(formatKmPerAssigned(0, 0)).toBe('— (нет назначений)');
  });
});
