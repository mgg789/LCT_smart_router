import type { DashboardSnapshot, PolicyComparisonResponse, StrategyId } from '../api/types';
import { POLICY_DESCRIPTIONS, POLICY_LABELS } from '../lib/reasons';
import { formatClock, formatDurationMin, formatKm } from '../lib/time';

interface PolicyComparisonPageProps {
  readonly snapshot: DashboardSnapshot;
  readonly comparison: PolicyComparisonResponse | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly onRefresh: () => void;
}

/** Renders a non-mutating comparison of every Router policy and the official FIFO baseline. */
export function PolicyComparisonPage({
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
              Пять политик считаются на одном снимке. «Базовая из ТЗ» берёт заявки по очереди
              поступления и отдаёт их первому подходящему свободному инженеру.
            </p>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="rounded-full bg-bee px-4 py-2 text-sm font-semibold disabled:opacity-50"
          >
            {loading ? 'Считаем шесть стратегий…' : comparison ? 'Пересчитать' : 'Сравнить'}
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
            Запустите сравнение. Активный план и выбранная политика при этом не изменятся.
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
                Лимит поиска {comparison.searchBudgetMs} мс на политику
              </span>
              {isStale ? (
                <span className="rounded-full bg-bee px-3 py-1.5 text-ink">
                  План уже изменился — пересчитайте сравнение
                </span>
              ) : null}
            </div>

            <div className="mt-4 overflow-x-auto rounded-2xl border border-line">
              <table className="w-full min-w-[1120px] border-collapse text-left text-sm">
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
                    <th className="px-3 py-3 font-medium">Расчёт</th>
                  </tr>
                </thead>
                <tbody>
                  {comparison.rows.map((row) => {
                    const active = row.kind === 'policy' && row.strategyId === snapshot.policyId;
                    return (
                      <tr
                        key={row.strategyId}
                        className={`border-t border-line ${active ? 'bg-bee/15' : ''}`}
                      >
                        <td className="px-4 py-4">
                          <div className="flex items-center gap-2">
                            <span className="font-semibold">{strategyLabel(row.strategyId)}</span>
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
                        <td className="px-3 py-4">{formatKm(row.metrics.distanceKm)}</td>
                        <td className="px-3 py-4">
                          {formatDurationMin(row.metrics.travelTimeSec)}
                        </td>
                        <td className="px-3 py-4">{formatDurationMin(row.metrics.workTimeSec)}</td>
                        <td className="px-3 py-4">
                          {formatDurationMin(row.metrics.waitingTimeSec)}
                        </td>
                        <td className="px-3 py-4">{Math.round(row.calculationMs)} мс</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        ) : null}
      </section>
    </main>
  );
}

function strategyLabel(strategyId: StrategyId): string {
  return strategyId === 'baseline' ? 'Базовая из ТЗ' : (POLICY_LABELS[strategyId] ?? strategyId);
}

function strategyDescription(strategyId: StrategyId): string {
  return POLICY_DESCRIPTIONS[strategyId] ?? strategyId;
}
