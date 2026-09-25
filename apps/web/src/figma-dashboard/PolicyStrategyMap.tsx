import maplibregl from 'maplibre-gl';
import { useEffect, useRef } from 'react';
import type { SimulationResponse } from '../api/client';
import { localMapStyle } from '../domain/localBasemap';
import type { StrategyId } from '../api/types';
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

/**
 * All simulated strategies on one map inside the policy tab.
 * Line color is the strategy, including metro, road, straight and API pieces.
 */
export function PolicyStrategyMap({
  strategies,
}: {
  strategies: SimulationResponse['strategies'];
}) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = host.current;
    if (!node) return;
    const map = new maplibregl.Map({
      container: node,
      style: localMapStyle(),
      center: [37.72, 55.72],
      zoom: 11,
      attributionControl: false,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.on('load', () => {
      const bounds = new maplibregl.LngLatBounds();
      let drawn = 0;
      strategies.forEach((strategy, index) => {
        const color = STRATEGY_COLORS[strategy.strategyId] ?? '#727478';
        const features = strategy.routes.flatMap((route) =>
          route.segments
            .filter((segment) => segment.points.length >= 2)
            .map((segment) => ({
              type: 'Feature' as const,
              properties: { strategyId: strategy.strategyId },
              geometry: {
                type: 'LineString' as const,
                coordinates: segment.points.map((point) => [point.lon, point.lat] as [number, number]),
              },
            })),
        );
        for (const feature of features) {
          for (const pair of feature.geometry.coordinates) bounds.extend(pair);
        }
        if (features.length === 0) return;
        drawn += 1;
        map.addSource(`strategy-${index}`, {
          type: 'geojson',
          data: { type: 'FeatureCollection', features },
        });
        map.addLayer({
          id: `strategy-${index}`,
          type: 'line',
          source: `strategy-${index}`,
          paint: {
            'line-color': color,
            'line-width': strategy.strategyId === 'baseline' ? 2 : 3,
            'line-opacity': 0.9,
          },
        });
      });
      if (drawn > 0 && !bounds.isEmpty()) map.fitBounds(bounds, { padding: 48, maxZoom: 14 });
    });
    return () => map.remove();
  }, [strategies]);

  return (
    <div className="flex h-full min-h-[520px] gap-[16px]">
      <div ref={host} className="min-w-0 flex-1 overflow-hidden rounded-[20px]" />
      <ul className="flex w-[220px] shrink-0 flex-col gap-[10px]">
        {strategies.map((strategy) => (
          <li key={strategy.strategyId} className="flex items-center gap-[8px]">
            <span
              className="size-[12px] rounded-full"
              style={{ backgroundColor: STRATEGY_COLORS[strategy.strategyId] ?? '#727478' }}
            />
            <span className="font-semibold text-[14px] text-figma-ink">
              {strategyName(strategy.strategyId)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
