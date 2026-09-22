import type {
  DashboardSnapshot,
  PolicyComparisonResponse,
  PolicyComparisonRow,
} from '../api/types';
import {
  perAssignmentDuration,
  perAssignmentKm,
  percentVsFifo,
  strategyDescription,
  strategyLabel,
} from '../lib/policyComparison';
import { formatClock, formatDurationMin, formatKm } from '../lib/time';
import { FigmaText } from './primitives';

export const POLICY_PAGE_CAPTION = 'Одинаковые заявки и дорожные условия';

const COLUMNS = [
  'Стратегия',
  'Назначено',
  'Без назначения',
  'Срочные',
  'Инженеры',
  'Пробег',
  'Дорога',
  'Работы',
  'Ожидание',
  'Опоздания',
  'Мин. запас окна',
  'Разброс загрузки',
  'Расчёт',
] as const;

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
  onRefresh,
}: {
  snapshot: DashboardSnapshot | null;
  comparison: PolicyComparisonResponse | null;
  loading: boolean;
  error: string | null;
  recorded: boolean;
  readOnly: boolean;
  onRefresh: () => void;
}) {
  const appliedInputHash = snapshot?.plan.appliedResult?.inputHash ?? null;
  const isStale =
    comparison !== null &&
    snapshot !== null &&
    (comparison.routerContextVersion !== snapshot.routerContextVersion ||
      (appliedInputHash !== null && comparison.inputHash !== appliedInputHash));
  const baselineMetrics = comparison?.rows.find((item) => item.kind === 'baseline')?.metrics;
  const rows = comparison
    ? [...comparison.rows].sort(
        (left, right) => Number(right.kind === 'baseline') - Number(left.kind === 'baseline'),
      )
    : [];

  return (
    <section
      className="absolute overflow-hidden rounded-[20px] bg-white"
      style={{ left: 180, top: 138, width: 1710, height: 909 }}
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

      {comparison ? (
        <div className="absolute left-[30px] top-[118px] flex flex-wrap gap-[8px]">
          <MetaChip label={`Снимок ${comparison.inputPublicationId}`} />
          <MetaChip label={`Расчёт ${formatClock(comparison.computedAt)}`} />
          <MetaChip label={`Бюджет поиска ${comparison.searchBudgetMs} мс на политику`} />
          {isStale ? <MetaChip label="План уже изменился — пересчитайте сравнение" bee /> : null}
        </div>
      ) : null}

      <div className="absolute inset-x-[30px] top-[168px] bottom-[24px] overflow-auto [scrollbar-width:thin]">
        {error ? (
          <div className="rounded-[20px] bg-figma-soft px-[24px] py-[20px]">
            <p className="font-semibold text-[20px] text-figma-danger">Сравнение не загрузилось</p>
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
          <table className="w-full min-w-[1480px] border-separate border-spacing-x-0 border-spacing-y-[16px] text-left">
            <thead>
              <tr>
                {COLUMNS.map((column) => (
                  <th
                    key={column}
                    className="px-[12px] pb-[2px] font-semibold text-[14px] tracking-[-0.2px] text-figma-muted"
                  >
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <ComparisonRow
                  key={row.strategyId}
                  row={row}
                  active={Boolean(
                    snapshot && row.kind === 'policy' && row.strategyId === snapshot.policyId,
                  )}
                  recorded={recorded}
                  baselineMetrics={baselineMetrics}
                />
              ))}
            </tbody>
          </table>
        ) : null}
      </div>
    </section>
  );
}

