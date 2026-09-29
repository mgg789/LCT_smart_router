import { useLayoutEffect, useRef, useState } from 'react';
import type { PolicyComparisonRow } from '../api/types';
import { locale, t } from '../i18n';
import { formatClock } from '../lib/time';
import { STRATEGY_COLORS } from './PolicyStrategyMap';
import {
  type ComparisonMeasure,
  comparisonValue,
  comparisonWinners,
  percentVsFifo,
  strategyLabel,
  usesReserve,
} from '../lib/policyComparison';

const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
const COST_MEASURES = {
  kmPerJob: {
    title: t('figma-dashboard.PolicyComparisonOverview.f3e54f1960'),
    unit: t('figma-dashboard.PolicyComparisonOverview.9260e2abae'),
    description: t('figma-dashboard.PolicyComparisonOverview.1c434aa797'),
  },
  travelPerJob: {
    title: t('figma-dashboard.PolicyComparisonOverview.a95f50fd31'),
    unit: t('figma-dashboard.PolicyComparisonOverview.62dcfe2d4d'),
    description: t('figma-dashboard.PolicyComparisonOverview.a3d76fe885'),
  },
  waitingPerJob: {
    title: t('figma-dashboard.PolicyComparisonOverview.a3b61060dc'),
    unit: t('figma-dashboard.PolicyComparisonOverview.62dcfe2d4d'),
    description: t('figma-dashboard.PolicyComparisonOverview.0fed68e70b'),
  },
  latenessPerJob: {
    title: t('figma-dashboard.PolicyComparisonOverview.5fe3b6c118'),
    unit: t('figma-dashboard.PolicyComparisonOverview.62dcfe2d4d'),
    description: t('figma-dashboard.PolicyComparisonOverview.908a33608e'),
  },
} as const;
const LATE_SHARE_MEASURE = {
  title: t('figma-dashboard.PolicyComparisonOverview.30a56ccd78'),
  unit: '%',
  description: t('figma-dashboard.PolicyComparisonOverview.973fb89f11'),
} as const;
type CostMeasure = keyof typeof COST_MEASURES;

