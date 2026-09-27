import maplibregl from 'maplibre-gl';
import { useEffect, useRef, useState } from 'react';
import type { SimulationResponse } from '../api/client';
import type { StrategyId } from '../api/types';
import { localMapStyle } from '../domain/localBasemap';
import { ONLINE_MAP_STYLE, watchMapStartup } from '../domain/mapAvailability';
import { ALL_REGIONS, type RegionSelection } from '../domain/regions';
import { t } from '../i18n';
import { strategyLabel } from '../lib/policyComparison';
import { RegionSwitch } from './RegionSwitch';

const STRATEGY_IDS = new Set<string>([
  'fast',
  'compact',
  'sla',
  'balanced',
  'eco',
  'covering',
  'baseline',
]);

function strategyName(id: string): string {
  return STRATEGY_IDS.has(id) ? strategyLabel(id as StrategyId) : id;
}

/** One strategy, one stroke. Metro, OSRM, straight and API geometry share that color. */
export const STRATEGY_COLORS: Record<string, string> = {
  fast: '#E11D48',
  compact: '#2563EB',
  sla: '#16A34A',
  balanced: '#D97706',
  eco: '#0F766E',
  covering: '#7C3AED',
  baseline: '#272930',
};

/** One request from today's set. The policy map draws these, not the road graph. */
export interface DayRequestPoint {
  readonly id: string;
  readonly lat: number;
  readonly lon: number;
  readonly region: string;
}

/**
 * All simulated strategies on one full basemap inside the policy tab.
 * Dots are today's requests. Each strategy can be hidden.
 */
