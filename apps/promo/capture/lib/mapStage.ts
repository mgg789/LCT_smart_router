/**
 * Plays the map's own route drawing as three beats, on the live dashboard.
 *
 * Road geometry arrives after the day starts, often several seconds later. The
 * `routes` source is frozen as soon as the map exists, so those updates are kept
 * and not drawn. Once the feature set stops growing, the take shows stops alone,
 * then straight dashed chords, then the real roads in three waves. One metro leg,
 * when the plan has one, is restored as itself on the second wave.
 */
import type { Page } from 'playwright';
import type { Recorder } from './recorder.ts';

interface StageResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly legs?: number;
}

/**
 * Points, then dashed chords, then roads in three waves.
 *
 * Marks `tiles` while the map is still empty, then `points`, `haversine`,
 * `roads1`, `roads2`, `roads3` and `roads` once geometry has settled. Returns
 * false when the map cannot be driven, so the caller can fall back to waiting
 * on the product's own geometry instead of filming a blank board.
 */
export async function stageMapReveal(page: Page, recorder: Recorder): Promise<boolean> {
  await page
    .waitForFunction(
      () => {
        const ready = document.querySelector('[data-map-ready="true"], [data-map-ready]');
        const canvas = document.querySelector('.maplibregl-canvas');
        return Boolean(ready && canvas);
      },
      { timeout: 25_000 },
    )
    .catch(() => null);
  // Tiles finish after the style is ready. A beat here is the difference between a
  // map and a grey rectangle in the first frame of the shot.
  await page.waitForTimeout(1400);
  recorder.mark('tiles');

  const armed = await page.evaluate(armMap, 'reveal' as const);
  if (!armed.ok) {
    console.log(`  map stage skipped: ${armed.reason ?? 'unknown'}`);
    return false;
  }

  const settled = await waitForStableRoutes(page);
  if (!settled) {
    console.log('  map stage skipped: routes stayed empty');
    await page.evaluate(releaseMap);
    return false;
  }
  const stats = await page.evaluate(routeStats);
  console.log(`  map stage: ${stats.legs} legs, ${stats.metro} metro`);

  const show = (phase: string, wave = 0) =>
    page.evaluate(([name, step]: [string, number]) => {
      const driver = (
        window as unknown as { __promoMap?: { setPhase: (p: string, w: number) => void } }
      ).__promoMap;
      driver?.setPhase(name, step);
    }, [phase, wave] satisfies [string, number]);

  await show('points');
  recorder.mark('points');
  await page.waitForTimeout(700);

  await show('dash');
  recorder.mark('haversine');
  await page.waitForTimeout(900);

  for (const wave of [1, 2, 3] as const) {
    await show('roads', wave);
    recorder.mark(`roads${wave}`);
    await page.waitForTimeout(780);
  }
  recorder.mark('roads');
  await page.evaluate(releaseMap);
  return true;
}

/**
 * Keeps the current plan's roads on the map while the router rebuilds underneath.
 *
 * Every later `setData` is remembered but not drawn, so the take can show the new
 * plan arriving as one visible change instead of a silent swap. Returns false when
 * there is no map or no roads to hold.
 */
export async function holdRoutes(page: Page): Promise<boolean> {
  // The board mounts the map and loads the plan's roads a few seconds after the page.
  const deadline = Date.now() + 45_000;
  let armed: StageResult | null = null;
  while (Date.now() < deadline) {
    armed = await page.evaluate(armMap, 'hold' as const).catch(() => null);
    if (armed?.ok) break;
    await page.waitForTimeout(500);
  }
  if (!armed?.ok) {
    console.log(`  route hold skipped: ${armed?.reason ?? 'no map'}`);
    return false;
  }
  console.log(`  holding ${armed.legs ?? 0} legs of the current plan`);
  return true;
}

/**
 * Plays a held rebuild: the old roads, the new plan as dashed chords, then the new
 * roads in three waves.
 *
 * Marks `morph` on the chords and `morphDone` when the last wave lands. Waits up to
 * 60 s for geometry that differs from the held plan; if none arrives it still plays
 * the beat on whatever the router published, and says so.
 */
