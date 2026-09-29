import { configuredTimeZone, zonedWallUnix } from '../../common/time/zone';

const STALE_AFTER_SEC = 45 * 24 * 60 * 60;

/** True only after the agreed 45 full days have elapsed. */
export function isStale(updatedAt: number, now: number): boolean {
  return now - updatedAt > STALE_AFTER_SEC;
}

/** Moscow civil month rendered independently of the host time zone. */
export function moscowMonth(now: number): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: configuredTimeZone(),
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date(now * 1000));
  return `${parts.find((part) => part.type === 'year')?.value}-${parts.find((part) => part.type === 'month')?.value}`;
}

/** Half-open Unix range for the Moscow civil month containing `now`. */
export function moscowMonthBounds(now: number): readonly [number, number] {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: configuredTimeZone(),
    year: 'numeric',
    month: 'numeric',
  }).formatToParts(new Date(now * 1000));
  const year = Number(parts.find((part) => part.type === 'year')?.value);
  const month = Number(parts.find((part) => part.type === 'month')?.value);
  const start = zonedWallUnix(`${year}-${String(month).padStart(2, '0')}-01T00:00:00`);
  const next = month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`;
  return [start, zonedWallUnix(`${next}-01T00:00:00`)];
}

/** Builds a building identity from provider address components. POI names and flat-like
 * display text are excluded, so different entrances resolve to the same house. */
export function canonicalBuildingAddress(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const address = value as Record<string, unknown>;
  const house = read(address.house_number);
  const road = read(address.road) ?? read(address.pedestrian) ?? read(address.residential);
  const city = read(address.city) ?? read(address.town) ?? read(address.village);
  if (!house || !road || !city) return null;
  return buildingKey(city, road, house);
}

/** Normalizes explicit Russian building addresses without replacing an authoritative
 * house number with the nearest reverse-geocoder result. Ambiguous free text is refused. */
export function canonicalTextAddress(value: string): string | null {
  const text = normalize(value).replace(
    /(?:,?\s+|,\s*)(?:кв(?:артира)?|оф(?:ис)?|пом(?:ещение)?|подъезд|этаж)\.?\s*\d.*$/u,
    '',
  );
  const parts = text
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;
  // Official imports and dispatcher addresses use city, street, house. LocationIQ
  // autocomplete may return house, street, district, city, postcode, country.
  const houseIndex = parts.findIndex(
    (part, index) =>
      index > 0 &&
      /^(?:д(?:ом)?\.?\s*)?\d+[а-яa-z]?(?:[/\s]|$|к\d|с\d)/u.test(part) &&
      !/^\d{6}$/u.test(part),
  );
  if (houseIndex > 1)
    return buildingKey(parts[0] ?? '', parts[houseIndex - 1] ?? '', parts[houseIndex] ?? '');
  const last = parts.at(-1) ?? '';
  const joined = last.match(/^(.+?)\s+(?:д(?:ом)?\.?\s*)?(\d+[а-яa-z]?(?:[/\s].*)?)$/u);
  if (joined && parts.length >= 2)
    return buildingKey(parts[0] ?? '', joined[1] ?? '', joined[2] ?? '');
  // Provider display order is accepted only with an explicit known city component.
  if (/^\d/u.test(parts[0] ?? '')) {
    const city = parts.find((part) =>
      /^(?:г(?:ород)?\.?\s*)?(?:москва|санкт-петербург)$/u.test(part),
    );
    if (city && parts[1]) return buildingKey(city, parts[1], parts[0] ?? '');
  }
  return null;
}

/** Distinguishes map-point labels from an explicit address that must not be guessed. */
export function isCoordinateAddress(value: string): boolean {
  const text = value.trim();
  return (
    !text ||
    /^(?:точка(?: на карте)?|координаты|адрес не указан)(?:\s|:|$)/iu.test(text) ||
    /^\(?\s*-?\d{1,3}\.\d+\s*[,; ]\s*-?\d{1,3}\.\d+\s*\)?$/u.test(text)
  );
}

function normalize(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('ru-RU')
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildingKey(city: string, street: string, house: string): string | null {
  const normalizedCity = normalize(city).replace(/^(?:город|г\.)\s*/u, '');
  let road = normalize(street).replace(/\./g, ' ').replace(/\s+/g, ' ').trim();
  const types: Array<readonly [RegExp, string]> = [
    [/^(?:ул|улица)\s+|\s+(?:ул|улица)$/u, 'улица'],
    [/^(?:пр-кт|проспект)\s+|\s+(?:пр-кт|проспект)$/u, 'проспект'],
    [/^(?:пер|переулок)\s+|\s+(?:пер|переулок)$/u, 'переулок'],
    [/^(?:наб|набережная)\s+|\s+(?:наб|набережная)$/u, 'набережная'],
    [/^(?:б-р|бульвар)\s+|\s+(?:б-р|бульвар)$/u, 'бульвар'],
    [/^(?:ш|шоссе)\s+|\s+(?:ш|шоссе)$/u, 'шоссе'],
  ];
  for (const [pattern, type] of types) {
    if (pattern.test(road)) {
      road = `${road.replace(pattern, '').trim()} ${type}`;
      break;
    }
  }
  const number = normalize(house)
    .replace(/^(?:дом|д\.)\s*|^д\s+|^д(?=\d)/u, '')
    .replace(/корпус|корп\.?/gu, 'к')
    .replace(/строение|стр\.?/gu, 'с')
    .replace(/\s+/g, '');
  if (
    !normalizedCity ||
    !road ||
    !/^\d+[а-яa-z]?(?:\/\d+[а-яa-z]?)?(?:[кс]\d+[а-яa-z]?)*$/u.test(number)
  )
    return null;
  return `${normalizedCity}, ${road}, ${number}`;
}

function read(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().replace(/\s+/g, ' ') : null;
}
