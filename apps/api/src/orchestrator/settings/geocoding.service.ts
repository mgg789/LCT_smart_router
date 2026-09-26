import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../common/config';
import { SysError } from '../../common/errors';
import {
  autocompleteQuery,
  type GeocodeHit,
  type GeocodeQuery,
  hitFromReverse,
  hitsFromAutocomplete,
} from './geocoding-policy';

const LOCATIONIQ_AUTOCOMPLETE = 'https://us1.locationiq.com/v1/autocomplete';
const LOCATIONIQ_REVERSE = 'https://us1.locationiq.com/v1/reverse';
const NOMINATIM_SEARCH = 'https://nominatim.openstreetmap.org/search';
const NOMINATIM_REVERSE = 'https://nominatim.openstreetmap.org/reverse';
const NOMINATIM_INTERVAL_MS = 1_100;
const CACHE_LIMIT = 200;
const FETCH_TIMEOUT_MS = 4_000;
const MIN_QUERY_LENGTH = 3;
/** Moscow metro bias: west,south,east,north. Autocomplete stays unbounded. */
const MOSCOW_VIEWBOX = '36.80,55.14,38.35,56.05';

/** Nominatim requires a contactable User-Agent and refuses the default fetch one. */
function nominatimHeaders(): Record<string, string> {
  return { 'User-Agent': 'LCT-Smart-Router/0.1 (local field routing demo)' };
}

export type { GeocodeHit, GeocodeQuery } from './geocoding-policy';
export { autocompleteQuery, hitsFromAutocomplete } from './geocoding-policy';

/**
 * LocationIQ autocomplete for the dispatcher create-request form.
 *
 * Uses `/v1/autocomplete` so a messy typed address still yields house-level hits.
 * Results are cached. Without `LOCATION_IQ_TOKEN` the same calls go to Nominatim,
 * paced to its one-request-per-second rule, so a local stand still resolves an address.
 */
@Injectable()
export class GeocodingService {
  private readonly cache = new Map<string, GeocodeHit[]>();
  private nominatimAt = 0;
  private nominatimChain: Promise<void> = Promise.resolve();

  constructor(private readonly config: AppConfigService) {}

  async search(query: GeocodeQuery): Promise<GeocodeHit[]> {
    const q = autocompleteQuery(query);
    if (q.length < MIN_QUERY_LENGTH) {
      throw new SysError('VALIDATION_FAILED', 'An address needs at least three characters');
    }
    const token = this.config.get('LOCATION_IQ_TOKEN');
    const cacheKey = createHash('sha256')
      .update(`${token ? 'liq' : 'nom'}:${q.toLowerCase()}`)
      .digest('hex');
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const hits = token ? await this.searchLocationIq(token, q) : await this.searchNominatim(q);
    this.remember(cacheKey, hits);
    return hits;
  }

  /**
   * Street address for a map click.
   * Null when the provider has no name for that point; the caller may keep the coordinates.
   */
  async reverse(lat: number, lon: number): Promise<GeocodeHit | null> {
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      lat < -90 ||
      lat > 90 ||
      lon < -180 ||
      lon > 180
    ) {
      throw new SysError('VALIDATION_FAILED', 'A map point needs a latitude and a longitude');
    }
    const token = this.config.get('LOCATION_IQ_TOKEN');
    const cacheKey = `reverse:${token ? 'liq' : 'nom'}:${lat.toFixed(5)}:${lon.toFixed(5)}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached[0] ?? null;
    }
    const hit = token
      ? await this.reverseLocationIq(token, lat, lon)
      : await this.reverseNominatim(lat, lon);
    this.remember(cacheKey, hit ? [hit] : []);
    return hit;
  }

  private async searchLocationIq(token: string, q: string): Promise<GeocodeHit[]> {
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
    return hitsFromAutocomplete(await this.request(url));
  }

  private async reverseLocationIq(
    token: string,
    lat: number,
    lon: number,
  ): Promise<GeocodeHit | null> {
    const url = new URL(LOCATIONIQ_REVERSE);
    url.searchParams.set('key', token);
    url.searchParams.set('lat', String(lat));
    url.searchParams.set('lon', String(lon));
    url.searchParams.set('format', 'json');
    url.searchParams.set('accept-language', 'ru');
    return hitFromReverse(await this.request(url));
  }

  private searchNominatim(q: string): Promise<GeocodeHit[]> {
    const url = new URL(NOMINATIM_SEARCH);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('q', q);
    url.searchParams.set('countrycodes', 'ru');
    url.searchParams.set('limit', '5');
    url.searchParams.set('accept-language', 'ru');
    return this.paced(async () =>
      hitsFromAutocomplete(await this.request(url, nominatimHeaders())),
    );
  }

  private reverseNominatim(lat: number, lon: number): Promise<GeocodeHit | null> {
    const url = new URL(NOMINATIM_REVERSE);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('lat', String(lat));
    url.searchParams.set('lon', String(lon));
    url.searchParams.set('accept-language', 'ru');
    return this.paced(async () => hitFromReverse(await this.request(url, nominatimHeaders())));
  }

  /** Nominatim asks for at most one request per second from an application. */
  private paced<T>(work: () => Promise<T>): Promise<T> {
    const run = this.nominatimChain.then(async () => {
      const wait = NOMINATIM_INTERVAL_MS - (Date.now() - this.nominatimAt);
      if (wait > 0) {
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
      this.nominatimAt = Date.now();
      return work();
    });
    this.nominatimChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async request(url: URL, headers: Record<string, string> = {}): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json', ...headers },
      });
      if (response.status === 404) {
        return [];
      }
      if (!response.ok) {
        throw new SysError('INTERNAL_ERROR', 'The geocoder refused the request', {
          details: { status: response.status },
        });
      }
      return response.json();
    } catch (error) {
      if (error instanceof SysError) {
        throw error;
      }
      throw new SysError('INTERNAL_ERROR', 'The geocoder is unreachable');
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