/** Coverage, travel, lateness and staffing comparisons with the same FIFO reference. */
export function PolicyComparisonOverview({
  rows,
  currentPolicyId = null,
}: {
  rows: readonly PolicyComparisonRow[];
  currentPolicyId?: string | null;
}) {
  const [measure, setMeasure] = useState<CostMeasure>('kmPerJob');
  const [includeReserve, setIncludeReserve] = useState(false);
  const reserveToggle = useRef<HTMLLabelElement>(null);
  const scrollAnchor = useRef<{ container: HTMLElement; top: number; scale: number } | null>(null);
  useLayoutEffect(() => {
    const anchor = scrollAnchor.current;
    scrollAnchor.current = null;
    if (!anchor || !reserveToggle.current) return;
    // Artboard transforms scale viewport pixels, while scrollTop uses layout pixels.
    anchor.container.scrollTop +=
      (reserveToggle.current.getBoundingClientRect().top - anchor.top) / anchor.scale;
  });
  const toggleReserve = (checked: boolean) => {
    const label = reserveToggle.current;
    let container = label?.parentElement ?? null;
    while (container && !/(auto|scroll)/.test(getComputedStyle(container).overflowY)) {
      container = container.parentElement;
    }
    if (label && container) {
      scrollAnchor.current = {
        container,
        top: label.getBoundingClientRect().top,
        scale:
          container.offsetHeight > 0
            ? container.getBoundingClientRect().height / container.offsetHeight || 1
            : 1,
      };
    }
    setIncludeReserve(checked);
  };
  const fixed = rows.filter((row) => row.isUsable && !usesReserve(row));
  const visible = rows.filter((row) => includeReserve || !usesReserve(row));
  const fifo = rows.find((row) => row.strategyId === 'baseline' && row.isUsable);
  const policies = fixed.filter((row) => row.kind === 'policy');
  const reserve = rows.find(usesReserve);
  const bestCount = policies.length
    ? Math.max(...policies.map((row) => row.metrics.assignedCount))
    : null;
  const higherCoverageWithMoreKm =
    fifo && bestCount !== null
      ? policies.find(
          (row) =>
            row.metrics.assignedCount === bestCount &&
            row.metrics.assignedCount > fifo.metrics.assignedCount &&
            row.metrics.distanceKm > fifo.metrics.distanceKm,
        )
      : null;
  const bestOnTime = policies.length
    ? Math.max(...policies.map((row) => comparisonValue(row, 'onTime') ?? 0))
    : null;
  const costValues = policies.flatMap((row) => {
    const value = comparisonValue(row, 'kmPerJob');
    return value === null ? [] : [value];
  });
  const bestCost = costValues.length ? Math.min(...costValues) : null;
  const fingerprints = new Set(policies.map((row) => JSON.stringify(row.metrics)));
  return (
    <div className="space-y-[24px]">
      <div className="grid grid-cols-1 gap-[16px] md:grid-cols-3">
        <Insight
          title={t('figma-dashboard.PolicyComparisonOverview.0d520b0337')}
          value={
            bestCount === null
              ? '—'
              : t('figma-dashboard.PolicyComparisonOverview.1521c1e474', {
                  value0: bestCount,
                  value1: fifo?.metrics.requestsTotal ?? rows[0]?.metrics.requestsTotal ?? 0,
                })
          }
          note={
            bestCount !== null && fifo
              ? t('figma-dashboard.PolicyComparisonOverview.d50f1665b8', {
                  value0: signed(bestCount - fifo.metrics.assignedCount),
                })
              : t('figma-dashboard.PolicyComparisonOverview.4acca0e764')
          }
        />
        <Insight
          title={t('figma-dashboard.PolicyComparisonOverview.c3f381ba3e')}
          value={bestOnTime === null ? '—' : String(bestOnTime)}
          note={
            bestOnTime !== null && fifo
              ? t('figma-dashboard.PolicyComparisonOverview.b48213a706', {
                  value0: signed(bestOnTime - (comparisonValue(fifo, 'onTime') ?? 0)),
                })
              : t('figma-dashboard.PolicyComparisonOverview.d241ce383e')
          }
        />
        <Insight
          title={t('figma-dashboard.PolicyComparisonOverview.434c7863be')}
          value={
            bestCost === null
              ? '—'
              : t('figma-dashboard.PolicyComparisonOverview.06f7f314d2', {
                  value0: number.format(bestCost),
                })
          }
          note={t('figma-dashboard.PolicyComparisonOverview.ec1eb520cd', {
            value0: percentVsFifo(bestCost, fifo ? comparisonValue(fifo, 'kmPerJob') : null) ?? '—',
          })}
        />
      </div>
      <p className="text-[15px] leading-[22px] text-figma-muted">
        {t('figma-dashboard.PolicyComparisonOverview.3ca6e830ad')}
        {fingerprints.size === 1 && policies.length > 1
          ? t('figma-dashboard.PolicyComparisonOverview.42a0a48819')
          : ''}
      </p>
      {higherCoverageWithMoreKm && fifo ? (
        <p className="text-[15px] leading-[22px] text-figma-muted">
          {t('figma-dashboard.PolicyComparisonOverview.coverageDistanceNote', {
            value0: higherCoverageWithMoreKm.metrics.assignedCount,
            value1: fifo.metrics.assignedCount,
          })}
        </p>
      ) : null}
      <div className="grid grid-cols-1 gap-[20px] lg:grid-cols-2">
        <ComparisonBars
          rows={visible}
          measure="assigned"
          title={t('figma-dashboard.PolicyComparisonOverview.e6aec5423d')}
          unit={t('figma-dashboard.PolicyComparisonOverview.a2f012e5ff')}
          description={t('figma-dashboard.PolicyComparisonOverview.bcb32d2cc5')}
          better="max"
        />
        <section className="rounded-[20px] bg-figma-soft p-[24px]">
          <label className="mb-[20px] flex flex-wrap items-center justify-between gap-[12px] text-[16px] font-semibold text-figma-ink">
            {t('figma-dashboard.PolicyComparisonOverview.0d89a756e7')}
            <select
              aria-label={t('figma-dashboard.PolicyComparisonOverview.77d92ec767')}
              className="rounded-[12px] border border-figma-muted/25 bg-white px-[12px] py-[8px] text-[14px]"
              value={measure}
              onChange={(event) => {
                const value = event.target.value;
                if (
                  value === 'kmPerJob' ||
                  value === 'travelPerJob' ||
                  value === 'waitingPerJob' ||
                  value === 'latenessPerJob'
                )
                  setMeasure(value);
              }}
            >
              <option value="kmPerJob">
                {t('figma-dashboard.PolicyComparisonOverview.15fa5c93d1')}
              </option>
              <option value="travelPerJob">
                {t('figma-dashboard.PolicyComparisonOverview.b6410ff46e')}
              </option>
              <option value="waitingPerJob">
                {t('figma-dashboard.PolicyComparisonOverview.4aaa8bfb65')}
              </option>
              <option value="latenessPerJob">
                {t('figma-dashboard.PolicyComparisonOverview.15f6401442')}
              </option>
            </select>
          </label>
          <ComparisonBars
            rows={visible}
            measure={measure}
            {...COST_MEASURES[measure]}
            better="min"
            nested
          />
        </section>
        <ComparisonBars rows={visible} measure="lateShare" {...LATE_SHARE_MEASURE} better="min" />
        <ComparisonBars
          rows={visible}
          measure="engineers"
          title={t('figma-dashboard.PolicyComparisonOverview.030f23496b')}
          unit={t('figma-dashboard.PolicyComparisonOverview.05a74c80c0')}
          description={t('figma-dashboard.PolicyComparisonOverview.e1f1918822')}
          better="min"
        />
        <CompletionChart
          rows={rows.filter((row) => {
            if (!row.isUsable) return false;
            if (usesReserve(row)) return includeReserve || currentPolicyId === 'covering';
            return true;
          })}
        />
      </div>
      {reserve ? (
        <label
          ref={reserveToggle}
          className="flex cursor-pointer items-center gap-[12px] rounded-[16px] border border-figma-muted/20 p-[18px] text-[15px] text-figma-ink"
        >
          <input
            type="checkbox"
            checked={includeReserve}
            onChange={(event) => toggleReserve(event.target.checked)}
            className="peer sr-only"
          />
          <span
            aria-hidden="true"
            className={`flex size-[28px] shrink-0 items-center justify-center rounded-[10px] peer-focus-visible:ring-2 peer-focus-visible:ring-figma-ink peer-focus-visible:ring-offset-2 ${
              includeReserve ? 'bg-figma-ink' : 'border-2 border-[#d4d5d8] bg-white'
            }`}
          >
            {includeReserve ? (
              <img src="/figma/check-mark.svg" alt="" className="size-[18px] brightness-0 invert" />
            ) : null}
          </span>
          <span>
            {t('figma-dashboard.PolicyComparisonOverview.8c4b2e06c5')}
            {reserve.additionalEngineers}
            {t('figma-dashboard.PolicyComparisonOverview.76a0834199')}
          </span>
        </label>
      ) : null}
    </div>
  );
}