export async function playRouteChange(page: Page, recorder: Recorder): Promise<boolean> {
  const deadline = Date.now() + 60_000;
  let changed = false;
  while (Date.now() < deadline) {
    changed = await page.evaluate(() => {
      const driver = (window as unknown as { __promoMap?: { changed: () => boolean } }).__promoMap;
      return driver?.changed() ?? false;
    });
    if (changed) break;
    await page.waitForTimeout(400);
  }
  if (!changed) console.log('  the rebuilt plan draws the same roads as the held one');
  console.log(`  legs after the rebuild: ${(await page.evaluate(routeStats)).legs}`);
  if (!(await waitForStableRoutes(page))) {
    await page.evaluate(releaseMap);
    return false;
  }

  const show = (phase: string, wave = 0) =>
    page.evaluate(([name, step]: [string, number]) => {
      const driver = (
        window as unknown as { __promoMap?: { setPhase: (p: string, w: number) => void } }
      ).__promoMap;
      driver?.setPhase(name, step);
    }, [phase, wave] satisfies [string, number]);

  recorder.mark('morphFrom');
  await page.waitForTimeout(900);
  await show('dash');
  recorder.mark('morph');
  await page.waitForTimeout(900);
  for (const wave of [1, 2, 3] as const) {
    await show('roads', wave);
    await page.waitForTimeout(700);
  }
  recorder.mark('morphDone');
  await page.evaluate(releaseMap);
  return changed;
}

/**
 * Waits until route features have arrived and stopped changing.
 *
 * The router publishes geometry a few edges at a time. Starting the chord beat
 * on the first handful would leave the later waves with nothing to draw.
 */
async function waitForStableRoutes(page: Page): Promise<boolean> {
  const deadline = Date.now() + 50_000;
  let last = -1;
  let stableSince = 0;
  while (Date.now() < deadline) {
    const count = await page.evaluate(() => {
      const driver = (window as unknown as { __promoMap?: { featureCount: () => number } }).__promoMap;
      return driver?.featureCount() ?? 0;
    });
    if (count > 0 && count === last) {
      if (stableSince === 0) stableSince = Date.now();
      if (Date.now() - stableSince >= 1200) return true;
    } else {
      stableSince = 0;
      last = count;
    }
    await page.waitForTimeout(200);
  }
  return last > 0;
}

function routeStats(): { legs: number; metro: number } {
  const driver = (window as unknown as { __promoMap?: { featureCount: () => number; metroCount: () => number } })
    .__promoMap;
  return {
    legs: driver?.featureCount() ?? 0,
    metro: driver?.metroCount() ?? 0,
  };
}

/**
 * Installed in the page. Finds the MapLibre map and freezes its route source.
 *
 * `reveal` draws nothing while frozen; `hold` keeps drawing the roads that were on
 * the map when it was armed.
 */
