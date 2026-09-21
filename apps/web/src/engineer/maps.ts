import type { EngineerView } from '../api/types';

/**
 * Opens turn-by-turn directions to a stop in the phone's maps app.
 *
 * Concept CE7 names Google Maps. Travel mode follows the brigade transport so a walking
 * crew is not sent a driving itinerary.
 */
export function mapsDirectionsUrl(
  lat: number,
  lon: number,
  transport: EngineerView['transportType'],
): string {
  const travelmode =
    transport === 'walk'
      ? 'walking'
      : transport === 'bike'
        ? 'bicycling'
        : transport === 'transit'
          ? 'transit'
          : 'driving';
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}&travelmode=${travelmode}`;
}
