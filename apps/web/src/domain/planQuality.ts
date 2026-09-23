import type { PolicyId } from '../api/types';

/**
 * Dispatcher-facing reading of a dry situation prediction.
 *
 * Bands express what a dispatcher would accept from a typical day, so both the
 * expected count and the share of late visits matter: "fewer than one late
 * request" is a normal day at any plan size, "a couple of tight spots" is
 * workable, and a structurally late plan is red. P(a day with zero late
 * visits) is deliberately not a band input: on a 50-visit day it sits near
 * zero for every honest plan and would read every plan as a failure.
 * The text never names the simulator and never suggests the policy that is on.
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

export interface QualityPlan {
  readonly expectedLate: number;
  readonly expectedLateShare: number;
  readonly visitsTotal: number;
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
  green: 'План надёжный',
  yellow: 'Можно работать',
  red: 'Высокий риск',
};

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

/** Traffic-light band for one plan's expected late visits. */
export function qualityBand(plan: QualityPlan): QualityBand {
  if (plan.expectedLate < 1 && plan.expectedLateShare < 0.05) return 'green';
  if (plan.expectedLate <= 3 && plan.expectedLateShare < 0.12) return 'yellow';
  return 'red';
}

/**
 * Turns prediction frequencies and the uncovered remainder into sentences
 * a dispatcher can act on. At most three request lines, so the card stays short.
 */
export function planQualityAdvice(input: {
  readonly plan: QualityPlan;
  readonly unassignedCount: number;
  readonly activePolicy: PolicyId;
  readonly requests: readonly QualityRequest[];
  readonly engineers: readonly QualityEngineer[];
}): PlanQualityAdvice {
  const band = qualityBand(input.plan);
  const total = Math.max(1, input.plan.visitsTotal);
  const latePhrase = lateCountPhrase(input.plan.expectedLate);
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
  const summary = `В типичный день опаздывает ${latePhrase} из ${total}. Проверка прожила день много раз с разным трафиком и длительностью работ.`;
  return {
    band,
    title: TITLES[band],
    summary,
    lines,
  };
}

/** "~1 заявка", "~2 заявки", "~8 заявок", "меньше одной заявки". */
function lateCountPhrase(expectedLate: number): string {
  if (expectedLate < 0.95) return 'меньше одной заявки';
  const count = Math.round(expectedLate);
  const form = count % 10 === 1 && count % 100 !== 11 ? 'заявка' : count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 10 || count % 100 >= 20) ? 'заявки' : 'заявок';
  return `~${count} ${form}`;
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