/** Plot height is 2.5× the first 180px chart so close policies separate. */
const CHART_HEIGHT = 450;
/** Each completion rises over about half an hour instead of a vertical step. */
const SMOOTH_SIGMA_SEC = 12 * 60;

/**
 * Smooth cumulative completions.
 *
 * A raw series jumps by one at every job end, so close policies draw on top of
 * each other as stairs. Each end contributes a normal rise of `sigma` seconds.
 * The result stays between 0 and the job count and never decreases.
 */
function smoothedCount(times: readonly number[], at: number, sigma: number): number {
  let total = 0;
  for (const end of times) total += normalCdf((at - end) / sigma);
  return total;
}

/** Abramowitz-Stegun approximation of the error function, enough for a chart. */
function erf(value: number): number {
  const sign = Math.sign(value);
  const abs = Math.abs(value);
  const t = 1 / (1 + 0.3275911 * abs);
  const polynomial =
    (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t);
  return sign * (1 - polynomial * Math.exp(-abs * abs));
}

function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

function CompletionChart({ rows }: { rows: readonly PolicyComparisonRow[] }) {
  const host = useRef<HTMLDivElement>(null);
  const [plotWidth, setPlotWidth] = useState(960);
  const halfHour = 30 * 60;
  const ends = rows.flatMap((row) => row.jobEnds ?? []);
  useLayoutEffect(() => {
    const node = host.current;
    if (!node) return;
    const apply = () => setPlotWidth(Math.max(480, Math.floor(node.clientWidth)));
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ends.length]);
  const origin = ends.length ? Math.floor(Math.min(...ends) / halfHour) * halfHour : 0;
  const finish = ends.length ? Math.ceil(Math.max(...ends) / halfHour) * halfHour : origin + halfHour;
  const span = Math.max(halfHour, finish - origin);
  const ticks: number[] = [];
  for (let at = origin; at <= finish; at += halfHour) ticks.push(at);
  const maxCount = Math.max(1, ...rows.map((row) => (row.jobEnds ?? []).length));
  const width = plotWidth;
  const height = CHART_HEIGHT;
  const padLeft = 28;
  const padRight = 28;
  const padTop = 16;
  const padBottom = 32;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;
  const xOf = (at: number) => padLeft + ((at - origin) / span) * plotW;
  const yOf = (count: number) => padTop + plotH - (count / maxCount) * plotH;
  return (
    <section className="w-full rounded-[20px] bg-figma-soft p-[24px] lg:col-span-2">
      <p className="text-[16px] font-semibold text-figma-ink">
        {t('figma-dashboard.PolicyComparisonOverview.completionChart')}
      </p>
      <p className="mt-[4px] mb-[12px] text-[14px] text-figma-muted">
        {t('figma-dashboard.PolicyComparisonOverview.completionChartNote')}
      </p>
      {ends.length === 0 ? (
        <p className="text-[14px] text-figma-muted">
          {t('figma-dashboard.PolicyComparisonOverview.completionChartEmpty')}
        </p>
      ) : (
        <div ref={host} className="w-full">
          <svg
            viewBox={`0 0 ${width} ${height}`}
            className="block h-[450px] w-full"
            role="img"
          >
            {ticks.map((at) => (
              <g key={at}>
                <line
                  x1={xOf(at)}
                  x2={xOf(at)}
                  y1={padTop}
                  y2={padTop + plotH}
                  stroke="#d5d6d8"
                  strokeDasharray="3 4"
                />
                <text x={xOf(at)} y={height - 8} textAnchor="middle" fontSize="13" fill="#727478">
                  {formatClock(at)}
                </text>
              </g>
            ))}
            {rows.map((row) => {
              const times = [...(row.jobEnds ?? [])].sort((left, right) => left - right);
              if (times.length === 0) return null;
              const points: string[] = [];
              for (let at = origin; at <= finish; at += 60) {
                const x = xOf(at).toFixed(1);
                const y = yOf(smoothedCount(times, at, SMOOTH_SIGMA_SEC)).toFixed(1);
                points.push(`${x},${y}`);
              }
              return (
                <polyline
                  key={row.strategyId}
                  fill="none"
                  stroke={STRATEGY_COLORS[row.strategyId] ?? '#272930'}
                  strokeWidth="3"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  points={points.join(' ')}
                />
              );
            })}
          </svg>
        </div>
      )}
    </section>
  );
}

