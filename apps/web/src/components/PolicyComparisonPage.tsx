import type { DashboardSnapshot, PolicyComparisonResponse, StrategyId } from '../api/types';
import { POLICY_DESCRIPTIONS, POLICY_LABELS } from '../lib/reasons';
import { formatClock, formatDurationMin, formatKm } from '../lib/time';

interface PolicyComparisonPageProps {
  readonly recorded?: boolean;
  readonly readOnly?: boolean;
  readonly snapshot: DashboardSnapshot;
  readonly comparison: PolicyComparisonResponse | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly onRefresh: () => void;
}

/** Renders a non-mutating comparison of every Router policy and the official FIFO baseline. */
export function PolicyComparisonPage({
  recorded = false,
  readOnly = false,
  snapshot,
  comparison,
  loading,
  error,
  onRefresh,
}: PolicyComparisonPageProps) {
  const appliedInputHash = snapshot.plan.appliedResult?.inputHash ?? null;
  const isStale =
    comparison !== null &&
    (comparison.routerContextVersion !== snapshot.routerContextVersion ||
      (appliedInputHash !== null && comparison.inputHash !== appliedInputHash));

  return (
    <main className="min-h-0 flex-1 overflow-auto px-4 pb-4">
      <section className="mx-auto max-w-[1440px] rounded-3xl bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm text-muted">Одинаковые заявки, инженеры и дорожная матрица</p>
            <h1 className="mt-1 text-2xl font-semibold">Сравнение политик</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-muted">
              Рабочие политики считаются на одном снимке с тем же составом инженеров. Строка
              «Базовая из ТЗ» выделена отдельно: это прямое последовательное назначение из ТЗ
              (очередь заявок → первый подходящий свободный инженер), а не оптимизация. Сравнивайте
              с ней число исполнителей, пробег и качество окон. Опоздание здесь считается от
              исходного окна клиента, до любых допусков Router.
            </p>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading || readOnly}
            className="rounded-full bg-bee px-4 py-2 text-sm font-semibold disabled:opacity-50"
          >
            {recorded
              ? 'Показать записанное сравнение'
              : loading
                ? 'Считаем шесть стратегий…'
                : comparison
                  ? 'Пересчитать'
                  : 'Сравнить'}
          </button>
        </div>

        {error ? (
          <div className="mt-6 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">
            <p className="font-medium">Сравнение не загрузилось</p>
            <p className="mt-1">{error}</p>
          </div>
        ) : null}

        {loading && !comparison ? (
          <div className="mt-8 grid gap-3 md:grid-cols-3">
            {['fast', 'compact', 'sla', 'balanced', 'eco', 'baseline'].map((strategyId) => (
              <div key={strategyId} className="h-32 animate-pulse rounded-2xl bg-canvas" />
            ))}
          </div>
        ) : null}

        {!loading && !comparison && !error ? (
          <div className="mt-8 rounded-2xl border border-dashed border-line p-8 text-center text-sm text-muted">
            {readOnly
              ? 'Новое сравнение станет доступно после восстановления связи.'
              : 'Запустите сравнение. Активный план и выбранная политика при этом не изменятся.'}
          </div>
        ) : null}

        {comparison ? (
          <>
            <div className="mt-6 flex flex-wrap gap-2 text-[12px] text-muted">
              <span className="rounded-full bg-canvas px-3 py-1.5">
                Снимок {comparison.inputPublicationId}
              </span>
              <span className="rounded-full bg-canvas px-3 py-1.5">
                Расчёт {formatClock(comparison.computedAt)}
              </span>
              <span className="rounded-full bg-canvas px-3 py-1.5">
                <span title="Динамический поиск ограничен числом оценок; фактическое время расчёта показывается отдельно.">
                  Бюджет поиска {comparison.searchBudgetMs} мс на политику
                </span>
              </span>
              {isStale ? (
                <span className="rounded-full bg-bee px-3 py-1.5 text-ink">
                  План уже изменился — пересчитайте сравнение
                </span>
              ) : null}
            </div>

            <div className="mt-4 overflow-x-auto rounded-2xl border border-line">
              <table className="w-full min-w-[1380px] border-collapse text-left text-sm">
                <thead className="bg-canvas text-[12px] text-muted">
                  <tr>
                    <th className="px-4 py-3 font-medium">Стратегия</th>
                    <th className="px-3 py-3 font-medium">Назначено</th>
                    <th className="px-3 py-3 font-medium">Без назначения</th>
                    <th className="px-3 py-3 font-medium">Срочные</th>
                    <th className="px-3 py-3 font-medium">Инженеры</th>
                    <th className="px-3 py-3 font-medium">Пробег</th>
                    <th className="px-3 py-3 font-medium">Дорога</th>
                    <th className="px-3 py-3 font-medium">Работы</th>
                    <th className="px-3 py-3 font-medium">Ожидание</th>
                    <th className="px-3 py-3 font-medium">Опоздания</th>
                    <th className="px-3 py-3 font-medium">Мин. запас окна</th>
                    <th className="px-3 py-3 font-medium">Разброс загрузки</th>
                    <th className="px-3 py-3 font-medium">Расчёт</th>
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    const baselineMetrics = comparison.rows.find(
                      (item) => item.kind === 'baseline',
                    )?.metrics;
                    return [...comparison.rows]
                      .sort(
                        (left, right) =>
                          Number(right.kind === 'baseline') - Number(left.kind === 'baseline'),
                      )
                      .map((row) => {
                        const active =
                          row.kind === 'policy' && row.strategyId === snapshot.policyId;
                        const baseline = row.kind === 'baseline';
                        return (
                          <tr
                            key={row.strategyId}
                            className={`border-t border-line ${
                              baseline ? 'bg-amber-50' : active ? 'bg-bee/15' : ''
                            }`}
                          >
                            <td className="px-4 py-4">
                              <div className="flex items-center gap-2">
                                <span
                                  className={`font-semibold ${baseline ? 'text-amber-950' : ''}`}
                                >
                                  {strategyLabel(row.strategyId)}
                                </span>
                                {baseline ? (
                                  <span className="rounded-full bg-amber-200 px-2 py-0.5 text-[11px] font-semibold text-amber-950">
                                    сравнение с ТЗ
                                  </span>
                                ) : null}
                                {active ? (
                                  <span className="rounded-full bg-bee px-2 py-0.5 text-[11px] font-medium">
                                    активная
                                  </span>
                                ) : null}
                              </div>
                              <p className="mt-1 max-w-xs text-[12px] text-muted">
                                {strategyDescription(row.strategyId)}
                              </p>
                              {!row.isUsable ? (
                                <span className="mt-1 inline-block text-[12px] text-red-700">
                                  План непригоден
                                </span>
                              ) : null}
                            </td>
                            <td className="px-3 py-4 font-medium">
                              {row.metrics.assignedCount}/{row.metrics.requestsTotal}
                            </td>
                            <td className="px-3 py-4">{row.metrics.unassignedCount}</td>
                            <td className="px-3 py-4">
                              {row.metrics.urgentAssignedCount}/{row.metrics.urgentTotal}
                            </td>
                            <td className="px-3 py-4">{row.metrics.engineersUsed}</td>
                            <td className="px-3 py-4">
                              <MetricWithSubline
                                value={formatKm(row.metrics.distanceKm)}
                                subline={perAssignmentKm(
                                  row.metrics.distanceKm,
                                  row.metrics.assignedCount,
                                )}
                              />
                            </td>
                            <td className="px-3 py-4">
                              <MetricWithSubline
                                value={formatDurationMin(row.metrics.travelTimeSec)}
                                subline={perAssignmentDuration(
                                  row.metrics.travelTimeSec,
                                  row.metrics.assignedCount,
                                )}
                              />
                            </td>
                            <td className="px-3 py-4">
                              {formatDurationMin(row.metrics.workTimeSec)}
                            </td>
                            <td className="px-3 py-4">
                              {formatDurationMin(row.metrics.waitingTimeSec)}
                            </td>
                            <td className="px-3 py-4">
                              <MetricWithDelta
                                value={`${row.metrics.lateAssignedCount} · ${formatDurationMin(row.metrics.totalLatenessSec)}`}
                                delta={percentVsFifo(
                                  row.metrics.totalLatenessSec,
                                  baselineMetrics?.totalLatenessSec,
                                )}
                              />
                            </td>
                            <td className="px-3 py-4">
                              <MetricWithDelta
                                value={
                                  row.metrics.minWindowSlackSec === null
                                    ? '—'
                                    : formatDurationMin(row.metrics.minWindowSlackSec)
                                }
                                delta={percentVsFifo(
                                  row.metrics.minWindowSlackSec,
                                  baselineMetrics?.minWindowSlackSec,
                                )}
                              />
                            </td>
                            <td className="px-3 py-4">
                              <MetricWithDelta
                                value={`${formatDurationMin(row.metrics.workloadSpreadSec)} · max ${formatDurationMin(row.metrics.maxWorkloadSec)}`}
                                delta={percentVsFifo(
                                  row.metrics.workloadSpreadSec,
                                  baselineMetrics?.workloadSpreadSec,
                                )}
                              />
                            </td>
                            <td className="px-3 py-4">
                              {recorded
                                ? 'Запись · не замерено'
                                : `${Math.round(row.calculationMs)} мс`}
                            </td>
                          </tr>
                        );
                      });
                  })()}
                </tbody>
              </table>
            </div>
          </>
        ) : null}
      </section>
    </main>
  );
}

