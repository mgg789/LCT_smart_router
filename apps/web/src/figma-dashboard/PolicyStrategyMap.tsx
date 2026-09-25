import maplibregl from 'maplibre-gl';
import { useEffect, useRef, useState } from 'react';
import type { SimulationResponse } from '../api/client';
import type { StrategyId } from '../api/types';
import { ALL_REGIONS, type RegionSelection } from '../domain/regions';
import { localMapStyle } from '../domain/localBasemap';
import { ONLINE_MAP_STYLE, watchMapStartup } from '../domain/mapAvailability';
import { strategyLabel } from '../lib/policyComparison';

const STRATEGY_IDS = new Set<string>(['fast', 'compact', 'sla', 'balanced', 'eco', 'covering', 'baseline']);

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

interface GraphFeature {
  readonly properties: { readonly nodeId: string; readonly region: string };
  readonly geometry: { readonly type: 'Point'; readonly coordinates: [number, number] };
}

/**
 * All simulated strategies on one full basemap inside the policy tab.
 * Graph dots follow the region chosen in the map corner. Each strategy can be hidden.
 */
export function PolicyStrategyMap({
  strategies,
  regions,
  selectedRegion,
  engineerRegions,
}: {
  strategies: SimulationResponse['strategies'];
  regions: { id: RegionSelection; label: string }[];
  selectedRegion: RegionSelection;
  /** Engineer id to region id. Simulation routes use account ids, not region prefixes. */
  engineerRegions: Readonly<Record<string, string>>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const nodesRef = useRef<GraphFeature[]>([]);
  const engineerRegionsRef = useRef(engineerRegions);
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
      if (map.getSource('graph-nodes')) return;
      void fetch('/maps/graph-nodes.geojson')
        .then((response) => response.json())
        .then((payload: { features: GraphFeature[] }) => {
          nodesRef.current = payload.features.filter((feature) => feature.geometry.type === 'Point');
          map.addSource('graph-nodes', { type: 'geojson', data: payload });
          map.addLayer({
            id: 'graph-nodes',
            type: 'circle',
            source: 'graph-nodes',
            filter: nodeFilter(regionRef.current),
            paint: {
              'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 1.5, 13, 3, 16, 4],
              'circle-color': '#272930',
            },
          });
          strategies.forEach((strategy, index) => {
            const sourceId = `strategy-${index}`;
            map.addSource(sourceId, {
              type: 'geojson',
              data: lineCollection(strategy, regionRef.current, engineerRegionsRef.current),
            });
            map.addLayer({
              id: sourceId,
              type: 'line',
              source: sourceId,
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
          });
          fitRegion(map, nodesRef.current, regionRef.current);
        })
        .catch(() => undefined);
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
  }, [strategies]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.getLayer('graph-nodes')) return;
    map.setFilter('graph-nodes', nodeFilter(region));
    strategies.forEach((strategy, index) => {
      const source = map.getSource(`strategy-${index}`);
      if (source instanceof maplibregl.GeoJSONSource) {
        source.setData(lineCollection(strategy, region, engineerRegions));
      }
    });
    fitRegion(map, nodesRef.current, region);
  }, [region, strategies, engineerRegions]);

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
    }
  }, [hidden, strategies]);

  const label = regions.find((item) => item.id === region)?.label ?? 'Регион';

  return (
    <div className="flex h-full min-h-[640px] gap-[16px]">
      <div className="relative min-w-0 flex-1 overflow-hidden rounded-[20px]">
        <div ref={host} className="h-full w-full" />
        <div className="absolute left-[16px] top-[16px] z-10">
          <div className="overflow-hidden rounded-[27px] bg-white shadow-[0_8px_22px_rgba(39,41,48,0.12)]">
            <button
              type="button"
              onClick={() => setRegionOpen((value) => !value)}
              className="flex h-[51px] items-center gap-[8px] pl-[16px] pr-[16px] font-semibold text-[18px] tracking-[-0.3px] text-figma-ink"
            >
              {label}
              <span aria-hidden className={`text-[12px] ${regionOpen ? 'rotate-180' : ''}`}>
                ▾
              </span>
            </button>
            {regionOpen ? (
              <div className="pb-[8px]">
                {regions.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setRegion(item.id);
                      setRegionOpen(false);
                    }}
                    className={`flex h-[40px] w-full items-center px-[16px] text-left text-[16px] ${
                      item.id === region ? 'font-semibold text-figma-ink' : 'font-medium text-figma-muted'
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </div>
      <ul className="flex w-[240px] shrink-0 flex-col gap-[10px] overflow-auto">
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
              >
                <span
                  className={`flex size-[28px] shrink-0 items-center justify-center rounded-[10px] ${
                    checked ? 'bg-figma-ink' : 'border-2 border-[#d4d5d8] bg-white'
                  }`}
                >
                  {checked ? (
                    <img src="/figma/check-mark.svg" alt="" className="size-[18px] brightness-0 invert" />
                  ) : null}
                </span>
                <span
                  className="size-[12px] shrink-0 rounded-full"
                  style={{ background: STRATEGY_COLORS[strategy.strategyId] ?? '#272930' }}
                />
                <span className="font-semibold text-[15px] text-figma-ink">{strategyName(strategy.strategyId)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
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
          properties: { engineerId: route.engineerId },
          geometry: {
            type: 'LineString' as const,
            coordinates: segment.points.map((point) => [point.lon, point.lat] as [number, number]),
          },
        })),
    ),
  };
}

function fitRegion(map: maplibregl.Map, nodes: GraphFeature[], region: RegionSelection): void {
  const points = nodes.filter((feature) => region === ALL_REGIONS || feature.properties.region === region);
  if (points.length === 0) return;
  const bounds = new maplibregl.LngLatBounds();
  for (const feature of points) {
    const [lon, lat] = feature.geometry.coordinates;
    bounds.extend([lon, lat]);
  }
  if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 48, maxZoom: 13, duration: 0 });
}
