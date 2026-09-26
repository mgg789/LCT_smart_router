import { describe, expect, it } from 'vitest';
import { COMPOSER_LINE_LIMIT, composerFieldHeight } from './composerField';

describe('composerFieldHeight', () => {
  it('allows the composer to grow to eight lines before scrolling', () => {
    expect(COMPOSER_LINE_LIMIT).toBe(8);
    expect(composerFieldHeight(24 * 8, 24)).toBe(24 * 8);
    expect(composerFieldHeight(24 * 9, 24)).toBe(24 * 8);
  });

  it('keeps short text at its measured height', () => {
    expect(composerFieldHeight(48, 24)).toBe(48);
  });

  it('caps growth at eight lines so the textarea can scroll beyond it', () => {
    expect(composerFieldHeight(240, 24)).toBe(24 * COMPOSER_LINE_LIMIT);
  });

  it('uses safe defaults for unavailable browser metrics', () => {
    expect(composerFieldHeight(Number.NaN, Number.NaN)).toBe(24);
  });
});