interface MetricWithDeltaProps {
  readonly value: string;
  readonly delta: string | null;
}

function MetricWithDelta({ value, delta }: MetricWithDeltaProps) {
  return (
    <div>
      <div>{value}</div>
      {delta ? <div className="mt-0.5 text-[11px] text-muted">{delta} к FIFO</div> : null}
    </div>
  );
}

interface MetricWithSublineProps {
  readonly value: string;
  readonly subline: string;
}

function MetricWithSubline({ value, subline }: MetricWithSublineProps) {
  return (
    <div>
      <div>{value}</div>
      <div className="mt-0.5 text-[11px] text-muted">{subline}</div>
    </div>
  );
}

function perAssignmentKm(distanceKm: number, assignedCount: number): string {
  return assignedCount > 0
    ? `${(distanceKm / assignedCount).toFixed(1).replace('.', ',')} км/назначение`
    : '— км/назначение';
}

function perAssignmentDuration(durationSec: number, assignedCount: number): string {
  return assignedCount > 0
    ? `${formatDurationMin(durationSec / assignedCount)}/назначение`
    : '— мин/назначение';
}

function percentVsFifo(value: number | null, baseline: number | null | undefined): string | null {
  if (value === null || baseline === null || baseline === undefined || baseline === 0) {
    return null;
  }
  const percent = Math.round(((value - baseline) / baseline) * 100);
  return `${percent > 0 ? '+' : ''}${percent}%`;
}

function strategyLabel(strategyId: StrategyId): string {
  return strategyId === 'baseline' ? 'Базовая из ТЗ' : (POLICY_LABELS[strategyId] ?? strategyId);
}

function strategyDescription(strategyId: StrategyId): string {
  return POLICY_DESCRIPTIONS[strategyId] ?? strategyId;
}
