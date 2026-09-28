import { describe, expect, it } from 'vitest';
import { mapNetworkAllowed, needsStartupFallback } from './mapAvailability';

describe('basemap startup fallback', () => {
  it('allows a slow initial load instead of the former six-second cutoff', () => {
    expect(needsStartupFallback(false, 6_000)).toBe(false);
    expect(needsStartupFallback(false, 15_000)).toBe(true);
  });
  it('does not replace a rendered map after subsequent tile errors', () => {
    expect(needsStartupFallback(true, 60_000)).toBe(false);
  });
});

describe('launcher offline flag', () => {
  it('keeps maps local even when the browser reports online', () => {
    expect(mapNetworkAllowed(true, true)).toBe(false);
    expect(mapNetworkAllowed(false, true)).toBe(true);
  });
});
