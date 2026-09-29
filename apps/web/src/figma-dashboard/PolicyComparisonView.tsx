import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useMemo, useState } from 'react';
import { type SimulationResponse, simulateChange } from '../api/client';
import type { LiveWorkday } from '../api/live';
import type {
  DashboardSnapshot,
  PolicyComparisonResponse,
  PolicyComparisonRow,
} from '../api/types';
import { unassignedRequests } from '../domain/dashboard';
import { businessAt } from '../domain/liveClock';
import type { RegionSelection } from '../domain/regions';
import { locale, t } from '../i18n';
import {
  comparisonValue,
  comparisonWinners,
  strategyDescription,
  strategyLabel,
} from '../lib/policyComparison';
import { formatClock, formatDurationMin, formatKm } from '../lib/time';
import { useArtboardStretch } from './artboardStretch';
import { PolicyComparisonOverview } from './PolicyComparisonOverview';
import { type DayRequestPoint, PolicyStrategyMap } from './PolicyStrategyMap';
import { FigmaText } from './primitives';

export const POLICY_PAGE_CAPTION = t('figma-dashboard.PolicyComparisonView.2a62007976');

const COLUMN_ORDER = ['baseline', 'fast', 'compact', 'sla', 'balanced', 'eco', 'covering'] as const;

/**
 * Figma-styled policy comparison for the MAIN artboard.
 * Same numbers as the day-page table; chrome matches the dispatcher mock.
 */
