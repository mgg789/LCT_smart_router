import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../common/config';
import { SysError } from '../../common/errors';

const LOCATIONIQ_AUTOCOMPLETE = 'https://us1.locationiq.com/v1/autocomplete';
const CACHE_LIMIT = 200;
const FETCH_TIMEOUT_MS = 4_000;
const MIN_QUERY_LENGTH = 3;
/** Moscow metro bias: west,south,east,north. Autocomplete stays unbounded. */
const MOSCOW_VIEWBOX = '36.80,55.14,38.35,56.05';

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

/**
 * LocationIQ autocomplete for the dispatcher create-request form.
 *
 * Uses `/v1/autocomplete` so a messy typed address still yields house-level hits.
 * Results are cached; a missing token is a configuration error, not a guessed point.
 */
@Injectable()
export class GeocodingService {
  private readonly cache = new Map<string, GeocodeHit[]>();

  constructor(private readonly config: AppConfigService) {}

  async search(query: GeocodeQuery): Promise<GeocodeHit[]> {
    const token = this.config.get('LOCATION_IQ_TOKEN');
    if (!token) {
      throw SysError.notConfigured('LocationIQ');
    }
    const q = autocompleteQuery(query);
    if (q.length < MIN_QUERY_LENGTH) {
      throw new SysError('VALIDATION_FAILED', 'An address needs at least three characters');
    }
    const cacheKey = createHash('sha256').update(q.toLowerCase()).digest('hex');
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const url = new URL(LOCATIONIQ_AUTOCOMPLETE);
    url.searchParams.set('key', token);
    url.searchParams.set('q', q);
    url.searchParams.set('countrycodes', 'ru');
    url.searchParams.set('limit', '8');
    url.searchParams.set('accept-language', 'ru');
    url.searchParams.set('normalizeaddress', '1');
    url.searchParams.set('normalizecity', '1');
    url.searchParams.set('viewbox', MOSCOW_VIEWBOX);
    url.searchParams.set('bounded', '0');

    const hits = await this.request(url);
    this.remember(cacheKey, hits);
    return hits;
  }

  private async request(url: URL): Promise<GeocodeHit[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
      if (response.status === 404) {
        return [];
      }
      if (!response.ok) {
        throw new SysError('INTERNAL_ERROR', 'LocationIQ refused the geocode request', {
          details: { status: response.status },
        });
      }
      return hitsFromAutocomplete(await response.json());
    } catch (error) {
      if (error instanceof SysError) {
        throw error;
      }
      throw new SysError('INTERNAL_ERROR', 'LocationIQ is unreachable');
    } finally {
      clearTimeout(timer);
    }
  }

  private remember(key: string, hits: GeocodeHit[]): void {
    this.cache.set(key, hits);
    if (this.cache.size <= CACHE_LIMIT) {
      return;
    }
    const first = this.cache.keys().next().value;
    if (typeof first === 'string') {
      this.cache.delete(first);
    }
  }
}
