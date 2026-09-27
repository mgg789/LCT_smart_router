import { motion } from 'framer-motion';
import { useEffect, useMemo, useRef, useState } from 'react';
import { type SimulationResponse, simulateChange } from '../api/client';
import type {
  DashboardSnapshot,
  PolicyComparisonResponse,
  PolicyComparisonRow,
} from '../api/types';
import { unassignedRequests } from '../domain/dashboard';
import type { RegionSelection } from '../domain/regions';
import { strategyDescription } from '../lib/policyComparison';
import { formatClock, formatDurationMin, formatKm } from '../lib/time';
import { useArtboardStretch } from './artboardStretch';
import { type DayRequestPoint, PolicyStrategyMap } from './PolicyStrategyMap';
import { FigmaText } from './primitives';

export const POLICY_PAGE_CAPTION = 'Одинаковые заявки и дорожные условия';

const COLUMN_ORDER = ['baseline', 'fast', 'compact', 'sla', 'balanced', 'eco', 'covering'] as const;

const SHORT_NAME: Record<string, string> = {
  baseline: 'FIFO (базовое)',
  fast: 'Быстрее',
  compact: 'Дешевле',
  sla: 'По окнам',
  balanced: 'Ровнее загрузка',
  eco: 'Короче пробег',
  covering: 'Полное покрытие',
};

/**
 * Figma-styled policy comparison for the MAIN artboard.
 * Same numbers as the day-page table; chrome matches the dispatcher mock.
 */
