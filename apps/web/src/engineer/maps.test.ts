import { describe, expect, it } from 'vitest';
import { mapsDirectionsUrl } from './maps';

describe('engineer maps deep link', () => {
  it('opens Google Maps directions with the brigade travel mode', () => {
    expect(mapsDirectionsUrl(55.75, 37.62, 'car')).toBe(
      'https://www.google.com/maps/dir/?api=1&destination=55.75,37.62&travelmode=driving',
    );
    expect(mapsDirectionsUrl(55.75, 37.62, 'walk')).toContain('travelmode=walking');
    expect(mapsDirectionsUrl(55.75, 37.62, 'bike')).toContain('travelmode=bicycling');
    expect(mapsDirectionsUrl(55.75, 37.62, 'transit')).toContain('travelmode=transit');
  });
});
