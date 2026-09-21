import { motion } from 'framer-motion';
import { useDispatchState } from '@/entities/plan';
import type { ComparisonMetrics, ComparisonRow } from '@/entities/policy';
import {
  kmPerAssignment,
  minutesPerAssignment,
  percentVsBaseline,
  strategyDescription,
  strategyTitle,
  usePolicies,
  usePolicyComparison,
} from '@/entities/policy';
import { cn, formatKm, formatMinutes, formatTime, staggered, useMotionOn } from '@/shared/lib';

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

function MetaChip({ label, accent = false }: { label: string; accent?: boolean }) {
  return (
    <span
      className={cn(
        'rounded-[20px] px-[14px] py-2 font-medium text-[14px]',
        accent ? 'bg-accent text-ink' : 'bg-muted text-ink-soft',
      )}
    >
      {label}
    </span>
  );
}

function RowBadge({ label }: { label: string }) {
  return (
    <span className="rounded-[20px] bg-accent px-[10px] py-[3px] font-semibold text-[12px] text-ink">
      {label}
    </span>
  );
}

/** A value with, under it, how it compares — per assignment, or against FIFO. */
function Metric({ value, hint }: { value: string; hint: string | null }) {
  return (
    <div>
      <div>{value}</div>
      {hint ? <div className="mt-1 text-[12px] text-ink-soft">{hint}</div> : null}
    </div>
  );
}

function vsBaseline(value: number | null, baseline: number | null | undefined): string | null {
  const delta = percentVsBaseline(value, baseline);
  return delta ? `${delta} к FIFO` : null;
}

const CELL = 'px-3 py-4 align-top font-medium text-[15px] text-ink';

function Row({
  row,
  active,
  baseline,
  index,
  motionOn,
}: {
  row: ComparisonRow;
  active: boolean;
  baseline: ComparisonMetrics | undefined;
  index: number;
  motionOn: boolean;
}) {
  const isBaseline = row.kind === 'baseline';
  const m = row.metrics;
  return (
    <motion.tr
      animate={{ opacity: 1, y: 0 }}
      className={isBaseline ? 'bg-muted' : active ? 'bg-[#fff6d8]' : ''}
      initial={motionOn ? { opacity: 0, y: 12 } : false}
      transition={motionOn ? staggered(index) : { duration: 0 }}
    >
      <td className="rounded-l-[16px] px-3 py-4 align-top">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-[16px] text-ink">
            {strategyTitle(row.strategyId)}
          </span>
          {isBaseline ? <RowBadge label="сравнение с ТЗ" /> : null}
          {active ? <RowBadge label="активная" /> : null}
        </div>
        <p className="mt-[6px] max-w-[280px] font-medium text-[13px] text-ink-soft leading-[18px]">
          {strategyDescription(row.strategyId)}
        </p>
        {!row.isUsable ? (
          <p className="mt-[6px] font-medium text-[13px] text-danger">План непригоден</p>
        ) : null}
      </td>
      <td className={CELL}>
        {m.assignedCount}/{m.requestsTotal}
      </td>
      <td className={CELL}>{m.unassignedCount}</td>
      <td className={CELL}>
        {m.urgentAssignedCount}/{m.urgentTotal}
      </td>
      <td className={CELL}>
        {m.engineersUsed}
        {row.strategyId === 'covering' ? (
          <span className="mt-1 block text-[12px] text-ink-soft">
            из них +{row.additionalEngineers ?? 0} дополнительных
          </span>
        ) : null}
      </td>
      <td className={CELL}>
        <Metric
          hint={kmPerAssignment(m.distanceKm, m.assignedCount)}
          value={formatKm(m.distanceKm)}
        />
      </td>
      <td className={CELL}>
        <Metric
          hint={minutesPerAssignment(m.travelTimeSec, m.assignedCount)}
          value={formatMinutes(m.travelTimeSec)}
        />
      </td>
      <td className={CELL}>{formatMinutes(m.workTimeSec)}</td>
      <td className={CELL}>{formatMinutes(m.waitingTimeSec)}</td>
      <td className={CELL}>
        <Metric
          hint={vsBaseline(m.totalLatenessSec, baseline?.totalLatenessSec)}
          value={`${m.lateAssignedCount} · ${formatMinutes(m.totalLatenessSec)}`}
        />
      </td>
      <td className={CELL}>
        <Metric
          hint={vsBaseline(m.minWindowSlackSec, baseline?.minWindowSlackSec)}
          value={m.minWindowSlackSec === null ? '—' : formatMinutes(m.minWindowSlackSec)}
        />
      </td>
      <td className={CELL}>
        <Metric
          hint={vsBaseline(m.workloadSpreadSec, baseline?.workloadSpreadSec)}
          value={`${formatMinutes(m.workloadSpreadSec)} · max ${formatMinutes(m.maxWorkloadSec)}`}
        />
      </td>
      <td className={cn(CELL, 'rounded-r-[16px]')}>{Math.round(row.calculationMs)} мс</td>
    </motion.tr>
  );
}

