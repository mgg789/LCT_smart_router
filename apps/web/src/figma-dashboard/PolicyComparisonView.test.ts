import { describe, expect, it } from 'vitest';
import { POLICY_PAGE_CAPTION } from './PolicyComparisonView';

describe('Figma policy comparison page', () => {
  it('keeps only the short identical-conditions caption', () => {
    expect(POLICY_PAGE_CAPTION).toBe('Одинаковые заявки и дорожные условия');
    expect(POLICY_PAGE_CAPTION.length).toBeLessThan(60);
  });
});
