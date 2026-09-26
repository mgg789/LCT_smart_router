import { useState } from 'react';
import type { PolicyComparisonRow } from '../api/types';
import {
  type ComparisonMeasure,
  comparisonValue,
  comparisonWinners,
  percentVsFifo,
  strategyLabel,
  usesReserve,
} from '../lib/policyComparison';

const number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const COST_MEASURES = {
  kmPerJob: {
    title: 'Дорога на назначение',
    unit: 'км',
    description: 'Пробег / назначенные заявки. Меньше — лучше.',
  },
  travelPerJob: {
    title: 'Время дороги на назначение',
    unit: 'мин',
    description: 'Время в пути / назначенные заявки. Меньше — лучше.',
  },
  waitingPerJob: {
    title: 'Ожидание на назначение',
    unit: 'мин',
    description: 'Ожидание / назначенные заявки. Меньше — лучше.',
  },
  latenessPerJob: {
    title: 'Задержка на назначение',
    unit: 'мин',
    description: 'Суммарное опоздание / назначенные заявки. Меньше — лучше.',
  },
} as const;
const LATE_SHARE_MEASURE = {
  title: 'Доля опозданий',
  unit: '%',
  description: 'Опоздания среди назначенных заявок. Меньше — лучше.',
} as const;
type CostMeasure = keyof typeof COST_MEASURES;

/** Coverage, travel, lateness and staffing comparisons with the same FIFO reference. */
export function PolicyComparisonOverview({ rows }: { rows: readonly PolicyComparisonRow[] }) {
  const [measure, setMeasure] = useState<CostMeasure>('kmPerJob');
  const [includeReserve, setIncludeReserve] = useState(false);
  const fixed = rows.filter((row) => row.isUsable && !usesReserve(row));
  const visible = rows.filter((row) => includeReserve || !usesReserve(row));
  const fifo = rows.find((row) => row.strategyId === 'baseline' && row.isUsable);
  const policies = fixed.filter((row) => row.kind === 'policy');
  const reserve = rows.find(usesReserve);
  const bestCount = policies.length
    ? Math.max(...policies.map((row) => row.metrics.assignedCount))
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
          title="Больше назначений"
          value={
            bestCount === null
              ? '—'
              : `${bestCount} из ${fifo?.metrics.requestsTotal ?? rows[0]?.metrics.requestsTotal ?? 0}`
          }
          note={
            bestCount !== null && fifo
              ? `${signed(bestCount - fifo.metrics.assignedCount)} к FIFO · тот же состав`
              : 'Нужен пригодный расчёт'
          }
        />
        <Insight
          title="Больше заявок в срок"
          value={bestOnTime === null ? '—' : String(bestOnTime)}
          note={
            bestOnTime !== null && fifo
              ? `${signed(bestOnTime - (comparisonValue(fifo, 'onTime') ?? 0))} к FIFO`
              : 'Назначено с завершением в исходном окне'
          }
        />
        <Insight
          title="Минимум дороги на заявку"
          value={bestCost === null ? '—' : `${number.format(bestCost)} км`}
          note={`${percentVsFifo(bestCost, fifo ? comparisonValue(fifo, 'kmPerJob') : null) ?? '—'} к FIFO · на назначение`}
        />
      </div>
      <p className="text-[15px] leading-[22px] text-figma-muted">
        Показан лучший результат по каждому показателю среди основных политик; это могут быть разные
        планы.
        {fingerprints.size === 1 && policies.length > 1
          ? ' На этом наборе основные политики дали одинаковые показатели.'
          : ''}
      </p>
      <div className="grid grid-cols-1 gap-[20px] lg:grid-cols-2">
        <ComparisonBars
          rows={visible}
          measure="assigned"
          title="Сколько заявок удаётся назначить"
          unit="заявок"
          description="Жёлтый — политики, тёмный — FIFO. Больше — лучше."
          better="max"
        />
        <section className="rounded-[20px] bg-figma-soft p-[24px]">
          <label className="mb-[20px] flex flex-wrap items-center justify-between gap-[12px] text-[16px] font-semibold text-figma-ink">
            Сравнить расходы
            <select
              aria-label="Показатель расходов"
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
              <option value="kmPerJob">Километры на заявку</option>
              <option value="travelPerJob">Минуты дороги на заявку</option>
              <option value="waitingPerJob">Ожидание на заявку</option>
              <option value="latenessPerJob">Задержка на заявку</option>
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
          title="Задействованные инженеры"
          unit="инж."
          description="Число инженеров с назначениями. Сопоставляйте вместе с покрытием заявок."
          better="min"
        />
      </div>
      {reserve ? (
        <label className="flex cursor-pointer items-center gap-[12px] rounded-[16px] border border-figma-muted/20 p-[18px] text-[15px] text-figma-ink">
          <input
            type="checkbox"
            checked={includeReserve}
            onChange={(event) => setIncludeReserve(event.target.checked)}
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
          <span className="relative top-[1px]">
            Показать «Полное покрытие»: +{reserve.additionalEngineers} резервных инженеров. Этот
            результат использует больше ресурсов и сравнивается отдельно.
          </span>
        </label>
      ) : null}
    </div>
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
                  {row.strategyId === 'baseline' ? 'FIFO · базовое' : strategyLabel(row.strategyId)}
                  {usesReserve(row) ? ` (+${row.additionalEngineers})` : ''}
                </span>
                <span
                  className={
                    best.has(row.strategyId) ? 'font-semibold text-figma-work' : 'text-figma-ink'
                  }
                >
                  {value === null ? 'нет сопоставимой оценки' : `${number.format(value)} ${unit}`}
                  {delta === null ? '' : ` · ${delta} к FIFO`}
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
