/** Ink, muted, bee and canvas used for MapLibre overlays on Figma MAIN. */
export const MAP_INK = '#272930';
export const MAP_MUTED = '#838383';
export const MAP_BEE = '#FFC72C';
export const MAP_CANVAS = '#F1F1F1';
export const MAP_LUNCH_STROKE = '#EC6A26';
export const MAP_LUNCH_FILL = '#E2B6A5';

const GENERAL: Record<string, string> = {
  '#202124': MAP_INK,
  '#5E636A': MAP_MUTED,
  '#5F6368': MAP_MUTED,
  '#7A7E83': MAP_MUTED,
  '#EDB700': MAP_BEE,
  '#E5B900': MAP_BEE,
  '#FFFFFF': MAP_CANVAS,
};

const LUNCH: Record<string, string> = {
  '#F07304': MAP_LUNCH_STROKE,
  '#E07A2F': MAP_LUNCH_STROKE,
  '#FFE6BD': MAP_LUNCH_FILL,
  '#FFE7C2': MAP_LUNCH_FILL,
};

/** On-screen dash / gap for schematic route pills, in CSS pixels. */
export const MAP_ROUTE_DASH_PX = 14;
export const MAP_ROUTE_GAP_PX = 10;

/** Job-stop circle, matching DayMap `stops-circle` radii plus stroke. */
export const STOP_RADIUS_PX = 13;
export const STOP_RADIUS_SELECTED_PX = 16;
export const STOP_STROKE_PX = 2.5;
export const STOP_STROKE_SELECTED_PX = 4;

export type StopLabelAnchor = {
  id: string;
  x: number;
  y: number;
  selected: boolean;
  /** Higher paints on top; the lower number is hidden when circles overlap. */
  z: number;
};

/**
 * Screen-pixel radius of a job stop, including the yellow ring.
 */
export function stopRadiusPx(selected: boolean): number {
  return selected
    ? STOP_RADIUS_SELECTED_PX + STOP_STROKE_SELECTED_PX
    : STOP_RADIUS_PX + STOP_STROKE_PX;
}

/**
 * Keeps the number on the topmost overlapping circle. MapLibre draws every
 * label above every circle, so a lower digit would otherwise sit on the upper
 * marker — hide it instead of showing both or the wrong one.
 */
export function visibleStopLabelIds(stops: readonly StopLabelAnchor[]): Set<string> {
  const ranked = [...stops]
    .map((stop) => ({ ...stop, r: stopRadiusPx(stop.selected) }))
    .sort((left, right) => left.z - right.z);
  const hidden = new Set<string>();
  for (let index = 0; index < ranked.length; index += 1) {
    const lower = ranked[index];
    if (!lower) continue;
    for (let above = index + 1; above < ranked.length; above += 1) {
      const upper = ranked[above];
      if (!upper) continue;
      const dist = Math.hypot(upper.x - lower.x, upper.y - lower.y);
      if (dist < lower.r + upper.r) {
        hidden.add(lower.id);
        break;
      }
    }
  }
  return new Set(stops.map((stop) => stop.id).filter((id) => !hidden.has(id)));
}

/** Equirectangular meters-per-pixel at a latitude and MapLibre zoom. */
export function metersPerPixel(latitude: number, zoom: number): number {
  return (40075016.686 * Math.cos((latitude * Math.PI) / 180)) / (256 * 2 ** zoom);
}

function haversineMeters(from: readonly [number, number], to: readonly [number, number]): number {
  const radius = 6371000;
  const toRad = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRad(to[1] - from[1]);
  const dLon = toRad(to[0] - from[0]);
  const lat1 = toRad(from[1]);
  const lat2 = toRad(to[1]);
  const half = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(half)));
}

function interpolate(
  from: readonly [number, number],
  to: readonly [number, number],
  t: number,
): [number, number] {
  return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
}

/**
 * Splits a line into short segments so MapLibre round caps become capsules.
 * Native `line-dasharray` always draws square dashes.
 */
function asPoint(value: readonly number[] | undefined): readonly [number, number] | null {
  const lon = value?.[0];
  const lat = value?.[1];
  if (lon === undefined || lat === undefined) return null;
  return [lon, lat];
}

export function pillDashLine(
  coordinates: ReadonlyArray<readonly number[]>,
  dashMeters: number,
  gapMeters: number,
): [number, number][][] {
  if (coordinates.length < 2 || dashMeters <= 0) return [];
  const gap = Math.max(gapMeters, 0);
  const dashes: [number, number][][] = [];
  let drawing = true;
  let carry = 0;
  let current: [number, number][] = [];

  for (let index = 0; index < coordinates.length - 1; index += 1) {
    const from = asPoint(coordinates[index]);
    const to = asPoint(coordinates[index + 1]);
    if (!from || !to) continue;
    const length = haversineMeters(from, to);
    if (length <= 0) continue;
    let consumed = 0;
    while (consumed < length) {
      const period = drawing ? dashMeters : gap;
      const step = Math.min(period - carry, length - consumed);
      const startT = consumed / length;
      const endT = (consumed + step) / length;
      if (drawing) {
        if (current.length === 0) current.push(interpolate(from, to, startT));
        current.push(interpolate(from, to, endT));
      }
      consumed += step;
      carry += step;
      if (carry >= period - 1e-6) {
        if (drawing && current.length >= 2) dashes.push(current);
        current = [];
        drawing = !drawing;
        carry = 0;
      }
    }
  }
  if (current.length >= 2) dashes.push(current);
  return dashes;
}

function normalizeHex(hex: string): string {
  const trimmed = hex.trim();
  if (/^#[0-9A-Fa-f]{3}$/.test(trimmed)) {
    const r = trimmed[1];
    const g = trimmed[2];
    const b = trimmed[3];
    return `#${r}${r}${g}${g}${b}${b}`.toUpperCase();
  }
  return trimmed.toUpperCase();
}

/** Remaps a route / marker paint color onto the Figma MAIN map tokens. */
export function mapPaintColor(hex: string): string {
  return GENERAL[normalizeHex(hex)] ?? hex;
}

/** Remaps a lunch marker paint color onto the Figma MAIN lunch tokens. */
export function mapLunchColor(hex: string): string {
  return LUNCH[normalizeHex(hex)] ?? mapPaintColor(hex);
}