function armMap(mode: 'reveal' | 'hold'): StageResult {
  type Line = {
    type: 'Feature';
    properties: Record<string, unknown>;
    geometry: { type: 'LineString'; coordinates: number[][] };
  };
  type Collection = { type: 'FeatureCollection'; features: Line[] };
  // MapLibre 5 keeps the last `setData` under `_data.geojson`; older builds kept it bare.
  type GeoSource = {
    id?: string;
    setData: (data: Collection) => unknown;
    _data?: Collection | { geojson?: Collection };
  };
  type SourceSpec = { type?: string; data?: unknown };
  type MapLike = {
    getSource: (id: string) => GeoSource | undefined;
    addSource: (id: string, spec: SourceSpec) => unknown;
    loaded: () => boolean;
  };

  const findMap = (): MapLike | null => {
    const isMap = (value: unknown): value is MapLike => {
      if (!value || typeof value !== 'object') return false;
      const candidate = value as MapLike;
      return typeof candidate.getSource === 'function' && typeof candidate.loaded === 'function';
    };
    const fromFiber = (start: unknown): MapLike | null => {
      let fiber = start as {
        memoizedState?: { memoizedState?: { current?: unknown }; next?: unknown };
        return?: unknown;
      } | null;
      const seen = new Set<unknown>();
      while (fiber && !seen.has(fiber)) {
        seen.add(fiber);
        let hook = fiber.memoizedState;
        while (hook) {
          const current = hook.memoizedState?.current;
          if (isMap(current)) return current;
          hook = hook.next as typeof hook;
        }
        fiber = (fiber.return as typeof fiber) ?? null;
      }
      return null;
    };
    const canvas = document.querySelector('.maplibregl-canvas');
    let node: Element | null = canvas;
    while (node) {
      const key = Object.keys(node).find((name) => name.startsWith('__reactFiber$'));
      if (key) {
        const found = fromFiber((node as unknown as Record<string, unknown>)[key]);
        if (found) return found;
      }
      node = node.parentElement;
    }
    return null;
  };

  const map = findMap();
  if (!map) return { ok: false, reason: 'map instance was not on the page' };
  const source = map.getSource('routes');
  if (!source) return { ok: false, reason: 'routes source is missing' };

  const metroOf = (feature: Line) => {
    const sourceName = String(feature.properties.travelSource ?? '');
    const color = String(feature.properties.color ?? '').toLowerCase();
    return sourceName === 'metro' || color === '#8b5cf6';
  };
  const usable = (features: Line[]) =>
    features.filter((feature) => (feature.geometry?.coordinates?.length ?? 0) >= 2);

  const stored = source._data;
  const current = stored && 'geojson' in stored ? stored.geojson : (stored as Collection | undefined);
  let latest = usable(current?.features ?? []);
  const held = latest;
  if (mode === 'hold' && held.length === 0) return { ok: false, reason: 'no roads to hold' };
  const signature = (list: Line[]) =>
    list
      .map((feature) => {
        const coordinates = feature.geometry.coordinates;
        const mid = coordinates[Math.floor(coordinates.length / 2)] ?? [0, 0];
        return `${coordinates.length}:${(mid[0] ?? 0).toFixed(5)},${(mid[1] ?? 0).toFixed(5)}`;
      })
      .sort()
      .join('|');
  const heldSignature = signature(held);
  let locked = true;
  const frozen = (): Collection => ({
    type: 'FeatureCollection',
    features: mode === 'hold' ? held : [],
  });
  const remember = (data: unknown) => {
    const features = (data as Collection | null)?.features;
    const next = Array.isArray(features) ? usable(features) : [];
    if (next.length > 0) latest = next;
  };

  // The board can remount its map while the plan changes (a policy switch, a panel), and
  // a fresh map gets its roads through `addSource`, not `setData`. Both are held on the
  // prototypes, so the hold survives a remount instead of guarding a detached source.
  const sourceProto = Object.getPrototypeOf(source) as GeoSource;
  const mapProto = Object.getPrototypeOf(map) as MapLike;
  const nativeSetData = sourceProto.setData;
  const nativeAddSource = mapProto.addSource;
  let active: GeoSource = source;
  sourceProto.setData = function (this: GeoSource, data: Collection) {
    if (this.id !== 'routes') return nativeSetData.call(this, data);
    active = this;
    remember(data);
    return nativeSetData.call(this, locked ? frozen() : data);
  };
  mapProto.addSource = function (this: MapLike, id: string, spec: SourceSpec) {
    if (id !== 'routes' || !locked || typeof spec?.data !== 'object') {
      return nativeAddSource.call(this, id, spec);
    }
    remember(spec.data);
    return nativeAddSource.call(this, id, { ...spec, data: frozen() });
  };
  const live = (): GeoSource => findMap()?.getSource('routes') ?? active;
  const original = (data: Collection) => {
    nativeSetData.call(live(), data);
  };
  if (mode === 'reveal' && latest.length > 0) original(frozen());

  const collection = (list: Line[]): Collection => ({ type: 'FeatureCollection', features: list });
  const ends = (feature: Line): [number[], number[]] | null => {
    const coordinates = feature.geometry?.coordinates ?? [];
    const first = coordinates[0];
    const last = coordinates[coordinates.length - 1];
    if (!first || !last) return null;
    return [first, last];
  };
  const dashed = (feature: Line): Line[] => {
    const pair = ends(feature);
    if (!pair) return [];
    const [from, to] = pair;
    const parts = 8;
    const out: Line[] = [];
    for (let index = 0; index < parts; index += 1) {
      const t0 = index / parts;
      const t1 = (index + 0.48) / parts;
      const at = (t: number) => [
        from[0] + (to[0] - from[0]) * t,
        from[1] + (to[1] - from[1]) * t,
      ];
      out.push({
        type: 'Feature',
        properties: { ...feature.properties, approximate: 1 },
        geometry: { type: 'LineString', coordinates: [at(t0), at(t1)] },
      });
    }
    return out;
  };

  const setPhase = (phase: string, wave: number) => {
    const roads = latest;
    const metro = roads.filter(metroOf);
    const ordinary = roads.filter((feature) => !metroOf(feature));
    const groups: Line[][] = [[], [], []];
    ordinary.forEach((feature, index) => {
      groups[index % 3]?.push(feature);
    });
    if (groups[1]) groups[1].push(...metro);
    if (phase === 'points') {
      original(collection([]));
      return;
    }
    if (phase === 'dash') {
      original(collection(roads.flatMap(dashed)));
      return;
    }
    const shown = groups.slice(0, wave).flat();
    const waiting = groups.slice(wave).flat();
    original(collection([...shown, ...waiting.flatMap(dashed)]));
  };

  (window as unknown as { __promoMap?: unknown }).__promoMap = {
    featureCount: () => latest.length,
    changed: () => signature(latest) !== heldSignature,
    metroCount: () => latest.filter(metroOf).length,
    setPhase,
    release: () => {
      locked = false;
      sourceProto.setData = nativeSetData;
      mapProto.addSource = nativeAddSource;
      original(collection(latest));
    },
  };
  return { ok: true, legs: latest.length };
}

function releaseMap(): void {
  const driver = (window as unknown as { __promoMap?: { release: () => void } }).__promoMap;
  driver?.release();
}
