export interface GeocodeHit {
  readonly displayName: string;
  readonly lat: number;
  readonly lon: number;
}

export interface GeocodeQuery {
  readonly q?: string;
  readonly city?: string;
  readonly street?: string;
}

/**
 * Builds the free-form LocationIQ autocomplete query.
 *
 * Autocomplete wants a single `q` and tolerates missing commas and mixed order.
 * Explicit city/street are joined only when `q` is empty.
 */
export function autocompleteQuery(input: GeocodeQuery): string {
  const free = input.q?.trim() ?? '';
  if (free) {
    return free;
  }
  return [input.street?.trim(), input.city?.trim()].filter((part) => part).join(', ');
}

/** Maps a LocationIQ autocomplete payload into dispatcher hits. */
export function hitsFromAutocomplete(body: unknown): GeocodeHit[] {
  if (!Array.isArray(body)) {
    return [];
  }
  return body.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as {
      lat?: unknown;
      lon?: unknown;
      display_name?: unknown;
      display_place?: unknown;
      display_address?: unknown;
    };
    const lat = Number(row.lat);
    const lon = Number(row.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
    const displayName =
      typeof row.display_name === 'string' && row.display_name.trim()
        ? row.display_name
        : [row.display_place, row.display_address]
            .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
            .join(', ') || `${lat}, ${lon}`;
    return [{ displayName, lat, lon }];
  });
}
