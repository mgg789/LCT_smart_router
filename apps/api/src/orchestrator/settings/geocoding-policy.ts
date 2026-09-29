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

/** One reverse-geocode object, or null when the payload has no point. */
export function hitFromReverse(body: unknown): GeocodeHit | null {
  const [hit] = hitsFromAutocomplete([body]);
  return hit ?? null;
}

export type AddressMatchLevel = 'house' | 'street' | 'approximate';

export interface PlacedAddress {
  readonly address: string;
  readonly lat: number;
  readonly lon: number;
  readonly level: AddressMatchLevel;
}

const STREET_TYPES: ReadonlyArray<readonly [string, string]> = [
  ['б-р', 'бульвар'],
  ['пр-кт', 'проспект'],
  ['пр-т', 'проспект'],
  ['пр-д', 'проезд'],
  ['ул', 'улица'],
  ['ш', 'шоссе'],
  ['наб', 'набережная'],
  ['пер', 'переулок'],
  ['пл', 'площадь'],
];

const HOUSE_KINDS = new Set(['house', 'building', 'office', 'apartments', 'construction']);
const STREET_KINDS = new Set([
  'road',
  'pedestrian',
  'living_street',
  'footway',
  'service',
  'path',
  'highway',
]);

/** Moscow and Moscow Oblast box used by the dataset geocoder: west,north,east,south. */
export const MOSCOW_OBLAST_VIEWBOX = '35.8,56.3,39.8,54.2';

/** Every spelling of one address. The caller tries all of them and keeps the best hit. */
export function addressQueryLadder(address: string): string[] {
  const base = address.replace(/\s+/g, ' ').trim();
  let expanded = base;
  for (const [abbrev, full] of STREET_TYPES) {
    expanded = expanded.replace(
      new RegExp(`(?<![\\p{L}\\p{N}])${abbrev}\\.\\s*`, 'giu'),
      `${full} `,
    );
  }
  expanded = expanded.replace(/\s+/g, ' ').trim();
  const compacted = expanded
    .replace(/(?<![\p{L}\p{N}])д\.\s*(\d+[А-Яа-я]?)\s*к\s*(\d+)/giu, '$1к$2')
    .replace(/(?<![\p{L}\p{N}])д\.\s*(\d+[А-Яа-я]?)\s*стр\.\s*(\d+)/giu, '$1с$2')
    .replace(/(?<![\p{L}\p{N}])д\.\s*(\d+[А-Яа-я]?)/giu, '$1');
  const withoutHousing = compacted
    .replace(/[,\s]+к\s*\d+\s*$/i, '')
    .replace(/[,\s]+стр\.\s*\d+\s*$/i, '')
    .trim();
  const withoutType = withoutHousing
    .replace(
      /(?<![\p{L}\p{N}])(бульвар|проспект|проезд|улица|шоссе|набережная|переулок|площадь)\s+/giu,
      '',
    )
    .replace(/\s+/g, ' ')
    .trim();
  const streetOnly = withoutHousing
    .replace(/,\s*\d+\S*\s*$/u, '')
    .replace(/,\s*д\.\s*\S+\s*$/i, '')
    .trim();
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const variant of [base, expanded, compacted, withoutHousing, withoutType, streetOnly]) {
    const next = variant.replace(/\s+/g, ' ').trim().replace(/,$/, '');
    if (next.length < 3 || seen.has(next)) continue;
    seen.add(next);
    ordered.push(next);
  }
  return ordered;
}

/** House beats street. Anything coarser is not a located address. */
export function matchLevelOf(candidate: {
  class?: unknown;
  type?: unknown;
}): AddressMatchLevel | null {
  const kinds = new Set(
    [candidate.class, candidate.type]
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.toLowerCase()),
  );
  if ([...kinds].some((kind) => HOUSE_KINDS.has(kind))) return 'house';
  if ([...kinds].some((kind) => STREET_KINDS.has(kind))) return 'street';
  return null;
}

/**
 * Deterministic point inside the Moscow and Moscow Oblast box.
 * Kept for tests. Live geocoding does not invent a point for a miss.
 */
export function approximateAddress(address: string): { lat: number; lon: number } {
  let hash = 2166136261;
  for (const char of address) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  const unit = (shift: number) => ((hash >>> shift) & 0xffff) / 0xffff;
  return {
    lon: 35.8 + unit(0) * (39.8 - 35.8),
    lat: 54.2 + unit(16) * (56.3 - 54.2),
  };
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