export function PolicyComparisonView({
  snapshot,
  comparison,
  loading,
  error,
  recorded,
  readOnly,
  token,
  onRefresh,
  regions,
  selectedRegion,
  motionOn,
}: {
  snapshot: DashboardSnapshot | null;
  comparison: PolicyComparisonResponse | null;
  loading: boolean;
  error: string | null;
  recorded: boolean;
  readOnly: boolean;
  token: string | null;
  onRefresh: () => void;
  regions: { id: RegionSelection; label: string }[];
  selectedRegion: RegionSelection;
  motionOn: boolean;
}) {
  const { dx, dy } = useArtboardStretch();
  const [mode, setMode] = useState<'table' | 'map'>('table');
  const [mapRoutes, setMapRoutes] = useState<SimulationResponse | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [mapLoading, setMapLoading] = useState(false);
  const mapRoutesRef = useRef<SimulationResponse | null>(null);
  const engineerRegionKey = JSON.stringify(
    (snapshot?.engineers ?? []).map((engineer) => [engineer.id, engineer.region ?? '']),
  );
  const engineerRegions = useMemo(() => {
    const pairs = JSON.parse(engineerRegionKey) as readonly (readonly [string, string])[];
    return Object.fromEntries(pairs.filter((pair) => pair[1] !== ''));
  }, [engineerRegionKey]);
  const dayRequests = useMemo(() => dayRequestPoints(snapshot), [snapshot]);

  const comparisonKey = `${comparison?.inputHash ?? ''}:${comparison?.routerContextVersion ?? ''}`;
  // comparisonKey is not an argument of the catalog call. It refetches the map when the snapshot under the table changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch trigger, not an input of simulateChange
  useEffect(() => {
    if (mode !== 'map' || !token) return;
    let active = true;
    if (!mapRoutesRef.current) setMapLoading(true);
    setMapError(null);
    void simulateChange(token, { catalog: true })
      .then((result) => {
        if (!active) return;
        mapRoutesRef.current = result;
        setMapRoutes(result);
      })
      .catch((cause: unknown) => {
        if (active)
          setMapError(cause instanceof Error ? cause.message : 'Не удалось построить карту');
      })
      .finally(() => {
        if (active) setMapLoading(false);
      });
    return () => {
      active = false;
    };
  }, [mode, token, comparisonKey]);
  const appliedInputHash = snapshot?.plan.appliedResult?.inputHash ?? null;
  const isStale =
    comparison !== null &&
    snapshot !== null &&
    (comparison.routerContextVersion !== snapshot.routerContextVersion ||
      (appliedInputHash !== null && comparison.inputHash !== appliedInputHash));
  const columns = comparison
    ? [...comparison.rows].sort(
        (left, right) => orderOf(left.strategyId) - orderOf(right.strategyId),
      )
    : [];
  const metricRows = comparisonMetrics(recorded);

  return (
    <section
      className="absolute overflow-hidden rounded-[20px] bg-white"
      style={{ left: 180, top: 138, width: 1710 + dx, height: 909 + dy }}
    >
      <div className="absolute inset-x-[30px] top-[30px] flex items-start justify-between">
        <div>
          <FigmaText className="figma-nowrap font-extrabold text-[28px] tracking-[-0.476px] text-figma-ink">
            Сравнение политик
          </FigmaText>
          <p className="mt-[8px] font-semibold text-[18px] tracking-[-0.306px] text-figma-muted">
            {POLICY_PAGE_CAPTION}
          </p>
        </div>
        <div className="flex items-center gap-[12px]">
          <div className="relative flex h-[67px] items-center rounded-[20px] bg-figma-soft p-[6px]">
            <motion.span
              aria-hidden
              className="absolute top-[6px] bottom-[6px] w-[calc(50%-6px)] rounded-[16px] bg-white"
              initial={false}
              animate={{ left: mode === 'table' ? 6 : 'calc(50%)' }}
              transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
            />
            <button
              type="button"
              onClick={() => setMode('table')}
              className={`relative z-[1] h-[55px] w-[120px] rounded-[16px] font-semibold text-[16px] ${mode === 'table' ? 'text-figma-ink' : 'text-figma-muted'}`}
            >
              Таблица
            </button>
            <button
              type="button"
              onClick={() => setMode('map')}
              className={`relative z-[1] h-[55px] w-[120px] rounded-[16px] font-semibold text-[16px] ${mode === 'map' ? 'text-figma-ink' : 'text-figma-muted'}`}
            >
              Карта
            </button>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading || readOnly || !snapshot}
            className="flex h-[67px] items-center justify-center rounded-[20px] bg-figma-bee px-[28px] transition-transform duration-150 hover:scale-[1.01] disabled:opacity-50"
          >
            <span className="figma-nowrap font-semibold text-[20px] tracking-[-0.6px] text-figma-ink">
              {loading ? 'Считаем…' : comparison ? 'Пересчитать' : 'Сравнить'}
            </span>
          </button>
        </div>
      </div>

      {comparison ? (
        <div className="absolute left-[30px] top-[118px] flex flex-wrap gap-[8px]">
          <MetaChip label={`Снимок ${comparison.inputPublicationId}`} />
          <MetaChip label={`Расчёт ${formatClock(comparison.computedAt)}`} />
          <MetaChip label={`Бюджет поиска ${comparison.searchBudgetMs} мс на политику`} />
          {isStale ? <MetaChip label="План уже изменился — пересчитайте сравнение" bee /> : null}
        </div>
      ) : null}

      <div className="absolute inset-x-[30px] top-[168px] bottom-[24px] overflow-auto [scrollbar-width:thin]">
        {mode === 'map' ? (
          mapLoading ? (
            <div className="flex h-[220px] items-center justify-center rounded-[20px] bg-figma-soft">
              <p className="font-semibold text-[20px] text-figma-ink">Считаем</p>
            </div>
          ) : mapError ? (
            <div className="rounded-[20px] bg-figma-soft px-[24px] py-[20px]">
              <p className="font-semibold text-[20px] text-figma-danger">Карта не загрузилась</p>
              <p className="mt-[8px] font-medium text-[16px] text-figma-muted">{mapError}</p>
            </div>
          ) : mapRoutes && mapRoutes.strategies.length > 0 ? (
            <PolicyStrategyMap
              requests={dayRequests}
              strategies={mapRoutes.strategies}
              regions={regions}
              selectedRegion={selectedRegion}
              engineerRegions={engineerRegions}
              motionOn={motionOn}
            />
          ) : (
            <div className="flex h-[220px] items-center justify-center rounded-[20px] bg-figma-soft px-[30px] text-center">
              <p className="font-medium text-[18px] text-figma-muted">
                На карте появятся все стратегии сразу. Рабочий план при этом не меняется.
              </p>
            </div>
          )
        ) : null}
        {mode === 'table' ? (
          <>
            {error ? (
              <div className="rounded-[20px] bg-figma-soft px-[24px] py-[20px]">
                <p className="font-semibold text-[20px] text-figma-danger">
                  Сравнение не загрузилось
                </p>
                <p className="mt-[8px] font-medium text-[16px] text-figma-muted">{error}</p>
              </div>
            ) : null}

            {loading && !comparison ? (
              <div className="grid grid-cols-3 gap-[16px]">
                {['a', 'b', 'c', 'd', 'e', 'f'].map((key) => (
                  <div key={key} className="h-[120px] animate-pulse rounded-[20px] bg-figma-soft" />
                ))}
              </div>
            ) : null}

            {!loading && !comparison && !error ? (
              <div className="flex h-[220px] items-center justify-center rounded-[20px] bg-figma-soft px-[30px] text-center">
                <p className="font-medium text-[18px] text-figma-muted">
                  {readOnly
                    ? 'Новое сравнение станет доступно после восстановления связи.'
                    : 'Запустите сравнение. Активный план и выбранная политика при этом не изменятся.'}
                </p>
              </div>
            ) : null}

            {comparison ? (
              <table className="w-full min-w-[1280px] border-separate border-spacing-0 text-left">
                <thead>
                  <tr>
                    <th className="sticky left-0 z-[1] w-[160px] bg-white" />
                    {columns.map((row) => (
                      <th
                        key={row.strategyId}
                        className="min-w-[168px] px-[12px] pb-[18px] align-top"
                      >
                        <div className="font-semibold text-[16px] tracking-[-0.2px] text-figma-ink">
                          {SHORT_NAME[row.strategyId] ?? row.strategyId}
                        </div>
                        <p className="mt-[8px] font-medium text-[12px] leading-[16px] text-figma-muted">
                          {strategyDescription(row.strategyId)}
                        </p>
                        {!row.isUsable ? (
                          <p className="mt-[6px] font-medium text-[12px] text-figma-danger">
                            План непригоден
                          </p>
                        ) : null}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {metricRows.map((metric) => {
                    const best = winners(columns, metric);
                    return (
                      <tr key={metric.label}>
                        <th className="sticky left-0 z-[1] bg-white py-[12px] pr-[12px] text-left font-semibold text-[14px] text-figma-muted">
                          {metric.label}
                        </th>
                        {columns.map((row) => {
                          const green = best.has(row.strategyId);
                          return (
                            <td
                              key={row.strategyId}
                              className={`border-t border-[#ececec] px-[12px] py-[12px] text-[15px] ${
                                green
                                  ? 'font-semibold text-[#15803d]'
                                  : 'font-medium text-figma-ink'
                              }`}
                            >
                              {metric.text(row)}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  );
}

interface MetricSpec {
  readonly label: string;
  readonly better: 'min' | 'max';
  readonly score: (row: PolicyComparisonRow) => number | null;
  readonly text: (row: PolicyComparisonRow) => string;
}

function orderOf(strategyId: string): number {
  const index = COLUMN_ORDER.indexOf(strategyId as (typeof COLUMN_ORDER)[number]);
  return index < 0 ? COLUMN_ORDER.length : index;
}

/** Shown rows. Green marks the best displayed value; ties stay green together. */
function comparisonMetrics(recorded: boolean): MetricSpec[] {
  return [
    {
      label: 'Назначено',
      better: 'max',
      score: (row) => row.metrics.assignedCount,
      text: (row) => `${row.metrics.assignedCount}/${row.metrics.requestsTotal}`,
    },
    {
      label: 'Без назначения',
      better: 'min',
      score: (row) => row.metrics.unassignedCount,
      text: (row) => String(row.metrics.unassignedCount),
    },
    {
      label: 'Срочные',
      better: 'max',
      score: (row) => row.metrics.urgentAssignedCount,
      text: (row) => `${row.metrics.urgentAssignedCount}/${row.metrics.urgentTotal}`,
    },
    {
      label: 'Инженеры',
      better: 'min',
      score: (row) => row.metrics.engineersUsed,
      text: (row) =>
        row.strategyId === 'covering'
          ? `${row.metrics.engineersUsed} (+${row.additionalEngineers ?? 0})`
          : String(row.metrics.engineersUsed),
    },
    {
      label: 'Пробег',
      better: 'min',
      score: (row) => displayKm(row.metrics.distanceKm),
      text: (row) => formatKm(row.metrics.distanceKm),
    },
    {
      label: 'Дорога',
      better: 'min',
      score: (row) => Math.round(row.metrics.travelTimeSec / 60),
      text: (row) => formatDurationMin(row.metrics.travelTimeSec),
    },
    {
      label: 'Работы',
      better: 'min',
      score: (row) => Math.round(row.metrics.workTimeSec / 60),
      text: (row) => formatDurationMin(row.metrics.workTimeSec),
    },
    {
      label: 'Ожидание',
      better: 'min',
      score: (row) => Math.round(row.metrics.waitingTimeSec / 60),
      text: (row) => formatDurationMin(row.metrics.waitingTimeSec),
    },
    {
      label: 'Опоздания',
      better: 'min',
      score: (row) => row.metrics.lateAssignedCount,
      text: (row) => String(row.metrics.lateAssignedCount),
    },
    {
      label: 'Сумма опозданий',
      better: 'min',
      score: (row) => Math.round(row.metrics.totalLatenessSec / 60),
      text: (row) => formatDurationMin(row.metrics.totalLatenessSec),
    },
    {
      label: 'Запас окна',
      better: 'max',
      score: (row) =>
        row.metrics.minWindowSlackSec === null
          ? null
          : Math.round(row.metrics.minWindowSlackSec / 60),
      text: (row) =>
        row.metrics.minWindowSlackSec === null
          ? '—'
          : formatDurationMin(row.metrics.minWindowSlackSec),
    },
    {
      label: 'Разброс загрузки',
      better: 'min',
      score: (row) => Math.round(row.metrics.workloadSpreadSec / 60),
      text: (row) => formatDurationMin(row.metrics.workloadSpreadSec),
    },
    {
      label: 'Расчёт',
      better: 'min',
      score: (row) => (recorded ? null : Math.round(row.calculationMs)),
      text: (row) => (recorded ? 'не замерено' : `${Math.round(row.calculationMs)} мс`),
    },
  ];
}

function displayKm(km: number): number {
  return km >= 10 ? Math.round(km) : Math.round(km * 10) / 10;
}

function winners(columns: PolicyComparisonRow[], metric: MetricSpec): Set<string> {
  const scored = columns
    .filter((row) => row.isUsable)
    .map((row) => ({ id: row.strategyId, value: metric.score(row) }))
    .filter(
      (item): item is { id: PolicyComparisonRow['strategyId']; value: number } =>
        item.value !== null,
    );
  if (scored.length === 0) return new Set();
  const target =
    metric.better === 'min'
      ? Math.min(...scored.map((item) => item.value))
      : Math.max(...scored.map((item) => item.value));
  return new Set(scored.filter((item) => item.value === target).map((item) => item.id));
}

/**
 * The same dots the day-plan map draws: jobs already on a route, plus today's
 * unassigned requests. Road-graph vertices stay off this map.
 */
function dayRequestPoints(snapshot: DashboardSnapshot | null): DayRequestPoint[] {
  if (!snapshot) return [];
  const byId = new Map(snapshot.requests.map((request) => [request.id, request]));
  const ids = new Set<string>();
  for (const route of snapshot.plan.plan?.routes ?? []) {
    for (const stop of route.stops) {
      if (stop.requestId) ids.add(stop.requestId);
    }
  }
  for (const request of unassignedRequests(snapshot)) ids.add(request.id);
  const points: DayRequestPoint[] = [];
  for (const id of ids) {
    const request = byId.get(id);
    if (!request || request.lat == null || request.lon == null) continue;
    if (request.lifecycle === 'cancelled') continue;
    points.push({
      id: request.id,
      lat: request.lat,
      lon: request.lon,
      region: request.region ?? '',
    });
  }
  return points;
}

function MetaChip({ label, bee = false }: { label: string; bee?: boolean }) {
  return (
    <span
      className={`rounded-[20px] px-[14px] py-[8px] font-medium text-[14px] ${
        bee ? 'bg-figma-bee text-figma-ink' : 'bg-figma-soft text-figma-muted'
      }`}
    >
      {label}
    </span>
  );
}