/**
 * «Политика»: every policy and the FIFO baseline from the case statement, run on
 * the same published input — ported from `apps/web`'s comparison screen.
 *
 * The comparison costs a full search per strategy, so it runs only when asked
 * and is kept afterwards. When the plan has moved on since, the screen says the
 * numbers are stale rather than recomputing on its own. Choosing a policy stays
 * where it was: the pill in the header.
 */
export function PolicyPage() {
  const comparison = usePolicyComparison();
  const policies = usePolicies();
  const state = useDispatchState();
  const motionOn = useMotionOn();

  const data = comparison.data ?? null;
  const applied = state.data?.appliedResult ?? null;
  const stale =
    data !== null &&
    applied !== null &&
    (data.routerContextVersion !== applied.routerContextVersion ||
      data.inputHash !== applied.inputHash);
  const activeId = policies.data?.active.policyId ?? null;
  const baseline = data?.rows.find((row) => row.kind === 'baseline')?.metrics;
  // The baseline leads: it is the yardstick every other row is read against.
  const rows = data
    ? [...data.rows].sort(
        (left, right) => Number(right.kind === 'baseline') - Number(left.kind === 'baseline'),
      )
    : [];
  const loading = comparison.isFetching;

  return (
    <section className="flex h-full min-h-0 flex-col rounded-[20px] bg-surface p-[30px]">
      <div className="flex shrink-0 items-start justify-between gap-6">
        <div>
          <h1 className="font-display text-[28px] text-ink">Сравнение политик</h1>
          <p className="mt-2 font-semibold text-[18px] text-ink-soft tracking-[-0.306px]">
            Одинаковые заявки и дорожные условия
          </p>
        </div>
        <button
          className="flex h-[67px] shrink-0 items-center justify-center rounded-[20px] bg-accent px-7 font-semibold text-[20px] text-ink tracking-[-0.6px] transition-[transform,filter] duration-150 enabled:hover:scale-[1.02] enabled:hover:brightness-105 enabled:active:scale-[0.98] disabled:opacity-50"
          disabled={loading}
          onClick={() => void comparison.refetch()}
          type="button"
        >
          {loading ? 'Считаем…' : data ? 'Пересчитать' : 'Сравнить'}
        </button>
      </div>

      {data ? (
        <div className="mt-5 flex shrink-0 flex-wrap gap-2">
          <MetaChip label={`Снимок ${data.inputPublicationId}`} />
          <MetaChip label={`Расчёт ${formatTime(data.computedAt)}`} />
          <MetaChip label={`Бюджет поиска ${data.searchBudgetMs} мс на политику`} />
          {stale ? <MetaChip accent label="План уже изменился — пересчитайте сравнение" /> : null}
        </div>
      ) : null}

      <div className="mt-5 min-h-0 flex-1 overflow-auto [scrollbar-width:thin]">
        {comparison.isError ? (
          <div className="rounded-[20px] bg-muted px-6 py-5">
            <p className="font-semibold text-[20px] text-danger">Сравнение не загрузилось</p>
            <p className="mt-2 font-medium text-[16px] text-ink-soft">
              {comparison.error.code === 'SERVICE_NOT_CONFIGURED'
                ? 'Router ещё считает или не подключён — повторите, когда план применится.'
                : comparison.error.code === 'VERSION_CONFLICT'
                  ? 'Данные изменились, пока шёл расчёт, — запустите сравнение снова.'
                  : // Anything else is the server's own failure — say so, with the id
                    // that finds it in the API log, instead of a bare «Internal error».
                    `Сервер не смог посчитать сравнение (${comparison.error.code}${
                      comparison.error.requestId ? `, requestId ${comparison.error.requestId}` : ''
                    }). Повторите позже.`}
            </p>
          </div>
        ) : null}

        {loading && !data ? (
          <div className="grid grid-cols-3 gap-4">
            {['a', 'b', 'c', 'd', 'e', 'f'].map((key) => (
              <div className="h-[120px] animate-pulse rounded-[20px] bg-muted" key={key} />
            ))}
          </div>
        ) : null}

        {!loading && !data && !comparison.isError ? (
          <div className="flex h-[220px] items-center justify-center rounded-[20px] bg-muted px-[30px] text-center">
            <p className="font-medium text-[18px] text-ink-soft">
              Запустите сравнение. Активный план и выбранная политика при этом не изменятся. Первый
              расчёт после публикации может идти до полутора минут.
            </p>
          </div>
        ) : null}

        {data ? (
          <table className="w-full min-w-[1480px] border-separate border-spacing-x-0 border-spacing-y-4 text-left">
            <thead>
              <tr>
                {COLUMNS.map((column) => (
                  <th
                    className="px-3 pb-[2px] font-semibold text-[14px] text-ink-soft tracking-[-0.2px]"
                    key={column}
                  >
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <Row
                  active={row.kind === 'policy' && row.strategyId === activeId}
                  baseline={baseline}
                  index={index}
                  key={row.strategyId}
                  motionOn={motionOn}
                  row={row}
                />
              ))}
            </tbody>
          </table>
        ) : null}
      </div>
    </section>
  );
}