function signed(value: number): string {
  return `${value > 0 ? '+' : ''}${number.format(value)}`;
}

function Insight({ title, value, note }: { title: string; value: string; note: string }) {
  return (
    <div className="rounded-[20px] bg-figma-soft p-[24px]">
      <p className="text-[16px] font-medium text-figma-muted">{title}</p>
      <p className="my-[10px] text-[34px] leading-[40px] font-bold text-figma-ink">{value}</p>
      <p className="text-[14px] text-figma-muted">{note}</p>
    </div>
  );
}

function ComparisonBars({
  rows,
  measure,
  title,
  unit,
  description,
  better,
  nested = false,
}: {
  rows: readonly PolicyComparisonRow[];
  measure: ComparisonMeasure;
  title: string;
  unit: string;
  description: string;
  better: 'min' | 'max';
  nested?: boolean;
}) {
  const scored = rows.map((row) => ({
    row,
    value: row.isUsable ? comparisonValue(row, measure) : null,
  }));
  const maximum =
    measure === 'assigned'
      ? Math.max(1, ...rows.map((row) => row.metrics.requestsTotal))
      : Math.max(1, ...scored.map((item) => item.value ?? 0));
  const fifo = scored.find((item) => item.row.strategyId === 'baseline');
  const best = comparisonWinners(rows, (row) => comparisonValue(row, measure), better);
  return (
    <section aria-label={title} className={nested ? '' : 'rounded-[20px] bg-figma-soft p-[24px]'}>
      <h3 className="text-[20px] font-semibold text-figma-ink">{title}</h3>
      <p className="mt-[6px] mb-[22px] text-[13px] leading-[18px] text-figma-muted">
        {description}
      </p>
      <ul className="space-y-[18px]">
        {scored.map(({ row, value }) => {
          const delta =
            row.strategyId === 'baseline'
              ? null
              : measure === 'assigned'
                ? value !== null && fifo?.value !== null && fifo?.value !== undefined
                  ? signed(value - fifo.value)
                  : null
                : percentVsFifo(value, fifo?.value);
          return (
            <li key={row.strategyId}>
              <div className="mb-[6px] flex flex-wrap items-baseline justify-between gap-x-[12px] gap-y-[4px] text-[14px]">
                <span className="font-semibold text-figma-ink">
                  {strategyLabel(row.strategyId)}
                  {usesReserve(row) ? ` (+${row.additionalEngineers})` : ''}
                </span>
                <span
                  className={
                    best.has(row.strategyId) ? 'font-semibold text-figma-work' : 'text-figma-ink'
                  }
                >
                  {value === null
                    ? t('figma-dashboard.PolicyComparisonOverview.3afae954a4')
                    : measure === 'assigned'
                      ? // A count of requests, so it declines: «4 заявки», not «4 заявок».
                        t('common.requests', { count: value })
                      : `${number.format(value)} ${unit}`}
                  {delta === null
                    ? ''
                    : t('figma-dashboard.PolicyComparisonOverview.dc2e5dbe5c', { value0: delta })}
                </span>
              </div>
              <div className="h-[9px] overflow-hidden rounded-full bg-white" aria-hidden="true">
                <div
                  className={`h-full rounded-full ${row.strategyId === 'baseline' ? 'bg-figma-ink' : usesReserve(row) ? 'bg-figma-muted' : 'bg-figma-bee'}`}
                  style={{ width: `${Math.max(0, ((value ?? 0) / maximum) * 100)}%` }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
