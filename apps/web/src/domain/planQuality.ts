/**
 * Dispatcher-facing reading of a dry situation prediction.
 *
 * Bands match the documented thresholds: 90% and above is reliable, 70–90% has
 * weak spots, below 70% is fragile. The text never names the simulator.
 */

export type QualityBand = 'green' | 'yellow' | 'red';

export interface QualityRequest {
  readonly requestId: string;
  readonly label: string;
  readonly breachProb: number | null;
}

export interface QualityEngineer {
  readonly name: string;
  readonly overrunProb: number;
}

export interface PlanQualityAdvice {
  readonly band: QualityBand;
  readonly title: string;
  readonly summary: string;
  readonly lines: readonly string[];
}

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
      ? 'Одна заявка без назначения.'
      : `${input.unassignedCount} заявок без назначения.`;
  return {
    band: 'red',
    title: 'План хрупкий',
    summary: 'В маршрутах нет заявок, поэтому день ещё не из чего проверять.',
    lines: [
      uncovered,
      input.rosterOffline
        ? 'Инженеры не вышли на линию, поэтому назначать некого. Когда смена начнётся, проверку можно запустить снова.'
        : 'Проверка запускается, когда в плане появляется хотя бы один визит.',
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
  readonly requests: readonly QualityRequest[];
  readonly engineers: readonly QualityEngineer[];
}): PlanQualityAdvice {
  const band = qualityBand(input.robustness);
  const days = reliableDaysOutOfTen(input.robustness);
  const title =
    band === 'green' ? 'План надёжен' : band === 'yellow' ? 'Есть слабые места' : 'План хрупкий';
  const summary = `${days} из 10 дней без опозданий. Мы мысленно прожили день много раз с разным трафиком и длительностями работ.`;
  const lines: string[] = [];
  if (input.unassignedCount > 0) {
    lines.push(
      input.unassignedCount === 1
        ? 'Одна заявка без назначения. «Полное покрытие» забирает такой остаток, если хватает навыка и оборудования.'
        : `${input.unassignedCount} заявок без назначения. «Полное покрытие» забирает такой остаток, если хватает навыка и оборудования.`,
    );
  }
  const risky = input.requests
    .filter((request) => (request.breachProb ?? 0) >= 0.2)
    .sort((left, right) => (right.breachProb ?? 0) - (left.breachProb ?? 0))
    .slice(0, 3);
  for (const request of risky) {
    const share = Math.round((request.breachProb ?? 0) * 100);
    lines.push(
      `${request.label} опаздывает в ${share}% проверок. Более раннее окно или политика «Быстрее до клиента» снижает риск.`,
    );
  }
  for (const engineer of input.engineers.filter((item) => item.overrunProb >= 0.3).slice(0, 2)) {
    lines.push(
      `${engineer.name} может не уложиться в смену. «Ровнее загрузка» разнесёт работу по свободным.`,
    );
  }
  if (lines.length === 0) {
    lines.push('Менять политику не нужно: в большинстве проверок день проходит без опозданий.');
  }
  return { band, title, summary, lines };
}
