import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../common/config';
import { SysError } from '../../common/errors';

const LOCATIONIQ_STRUCTURED = 'https://us1.locationiq.com/v1/search/structured';
const CACHE_LIMIT = 200;
const FETCH_TIMEOUT_MS = 4_000;

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
 * Splits a Russian free-form address into LocationIQ structured fields.
 *
 * LocationIQ structured search wants `street` (house + street) then `city`, not a
 * single `q` string and not the spoken "город, улица" order left as one blob.
 */
export function parseAddressParts(input: { q?: string; city?: string; street?: string }): {
  readonly city: string;
  readonly street: string;
} {
  const city = input.city?.trim() ?? '';
  const street = input.street?.trim() ?? '';
  if (city && street) {
    return { city, street };
  }

  const raw = (input.q ?? '').trim();
  if (!raw) {
    return { city, street };
  }

  const parts = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (parts.length >= 2) {
    const first = parts[0] ?? '';
    const last = parts[parts.length - 1] ?? '';
    if (looksLikeCity(first)) {
      return { city: first, street: parts.slice(1).join(', ') };
    }
    if (looksLikeCity(last)) {
      return { city: last, street: parts.slice(0, -1).join(', ') };
    }
    return { city: first, street: parts.slice(1).join(', ') };
  }

  return { city: city || 'Москва', street: street || raw };
}

/**
 * LocationIQ forward geocoding for the dispatcher create-request form.
 *
 * Calls the structured endpoint only: street + city + country, never mixed with `q`.
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
    const parts = parseAddressParts(query);
    if (!parts.street) {
      throw new SysError('VALIDATION_FAILED', 'An address needs a street');
    }
    const cacheKey = createHash('sha256')
      .update(JSON.stringify({ city: parts.city, street: parts.street }))
      .digest('hex');
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const url = new URL(LOCATIONIQ_STRUCTURED);
    url.searchParams.set('key', token);
    url.searchParams.set('street', parts.street);
    url.searchParams.set('city', parts.city);
    url.searchParams.set('country', 'Russia');
    url.searchParams.set('countrycodes', 'ru');
    url.searchParams.set('format', 'json');
    url.searchParams.set('addressdetails', '1');
    url.searchParams.set('normalizeaddress', '1');
    url.searchParams.set('limit', '5');
    url.searchParams.set('accept-language', 'ru');

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
      const body: unknown = await response.json();
      if (!Array.isArray(body)) {
        return [];
      }
      return body.flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const row = item as { lat?: unknown; lon?: unknown; display_name?: unknown };
        const lat = Number(row.lat);
        const lon = Number(row.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
        return [
          {
            displayName: typeof row.display_name === 'string' ? row.display_name : `${lat}, ${lon}`,
            lat,
            lon,
          },
        ];
      });
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

const CITY_HINTS = [
  'москва',
  'moscow',
  'санкт-петербург',
  'петербург',
  'спб',
  'saint petersburg',
  'краснодар',
  'казань',
  'новосибирск',
  'екатеринбург',
  'нижний',
  'самара',
  'ростов',
  'уфа',
  'воронеж',
  'пермь',
  'волгоград',
];

function looksLikeCity(value: string): boolean {
  const lowered = value.toLowerCase();
  if (lowered.startsWith('г.') || lowered.startsWith('город ')) {
    return true;
  }
  return CITY_HINTS.some((hint) => lowered === hint || lowered.startsWith(`${hint} `));
}
