import { describe, expect, it } from 'vitest';
import { needsStartupFallback } from './mapAvailability';

describe('basemap startup fallback', () => {
  it('allows a slow initial load instead of the former six-second cutoff', () => {
    expect(needsStartupFallback(false, 6_000)).toBe(false);
    expect(needsStartupFallback(false, 15_000)).toBe(true);
  });
  it('does not replace a rendered map after subsequent tile errors', () => {
    expect(needsStartupFallback(true, 60_000)).toBe(false);
  });
});
