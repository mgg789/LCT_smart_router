import type { PolicyId } from '../api/types';

/**
 * Dispatcher-facing reading of a dry situation prediction.
 *
 * Bands match the documented thresholds: 90% and above is excellent, 70–90%
 * is workable, below 70% is a high risk. The text never names the simulator
 * and never suggests the policy that is already on.
 */

export type QualityBand = 'green' | 'yellow' | 'red';

export interface QualityRequest {
  readonly requestId: string;
  readonly shortId: string;
  readonly breachProb: number | null;
}

export interface QualityEngineer {
  readonly name: string;
  readonly overrunProb: number;
}

export interface AdviceLine {
  readonly before: string;
  readonly requestId: string | null;
  readonly shortId: string | null;
  readonly after: string;
}

export interface PlanQualityAdvice {
  readonly band: QualityBand;
  readonly title: string;
  readonly summary: string;
  readonly lines: readonly AdviceLine[];
}

const TITLES: Record<QualityBand, string> = {
  green: 'План отличный',
  yellow: 'Можно работать',
  red: 'Высокий риск',
};

/** Share of simulated days with no late visit, expressed as a 0–10 count. */
export function reliableDaysOutOfTen(robustness: number): number {
  return Math.round(Math.min(1, Math.max(0, robustness)) * 10);
}

/**
 * Reading for a plan that has no visits to rehearse.
 * Robustness is not invented: there is nothing to simulate.
 */
export function unroutedPlanAdvice(input: {
  readonly unassignedCount: number;
  readonly rosterOffline: boolean;
}): PlanQualityAdvice {
  const uncovered =
    input.unassignedCount === 1
      ? 'Одна заявка без инженера.'
      : `${input.unassignedCount} заявок без инженера.`;
  return {
    band: 'red',
    title: TITLES.red,
    summary: 'В маршрутах нет заявок, поэтому день ещё не из чего проверять.',
    lines: [
      textLine(uncovered),
      textLine(
        input.rosterOffline
          ? 'Инженеры не вышли на линию, поэтому назначать некого. Когда смена начнётся, проверку можно запустить снова.'
          : 'Проверка запускается, когда в плане появляется хотя бы один визит.',
      ),
    ],
  };
}

/** Traffic-light band for one robustness share in 0..1. */
export function qualityBand(robustness: number): QualityBand {
  if (robustness >= 0.9) return 'green';
  if (robustness >= 0.7) return 'yellow';
  return 'red';
}

/**
 * Turns prediction frequencies and the uncovered remainder into sentences
 * a dispatcher can act on. At most three request lines, so the card stays short.
 */
export function planQualityAdvice(input: {
  readonly robustness: number;
  readonly unassignedCount: number;
  readonly activePolicy: PolicyId;
  readonly requests: readonly QualityRequest[];
  readonly engineers: readonly QualityEngineer[];
}): PlanQualityAdvice {
  const band = qualityBand(input.robustness);
  const days = reliableDaysOutOfTen(input.robustness);
  const lines: AdviceLine[] = [];
  if (input.unassignedCount > 0) {
    lines.push(textLine(unassignedLine(input.unassignedCount, input.activePolicy)));
  }
  const risky = input.requests
    .filter((request) => (request.breachProb ?? 0) >= 0.2)
    .sort((left, right) => (right.breachProb ?? 0) - (left.breachProb ?? 0))
    .slice(0, 3);
  for (const request of risky) {
    const share = Math.round((request.breachProb ?? 0) * 100);
    const remedy =
      input.activePolicy === 'fast'
        ? ' «Бережнее к окнам» оставляет запас до конца окна.'
        : input.activePolicy === 'sla'
          ? ' Окно и так в приоритете: имеет смысл сдвинуть визит раньше.'
          : ' «Быстрее до клиента» сокращает дорогу до этого визита.';
    lines.push({
      before: 'Заявка ',
      requestId: request.requestId,
      shortId: request.shortId,
      after: ` опаздывает в ${share}% проверок.${remedy}`,
    });
  }
  for (const engineer of input.engineers.filter((item) => item.overrunProb >= 0.3).slice(0, 2)) {
    lines.push(
      textLine(
        input.activePolicy === 'balanced'
          ? `${engineer.name} может не закрыть смену. Загрузка уже выравнивается, хвост лучше снять вручную.`
          : `${engineer.name} может не закрыть смену. «Ровнее загрузка» разнесёт хвост по свободным.`,
      ),
    );
  }
  if (lines.length === 0) {
    lines.push(textLine('Менять политику не нужно: в большинстве проверок день проходит без опозданий.'));
  }
  return {
    band,
    title: TITLES[band],
    summary: `${days} из 10 таких дней проходят без опозданий. Проверка гоняет день с разным трафиком и разной длительностью работ.`,
    lines,
  };
}

function unassignedLine(count: number, active: PolicyId): string {
  const head = count === 1 ? 'Одна заявка без инженера.' : `${count} заявок без инженера.`;
  if (active === 'covering') {
    return `${head} Полное покрытие уже включено, и этого остатка оно не забрало: не хватает человека на линии, навыка или оборудования.`;
  }
  return `${head} «Полное покрытие» добирает такой остаток отдельной сменой, если навык и оборудование есть.`;
}

function textLine(text: string): AdviceLine {
  return { before: text, requestId: null, shortId: null, after: '' };
}
