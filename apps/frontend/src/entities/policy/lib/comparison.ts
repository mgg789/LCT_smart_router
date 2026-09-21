import type { StrategyId } from '../model/comparison';
import { policyTitle } from './policyTitle';

/**
 * What each strategy optimises, in the words `apps/web` shows under its name.
 * They describe the objective the Router runs, not an outcome.
 */
const DESCRIPTIONS: Record<string, string> = {
  compact:
    'Сначала срочные и все заявки, затем необязательные обеды и суммарное опоздание; после — меньше инженеров, короче пробег и дорога.',
  fast: 'Сначала срочные и все заявки, затем необязательные обеды и суммарное опоздание; после — меньше времени в пути, пробег и инженеры.',
  sla: 'После общего покрытия максимизирует минимальный запас до исходного окна клиента, затем сокращает дорогу.',
  balanced:
    'После общего покрытия выравнивает максимальную долю занятой смены, затем разброс загрузки в секундах.',
  eco: 'Сначала срочные и все заявки, затем необязательные обеды и суммарное опоздание; после — короткий пробег, инженеры и дорога.',
  covering:
    'Повышает покрытие, перераспределяя заявки и добавляя инженеров нужного региона. Сокращает дополнительный состав; недостижимые окна остаются без назначения.',
  baseline:
    'Базовая из ТЗ: заявки по очереди поступления первому подходящему свободному инженеру. Нужна для сравнения, не как рабочая политика.',
};

export function strategyTitle(strategyId: StrategyId): string {
  return strategyId === 'baseline' ? 'Базовая из ТЗ' : policyTitle(strategyId);
}

export function strategyDescription(strategyId: StrategyId): string {
  return DESCRIPTIONS[strategyId] ?? '';
}

/**
 * Change against the FIFO baseline, as a signed whole percent; `null` when the
 * baseline has no value or a zero one, where a percentage would mean nothing.
 */
export function percentVsBaseline(
  value: number | null,
  baseline: number | null | undefined,
): string | null {
  if (value === null || baseline === null || baseline === undefined || baseline === 0) return null;
  const percent = Math.round(((value - baseline) / baseline) * 100);
  return `${percent > 0 ? '+' : ''}${percent}%`;
}

/** Kilometres per assigned request, with a comma as a Russian reader expects. */
export function kmPerAssignment(distanceKm: number, assignedCount: number): string {
  return assignedCount > 0
    ? `${(distanceKm / assignedCount).toFixed(1).replace('.', ',')} км/назначение`
    : '— км/назначение';
}

/** Minutes per assigned request. */
export function minutesPerAssignment(durationSec: number, assignedCount: number): string {
  return assignedCount > 0
    ? `${Math.round(durationSec / assignedCount / 60)} мин/назначение`
    : '— мин/назначение';
}