export function PolicyComparisonView({
  snapshot,
  workday,
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
  /** The running day, so «Расчёт» is told on the clock the rest of the board uses. */
  workday?: LiveWorkday | null;
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
  const [mode, setMode] = useState<'overview' | 'table' | 'map'>('overview');
  const [modeDirection, setModeDirection] = useState<1 | -1>(1);
  const [mapRoutes, setMapRoutes] = useState<SimulationResponse | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [mapLoading, setMapLoading] = useState(false);
  const engineerRegionKey = JSON.stringify(
    (snapshot?.engineers ?? []).map((engineer) => [engineer.id, engineer.region ?? '']),
  );
  const engineerRegions = useMemo(() => {
    const pairs = JSON.parse(engineerRegionKey) as readonly (readonly [string, string])[];
    return Object.fromEntries(pairs.filter((pair) => pair[1] !== ''));
  }, [engineerRegionKey]);
  const dayRequests = useMemo(() => dayRequestPoints(snapshot), [snapshot]);

  const comparisonKey = `${comparison?.inputHash ?? ''}:${comparison?.routerContextVersion ?? ''}`;
  useEffect(() => {
    if (mode !== 'map' || !token) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    setMapLoading(true);
    setMapError(null);
    const load = () => {
      void simulateChange(token, { catalog: true })
        .then((result) => {
          if (!active) return;
          if (comparisonKey !== `${result.inputHash}:${result.routerContextVersion}`) {
            setMapError(t('figma-dashboard.PolicyComparisonView.70eba3ac85'));
            return;
          }
          setMapRoutes(result);
          attempts++;
          if (
            attempts < 6 &&
            result.strategies.some((strategy) =>
              strategy.routes.some((route) =>
                route.segments.some(
                  (segment) => segment.travelSource !== 'metro' && segment.points.length === 2,
                ),
              ),
            )
          ) {
            timer = setTimeout(load, 1500);
          }
        })
        .catch((cause: unknown) => {
          if (active)
            setMapError(
              cause instanceof Error
                ? cause.message
                : t('figma-dashboard.PolicyComparisonView.57dae77a8c'),
            );
        })
        .finally(() => {
          if (active) setMapLoading(false);
        });
    };
    load();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
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
  const changeMode = (next: 'overview' | 'table' | 'map') => {
    if (next === mode) return;
    const order = { overview: 0, table: 1, map: 2 } as const;
    setModeDirection(order[next] > order[mode] ? 1 : -1);
    setMode(next);
  };

  return (
    <section
      className="absolute overflow-hidden rounded-[20px] bg-white"
      style={{ left: 180, top: 138, width: 1710 + dx, height: 909 + dy }}
    >
      <div className="absolute inset-x-[30px] top-[30px] flex items-start justify-between">
        <div>
          <FigmaText className="figma-nowrap font-extrabold text-[28px] tracking-[-0.476px] text-figma-ink">
            {t('figma-dashboard.PolicyComparisonView.00e6ded47b')}
          </FigmaText>
          <p className="mt-[8px] font-semibold text-[18px] tracking-[-0.306px] text-figma-muted">
            {POLICY_PAGE_CAPTION}
          </p>
        </div>
        <div className="flex items-center gap-[12px]">
          <fieldset
            className="relative flex h-[67px] items-center rounded-[20px] bg-figma-soft p-[6px]"
            aria-label={t('figma-dashboard.PolicyComparisonView.2eb89a0b1c')}
          >
            <button
              type="button"
              onClick={() => changeMode('overview')}
              aria-pressed={mode === 'overview'}
              className={`relative z-[1] h-[55px] w-[120px] rounded-[16px] font-semibold text-[16px] transition-colors duration-150 ${mode === 'overview' ? 'text-figma-ink' : 'text-figma-muted'}`}
            >
              {mode === 'overview' ? (
                <motion.span
                  layoutId="policy-comparison-tab"
                  className="absolute inset-0 -z-[1] rounded-[16px] bg-white"
                  transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
                />
              ) : null}
              {t('figma-dashboard.PolicyComparisonView.bd3a5be11e')}
            </button>
            <button
              type="button"
              onClick={() => changeMode('table')}
              aria-pressed={mode === 'table'}
              className={`relative z-[1] h-[55px] w-[120px] rounded-[16px] font-semibold text-[16px] transition-colors duration-150 ${mode === 'table' ? 'text-figma-ink' : 'text-figma-muted'}`}
            >
              {mode === 'table' ? (
                <motion.span
                  layoutId="policy-comparison-tab"
                  className="absolute inset-0 -z-[1] rounded-[16px] bg-white"
                  transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
                />
              ) : null}
              {t('figma-dashboard.PolicyComparisonView.b7f18dd0a9')}
            </button>
            <button
              type="button"
              onClick={() => changeMode('map')}
              aria-pressed={mode === 'map'}
              className={`relative z-[1] h-[55px] w-[120px] rounded-[16px] font-semibold text-[16px] transition-colors duration-150 ${mode === 'map' ? 'text-figma-ink' : 'text-figma-muted'}`}
            >
              {mode === 'map' ? (
                <motion.span
                  layoutId="policy-comparison-tab"
                  className="absolute inset-0 -z-[1] rounded-[16px] bg-white"
                  transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
                />
              ) : null}
              {t('figma-dashboard.PolicyComparisonView.2751c91000')}
            </button>
          </fieldset>
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading || readOnly || !snapshot}
            className="flex h-[67px] items-center justify-center rounded-[20px] bg-figma-bee px-[28px] transition-transform duration-150 hover:scale-[1.01] disabled:opacity-50"
          >
            <span className="figma-nowrap font-semibold text-[20px] tracking-[-0.6px] text-figma-ink">
              {loading
                ? t('figma-dashboard.PolicyComparisonView.1369ab27fa')
                : comparison
                  ? t('figma-dashboard.PolicyComparisonView.4d5cff3f67')
                  : t('figma-dashboard.PolicyComparisonView.83b70468cd')}
            </span>
          </button>
        </div>
      </div>

      {comparison ? (
        <div className="absolute left-[30px] top-[118px] flex flex-wrap gap-[8px]">
          <MetaChip
            label={t('figma-dashboard.PolicyComparisonView.5e7ce1b2fa', {
              value0: formatClock(businessAt(comparison.computedAt, workday)),
            })}
          />
          <MetaChip label={t('figma-dashboard.PolicyComparisonView.9e1b808417')} />
          {isStale ? (
            <MetaChip label={t('figma-dashboard.PolicyComparisonView.4a2437795b')} bee />
          ) : null}
        </div>
      ) : null}

      <div className="absolute inset-x-[30px] top-[168px] bottom-[24px] overflow-auto [scrollbar-width:thin]">
        <AnimatePresence initial={false} custom={modeDirection} mode="wait">
          <motion.div
            key={mode}
            custom={modeDirection}
            className="min-h-full"
            initial={motionOn ? { opacity: 0, x: modeDirection > 0 ? '8%' : '-8%' } : false}
            animate={{ opacity: 1, x: 0 }}
            exit={motionOn ? { opacity: 0, x: modeDirection > 0 ? '-8%' : '8%' } : undefined}
            transition={motionOn ? { duration: 0.28, ease: [0.22, 1, 0.36, 1] } : { duration: 0 }}
          >
            {mode === 'map' ? (
              mapLoading ? (
                <div className="flex h-[220px] items-center justify-center rounded-[20px] bg-figma-soft">
                  <p className="font-semibold text-[20px] text-figma-ink">
                    {t('figma-dashboard.PolicyComparisonView.2da7373e8b')}
                  </p>
                </div>
              ) : mapError ? (
                <div className="rounded-[20px] bg-figma-soft px-[24px] py-[20px]">
                  <p className="font-semibold text-[20px] text-figma-danger">
                    {t('figma-dashboard.PolicyComparisonView.516fcb16fb')}
                  </p>
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
                    {t('figma-dashboard.PolicyComparisonView.fc705451df')}
                  </p>
                </div>
              )
            ) : null}
            {mode !== 'map' ? (
              <>
                {error ? (
                  <div className="rounded-[20px] bg-figma-soft px-[24px] py-[20px]">
                    <p className="font-semibold text-[20px] text-figma-danger">
                      {t('figma-dashboard.PolicyComparisonView.32865b0e88')}
                    </p>
                    <p className="mt-[8px] font-medium text-[16px] text-figma-muted">{error}</p>
                  </div>
                ) : null}

                {loading && !comparison ? (
                  <div className="grid grid-cols-3 gap-[16px]">
                    {['a', 'b', 'c', 'd', 'e', 'f'].map((key) => (
                      <div
                        key={key}
                        className="h-[120px] animate-pulse rounded-[20px] bg-figma-soft"
                      />
                    ))}
                  </div>
                ) : null}

                {!loading && !comparison && !error ? (
                  <div className="flex h-[220px] items-center justify-center rounded-[20px] bg-figma-soft px-[30px] text-center">
                    <p className="font-medium text-[18px] text-figma-muted">
                      {readOnly
                        ? t('figma-dashboard.PolicyComparisonView.79bf6d3fac')
                        : t('figma-dashboard.PolicyComparisonView.0c8eb8515e')}
                    </p>
                  </div>
                ) : null}

                {comparison && mode === 'overview' ? (
                  <PolicyComparisonOverview
                    rows={columns}
                    currentPolicyId={snapshot?.policyId ?? null}
                  />
                ) : null}
                {comparison && mode === 'table' ? (
                  <>
                    <p className="mb-[16px] text-[14px] text-figma-muted">
                      {t('figma-dashboard.PolicyComparisonView.266cedd453')}
                    </p>
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
                                {strategyLabel(row.strategyId)}
                              </div>
                              <p className="mt-[8px] font-medium text-[12px] leading-[16px] text-figma-muted">
                                {strategyDescription(row.strategyId)}
                              </p>
                              {!row.isUsable ? (
                                <p className="mt-[6px] font-medium text-[12px] text-figma-danger">
                                  {t('figma-dashboard.PolicyComparisonView.839499a642')}
                                </p>
                              ) : null}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {metricRows.map((metric) => {
                          const best = comparisonWinners(columns, metric.score, metric.better);
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
                  </>
                ) : null}
              </>
            ) : null}
          </motion.div>
        </AnimatePresence>
      </div>
    </section>
  );
}

interface MetricSpec {
  readonly label: string;
  readonly better: 'min' | 'max' | null;
  readonly score: (row: PolicyComparisonRow) => number | null;
  readonly text: (row: PolicyComparisonRow) => string;
}

function orderOf(strategyId: string): number {
  const index = COLUMN_ORDER.indexOf(strategyId as (typeof COLUMN_ORDER)[number]);
  return index < 0 ? COLUMN_ORDER.length : index;
}

/** Shown rows. Green marks the best displayed value; ties stay green together. */
export function comparisonMetrics(recorded: boolean): MetricSpec[] {
  return [
    {
      label: t('figma-dashboard.PolicyComparisonView.a0769f1663'),
      better: 'max',
      score: (row) => row.metrics.assignedCount,
      text: (row) => `${row.metrics.assignedCount}/${row.metrics.requestsTotal}`,
    },
    {
      label: t('figma-dashboard.PolicyComparisonView.6de28b421e'),
      better: 'min',
      score: (row) => row.metrics.unassignedCount,
      text: (row) => String(row.metrics.unassignedCount),
    },
    {
      label: t('figma-dashboard.PolicyComparisonView.db3e6086f2'),
      better: 'max',
      score: (row) => comparisonValue(row, 'onTime'),
      text: (row) => String(comparisonValue(row, 'onTime')),
    },
    {
      label: t('figma-dashboard.PolicyComparisonView.206cadea2e'),
      better: 'max',
      score: (row) => row.metrics.urgentAssignedCount,
      text: (row) => `${row.metrics.urgentAssignedCount}/${row.metrics.urgentTotal}`,
    },
    {
      label: t('figma-dashboard.PolicyComparisonView.960ef88466'),
      better: 'min',
      score: (row) => row.metrics.engineersUsed,
      text: (row) =>
        row.strategyId === 'covering'
          ? `${row.metrics.engineersUsed} (+${row.additionalEngineers ?? 0})`
          : String(row.metrics.engineersUsed),
    },
    {
      label: t('figma-dashboard.PolicyComparisonView.ecf155346f'),
      better: 'min',
      score: (row) => perAssigned(row.metrics.distanceKm, row.metrics.assignedCount),
      text: (row) => formatKmPerAssigned(row.metrics.distanceKm, row.metrics.assignedCount),
    },
    {
      label: t('figma-dashboard.PolicyComparisonView.2dcccaea22'),
      better: 'min',
      score: (row) => perAssigned(row.metrics.travelTimeSec, row.metrics.assignedCount),
      text: (row) =>
        formatDurationPerAssigned(row.metrics.travelTimeSec, row.metrics.assignedCount),
    },
    {
      label: t('figma-dashboard.PolicyComparisonView.5419a37735'),
      better: null,
      score: (row) => perAssigned(row.metrics.workTimeSec, row.metrics.assignedCount),
      text: (row) => formatDurationPerAssigned(row.metrics.workTimeSec, row.metrics.assignedCount),
    },
    {
      label: t('figma-dashboard.PolicyComparisonView.4aaa8bfb65'),
      better: 'min',
      score: (row) => perAssigned(row.metrics.waitingTimeSec, row.metrics.assignedCount),
      text: (row) =>
        formatDurationPerAssigned(row.metrics.waitingTimeSec, row.metrics.assignedCount),
    },
    {
      label: t('figma-dashboard.PolicyComparisonView.6a21d0cce3'),
      better: 'min',
      score: (row) => perAssigned(row.metrics.lateAssignedCount, row.metrics.assignedCount),
      text: (row) =>
        formatCountPerAssigned(row.metrics.lateAssignedCount, row.metrics.assignedCount),
    },
    {
      label: t('figma-dashboard.PolicyComparisonView.15f6401442'),
      better: 'min',
      score: (row) => perAssigned(row.metrics.totalLatenessSec, row.metrics.assignedCount),
      text: (row) =>
        formatDurationPerAssigned(row.metrics.totalLatenessSec, row.metrics.assignedCount),
    },
    {
      label: t('figma-dashboard.PolicyComparisonView.2a81b8992a'),
      better: 'min',
      score: (row) => displayKm(row.metrics.distanceKm),
      text: (row) => formatKm(row.metrics.distanceKm),
    },
    {
      label: t('figma-dashboard.PolicyComparisonView.99ff703b11'),
      better: 'min',
      score: (row) => row.metrics.travelTimeSec,
      text: (row) => formatDurationMin(row.metrics.travelTimeSec),
    },
    {
      label: t('figma-dashboard.PolicyComparisonView.8a2a97863d'),
      better: null,
      score: (row) => row.metrics.workTimeSec,
      text: (row) => formatDurationMin(row.metrics.workTimeSec),
    },
    {
      label: t('figma-dashboard.PolicyComparisonView.80a1c8a7e0'),
      better: 'min',
      score: (row) => row.metrics.waitingTimeSec,
      text: (row) => formatDurationMin(row.metrics.waitingTimeSec),
    },
    {
      label: t('figma-dashboard.PolicyComparisonView.1810b2784f'),
      better: 'min',
      score: (row) => row.metrics.lateAssignedCount,
      text: (row) => String(row.metrics.lateAssignedCount),
    },
    {
      label: t('figma-dashboard.PolicyComparisonView.749034fcd1'),
      better: 'min',
      score: (row) => row.metrics.totalLatenessSec,
      text: (row) => formatDurationMin(row.metrics.totalLatenessSec),
    },
    {
      label: t('figma-dashboard.PolicyComparisonView.923373d35b'),
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
      label: t('figma-dashboard.PolicyComparisonView.2033203a89'),
      better: 'min',
      score: (row) => Math.round(row.metrics.workloadSpreadSec / 60),
      text: (row) => formatDurationMin(row.metrics.workloadSpreadSec),
    },
    {
      label: t('figma-dashboard.PolicyComparisonView.b3ae4c0025'),
      better: null,
      score: (row) => (recorded ? null : Math.round(row.calculationMs)),
      text: (row) =>
        recorded
          ? t('figma-dashboard.PolicyComparisonView.b91237d074')
          : t('figma-dashboard.PolicyComparisonView.2337013f83', {
              value0: Math.round(row.calculationMs),
            }),
    },
  ];
}

function displayKm(km: number): number {
  return km >= 10 ? Math.round(km) : Math.round(km * 10) / 10;
}

/** A missing denominator is not a zero-cost route and must not win a comparison. */
export function perAssigned(value: number, assignedCount: number): number | null {
  return assignedCount > 0 ? value / assignedCount : null;
}

function unavailablePerAssigned(assignedCount: number): string | null {
  return assignedCount > 0 ? null : t('figma-dashboard.PolicyComparisonView.abef1b5174');
}

export function formatKmPerAssigned(distanceKm: number, assignedCount: number): string {
  const unavailable = unavailablePerAssigned(assignedCount);
  return (
    unavailable ??
    t('figma-dashboard.PolicyComparisonView.9fc77f1fdb', {
      value0: formatKm(distanceKm / assignedCount),
    })
  );
}

function formatDurationPerAssigned(durationSec: number, assignedCount: number): string {
  const unavailable = unavailablePerAssigned(assignedCount);
  return (
    unavailable ??
    t('figma-dashboard.PolicyComparisonView.9fc77f1fdb', {
      value0: formatDurationMin(durationSec / assignedCount),
    })
  );
}

function formatCountPerAssigned(count: number, assignedCount: number): string {
  const unavailable = unavailablePerAssigned(assignedCount);
  return (
    unavailable ??
    t('figma-dashboard.PolicyComparisonView.9fc77f1fdb', {
      value0: (count / assignedCount).toLocaleString(locale, { maximumFractionDigits: 2 }),
    })
  );
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