function ComparisonRow({
  row,
  active,
  recorded,
  baselineMetrics,
}: {
  row: PolicyComparisonRow;
  active: boolean;
  recorded: boolean;
  baselineMetrics: PolicyComparisonRow['metrics'] | undefined;
}) {
  const baseline = row.kind === 'baseline';
  return (
    <tr className={baseline ? 'bg-figma-soft' : active ? 'bg-[#fff6d8]' : ''}>
      <td className="rounded-l-[16px] px-[12px] py-[16px] align-top">
        <div className="flex flex-wrap items-center gap-[8px]">
          <span className="font-semibold text-[16px] text-figma-ink">
            {strategyLabel(row.strategyId)}
          </span>
          {baseline ? <RowBadge label="сравнение с ТЗ" /> : null}
          {active ? <RowBadge label="активная" /> : null}
        </div>
        <p className="mt-[6px] max-w-[280px] font-medium text-[13px] leading-[18px] text-figma-muted">
          {strategyDescription(row.strategyId)}
        </p>
        {!row.isUsable ? (
          <p className="mt-[6px] font-medium text-[13px] text-figma-danger">План непригоден</p>
        ) : null}
      </td>
      <td className="px-[12px] py-[16px] align-top font-medium text-[15px] text-figma-ink">
        {row.metrics.assignedCount}/{row.metrics.requestsTotal}
      </td>
      <td className="px-[12px] py-[16px] align-top font-medium text-[15px] text-figma-ink">
        {row.metrics.unassignedCount}
      </td>
      <td className="px-[12px] py-[16px] align-top font-medium text-[15px] text-figma-ink">
        {row.metrics.urgentAssignedCount}/{row.metrics.urgentTotal}
      </td>
      <td className="px-[12px] py-[16px] align-top font-medium text-[15px] text-figma-ink">
        {row.metrics.engineersUsed}
        {row.strategyId === 'covering' ? (
          <span className="mt-[4px] block text-[12px] text-figma-muted">
            из них +{row.additionalEngineers ?? 0} дополнительных
          </span>
        ) : null}
      </td>
      <td className="px-[12px] py-[16px] align-top font-medium text-[15px] text-figma-ink">
        <MetricBlock
          value={formatKm(row.metrics.distanceKm)}
          hint={perAssignmentKm(row.metrics.distanceKm, row.metrics.assignedCount)}
        />
      </td>
      <td className="px-[12px] py-[16px] align-top font-medium text-[15px] text-figma-ink">
        <MetricBlock
          value={formatDurationMin(row.metrics.travelTimeSec)}
          hint={perAssignmentDuration(row.metrics.travelTimeSec, row.metrics.assignedCount)}
        />
      </td>
      <td className="px-[12px] py-[16px] align-top font-medium text-[15px] text-figma-ink">
        {formatDurationMin(row.metrics.workTimeSec)}
      </td>
      <td className="px-[12px] py-[16px] align-top font-medium text-[15px] text-figma-ink">
        {formatDurationMin(row.metrics.waitingTimeSec)}
      </td>
      <td className="px-[12px] py-[16px] align-top font-medium text-[15px] text-figma-ink">
        <MetricBlock
          value={`${row.metrics.lateAssignedCount} · ${formatDurationMin(row.metrics.totalLatenessSec)}`}
          hint={fifoHint(row.metrics.totalLatenessSec, baselineMetrics?.totalLatenessSec)}
        />
      </td>
      <td className="px-[12px] py-[16px] align-top font-medium text-[15px] text-figma-ink">
        <MetricBlock
          value={
            row.metrics.minWindowSlackSec === null
              ? '—'
              : formatDurationMin(row.metrics.minWindowSlackSec)
          }
          hint={fifoHint(row.metrics.minWindowSlackSec, baselineMetrics?.minWindowSlackSec)}
        />
      </td>
      <td className="px-[12px] py-[16px] align-top font-medium text-[15px] text-figma-ink">
        <MetricBlock
          value={`${formatDurationMin(row.metrics.workloadSpreadSec)} · max ${formatDurationMin(row.metrics.maxWorkloadSec)}`}
          hint={fifoHint(row.metrics.workloadSpreadSec, baselineMetrics?.workloadSpreadSec)}
        />
      </td>
      <td className="rounded-r-[16px] px-[12px] py-[16px] align-top font-medium text-[15px] text-figma-ink">
        {recorded ? 'Запись · не замерено' : `${Math.round(row.calculationMs)} мс`}
      </td>
    </tr>
  );
}

function fifoHint(value: number | null, baseline: number | null | undefined): string | null {
  const delta = percentVsFifo(value, baseline);
  return delta ? `${delta} к FIFO` : null;
}

function MetricBlock({ value, hint }: { value: string; hint: string | null }) {
  return (
    <div>
      <div>{value}</div>
      {hint ? <div className="mt-[4px] text-[12px] text-figma-muted">{hint}</div> : null}
    </div>
  );
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

function RowBadge({ label }: { label: string }) {
  return (
    <span className="rounded-[20px] bg-figma-bee px-[10px] py-[3px] font-semibold text-[12px] text-figma-ink">
      {label}
    </span>
  );
}
