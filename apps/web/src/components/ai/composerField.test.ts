import { describe, expect, it } from 'vitest';
import { COMPOSER_LINE_LIMIT, composerFieldHeight } from './composerField';

describe('composerFieldHeight', () => {
  it('keeps short text at its measured height', () => {
    expect(composerFieldHeight(48, 24)).toBe(48);
  });

  it('caps growth at five lines so the textarea can scroll beyond it', () => {
    expect(composerFieldHeight(240, 24)).toBe(24 * COMPOSER_LINE_LIMIT);
  });

  it('uses safe defaults for unavailable browser metrics', () => {
    expect(composerFieldHeight(Number.NaN, Number.NaN)).toBe(24);
  });
});