export function PolicyStrategyMap({
  requests,
  strategies,
  regions,
  selectedRegion,
  engineerRegions,
  motionOn,
}: {
  requests: readonly DayRequestPoint[];
  strategies: SimulationResponse['strategies'];
  regions: { id: RegionSelection; label: string }[];
  selectedRegion: RegionSelection;
  /** Engineer id to region id. Simulation routes use account ids, not region prefixes. */
  engineerRegions: Readonly<Record<string, string>>;
  motionOn: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const pointsRef = useRef<readonly DayRequestPoint[]>(requests);
  pointsRef.current = requests;
  const strategiesRef = useRef(strategies);
  const engineerRegionsRef = useRef(engineerRegions);
  const fittedRegionRef = useRef<RegionSelection | null>(null);
  strategiesRef.current = strategies;
  engineerRegionsRef.current = engineerRegions;
  const hiddenRef = useRef<ReadonlySet<string>>(new Set());
  const regionRef = useRef<RegionSelection>(selectedRegion);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [region, setRegion] = useState<RegionSelection>(selectedRegion);
  const [regionOpen, setRegionOpen] = useState(false);
  hiddenRef.current = hidden;
  regionRef.current = region;

  useEffect(() => {
    setRegion(selectedRegion);
  }, [selectedRegion]);

  useEffect(() => {
    const node = host.current;
    if (!node) return;
    const map = new maplibregl.Map({
      container: node,
      style: ONLINE_MAP_STYLE,
      center: [37.62, 55.75],
      zoom: 10,
      attributionControl: false,
    });
    mapRef.current = map;
    const stopWatch = watchMapStartup(map, () => map.setStyle(localMapStyle()));
    const draw = () => {
      if (map.getSource('day-requests')) return;
      map.addSource('day-requests', {
        type: 'geojson',
        data: requestCollection(pointsRef.current),
      });
      map.addLayer({
        id: 'day-requests',
        type: 'circle',
        source: 'day-requests',
        filter: nodeFilter(regionRef.current),
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 4, 13, 7, 16, 9],
          'circle-color': '#272930',
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#ffffff',
        },
      });
      strategiesRef.current.forEach((strategy, index) => {
        const sourceId = `strategy-${index}`;
        map.addSource(sourceId, {
          type: 'geojson',
          data: lineCollection(strategy, regionRef.current, engineerRegionsRef.current),
        });
        map.addLayer({
          id: sourceId,
          type: 'line',
          source: sourceId,
          filter: ['==', ['get', 'schematic'], false],
          layout: {
            'line-cap': 'round',
            'line-join': 'round',
            visibility: hiddenRef.current.has(strategy.strategyId) ? 'none' : 'visible',
          },
          paint: {
            'line-color': STRATEGY_COLORS[strategy.strategyId] ?? '#272930',
            'line-width': 3,
            'line-opacity': 0.9,
          },
        });
        map.addLayer({
          id: `${sourceId}-schematic`,
          type: 'line',
          source: sourceId,
          filter: ['==', ['get', 'schematic'], true],
          layout: {
            'line-cap': 'round',
            'line-join': 'round',
            visibility: hiddenRef.current.has(strategy.strategyId) ? 'none' : 'visible',
          },
          paint: {
            'line-color': STRATEGY_COLORS[strategy.strategyId] ?? '#272930',
            'line-width': 2,
            'line-opacity': 0.7,
            'line-dasharray': [2, 2],
          },
        });
      });
      fitRegionOnce(map, pointsRef.current, regionRef.current, fittedRegionRef);
    };
    map.on('style.load', draw);
    if (map.isStyleLoaded()) draw();
    const observer = new ResizeObserver(() => map.resize());
    observer.observe(node);
    return () => {
      observer.disconnect();
      stopWatch();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.getLayer('day-requests')) return;
    const points = map.getSource('day-requests');
    if (points instanceof maplibregl.GeoJSONSource) {
      points.setData(requestCollection(requests));
    }
    map.setFilter('day-requests', nodeFilter(region));
    strategies.forEach((strategy, index) => {
      const source = map.getSource(`strategy-${index}`);
      if (source instanceof maplibregl.GeoJSONSource) {
        source.setData(lineCollection(strategy, region, engineerRegions));
      }
    });
    fitRegionOnce(map, requests, region, fittedRegionRef);
  }, [region, strategies, engineerRegions, requests]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    for (const [index, strategy] of strategies.entries()) {
      if (!map.getLayer(`strategy-${index}`)) continue;
      map.setLayoutProperty(
        `strategy-${index}`,
        'visibility',
        hidden.has(strategy.strategyId) ? 'none' : 'visible',
      );
      if (map.getLayer(`strategy-${index}-schematic`))
        map.setLayoutProperty(
          `strategy-${index}-schematic`,
          'visibility',
          hidden.has(strategy.strategyId) ? 'none' : 'visible',
        );
    }
  }, [hidden, strategies]);

  const label =
    regions.find((item) => item.id === region)?.label ??
    t('figma-dashboard.PolicyStrategyMap.d7506709ce');

  return (
    <div className="flex h-full min-h-[640px] gap-[16px]">
      <div className="relative min-w-0 flex-1 overflow-hidden rounded-[20px]">
        <div ref={host} className="h-full w-full" />
        <RegionSwitch
          open={regionOpen}
          label={label}
          regions={regions}
          selectedId={region}
          motionOn={motionOn}
          onToggle={() => setRegionOpen((value) => !value)}
          onSelect={(id) => {
            setRegion(id);
            setRegionOpen(false);
          }}
        />
      </div>
      <div className="flex w-[240px] shrink-0 flex-col gap-[16px] overflow-auto">
        <p className="text-[13px] leading-[18px] text-figma-muted">
          {t('figma-dashboard.PolicyStrategyMap.9b8fd41dcb')}
        </p>
        <ul className="flex flex-col gap-[10px]">
          {strategies.map((strategy) => {
            const checked = !hidden.has(strategy.strategyId);
            return (
              <li key={strategy.strategyId}>
                <button
                  type="button"
                  onClick={() => {
                    setHidden((current) => {
                      const next = new Set(current);
                      if (next.has(strategy.strategyId)) next.delete(strategy.strategyId);
                      else next.add(strategy.strategyId);
                      return next;
                    });
                  }}
                  className="flex w-full items-center gap-[10px] text-left"
                  aria-pressed={checked}
                >
                  <span
                    className={`flex size-[28px] shrink-0 items-center justify-center rounded-[10px] ${
                      checked ? 'bg-figma-ink' : 'border-2 border-[#d4d5d8] bg-white'
                    }`}
                  >
                    {checked ? (
                      <img
                        src="/figma/check-mark.svg"
                        alt=""
                        className="size-[18px] brightness-0 invert"
                      />
                    ) : null}
                  </span>
                  <span
                    className="size-[12px] shrink-0 rounded-full"
                    style={{ background: STRATEGY_COLORS[strategy.strategyId] ?? '#272930' }}
                  />
                  <span className="font-semibold text-[15px] text-figma-ink">
                    {strategyName(strategy.strategyId)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

function requestCollection(points: readonly DayRequestPoint[]) {
  return {
    type: 'FeatureCollection' as const,
    features: points.map((point) => ({
      type: 'Feature' as const,
      properties: { nodeId: point.id, region: point.region },
      geometry: {
        type: 'Point' as const,
        coordinates: [point.lon, point.lat] as [number, number],
      },
    })),
  };
}

function nodeFilter(region: RegionSelection): maplibregl.FilterSpecification {
  if (region === ALL_REGIONS) return ['has', 'region'];
  return ['==', ['get', 'region'], region];
}

function routeInRegion(
  engineerId: string,
  region: RegionSelection,
  engineerRegions: Readonly<Record<string, string>>,
): boolean {
  if (region === ALL_REGIONS) return true;
  const known = engineerRegions[engineerId];
  if (known) return known === region;
  return engineerId.startsWith(`${region}:`);
}

function lineCollection(
  strategy: SimulationResponse['strategies'][number],
  region: RegionSelection,
  engineerRegions: Readonly<Record<string, string>>,
) {
  const routes = strategy.routes.filter((route) =>
    routeInRegion(route.engineerId, region, engineerRegions),
  );
  return {
    type: 'FeatureCollection',
    features: routes.flatMap((route) =>
      route.segments
        .filter((segment) => segment.points.length >= 2)
        .map((segment) => ({
          type: 'Feature' as const,
          properties: {
            engineerId: route.engineerId,
            schematic: segment.travelSource !== 'metro' && segment.points.length <= 2,
          },
          geometry: {
            type: 'LineString' as const,
            coordinates: segment.points.map((point) => [point.lon, point.lat] as [number, number]),
          },
        })),
    ),
  };
}

/**
 * Fits once per chosen region. Later snapshot refreshes must not pull the camera back.
 */
function fitRegionOnce(
  map: maplibregl.Map,
  points: readonly DayRequestPoint[],
  region: RegionSelection,
  fittedRegion: { current: RegionSelection | null },
): void {
  if (fittedRegion.current === region) return;
  const visible = points.filter((point) => region === ALL_REGIONS || point.region === region);
  if (visible.length === 0) return;
  const bounds = new maplibregl.LngLatBounds();
  for (const point of visible) {
    bounds.extend([point.lon, point.lat]);
  }
  if (bounds.isEmpty()) return;
  fittedRegion.current = region;
  map.fitBounds(bounds, { padding: 48, maxZoom: 13, duration: 0 });
}
