import type {
  AlertAttribution,
  DispatcherPerformanceScore,
  PolicyComparisonEvidence,
  PolicyComparisonRow,
  ScoreComponent,
} from './types';

/** Dispatcher performance weights. The two parts always add to 100 points. */
export const ALERT_PROCESSING_WEIGHT = 0.7;
export const POLICY_CHOICE_WEIGHT = 0.3;

/** The accepted business-clock thresholds for intervention quality. */
export const FASTEST_THRESHOLD_SEC = 120;
export const TIMELY_THRESHOLD_SEC = 600;
export const END_OF_DAY_HOUR_MOSCOW = 17;

/** True when a timestamp is after 17:00 in the Moscow business zone. */
export function isMoscowEndOfDay(timestampSec: number): boolean {
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Moscow',
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(timestampSec * 1000)),
  );
  return hour >= END_OF_DAY_HOUR_MOSCOW;
}

/**
 * Returns the exact ordinal quality assigned to one attributed intervention.
 * `system` is intentionally not treated as AI: only an authenticated AI operation may
 * receive the AI branch, so a timer or a Router result cannot manufacture performance.
 */
export function interventionQuality(attribution: AlertAttribution): {
  score: number;
  label: string;
} {
  if (attribution.firstAction === null) {
    return { score: 0, label: 'unknown' };
  }
  // The handling time ends at the first authenticated action. A later Router result
  // confirms a pending window outcome but must not turn the original intervention into
  // an artificially slow one.
  const actionAt = attribution.firstAction.at;
  const delaySec = Math.max(0, actionAt - attribution.createdAt);
  if (delaySec > TIMELY_THRESHOLD_SEC && isMoscowEndOfDay(actionAt)) {
    return { score: 10, label: 'end-day' };
  }
  if (attribution.firstAction?.actorKind === 'system') {
    return { score: 0, label: 'system-unattributed' };
  }
  const ai = attribution.firstAction.actorSource === 'ai_run';
  if (delaySec <= FASTEST_THRESHOLD_SEC) {
    return { score: ai ? 55 : 100, label: ai ? 'fastest-ai' : 'fastest-manual' };
  }
  if (delaySec <= TIMELY_THRESHOLD_SEC) {
    return { score: ai ? 80 : 90, label: ai ? 'timely-ai' : 'timely-manual' };
  }
  return { score: ai ? 40 : 65, label: ai ? 'slow-ai' : 'slow-manual' };
}

/** Calculates the alert part of the score from durable first-action evidence. */
export function scoreAlertProcessing(
  attributions: readonly AlertAttribution[],
  significantAlertIds: ReadonlySet<string>,
): ScoreComponent {
  if (significantAlertIds.size === 0) {
    return {
      score: 100,
      weight: ALERT_PROCESSING_WEIGHT,
      evaluated: false,
      explanation: 'не оценивалось: значимых алертов нет',
    };
  }
  const byId = new Map(attributions.map((item) => [item.alertId, item]));
  const relevant = [...significantAlertIds].map((id) => byId.get(id) ?? null);
  const resolved = relevant.filter(
    (item): item is AlertAttribution => item?.outcome === 'resolved' && item.resolvedAt !== null,
  );
  const quality = relevant.map((item) =>
    item === null || item.outcome !== 'resolved' || item.firstAction === null
      ? 0
      : interventionQuality(item).score,
  );
  const score = Math.round(
    quality.reduce((sum, item) => sum + item, 0) / Math.max(1, relevant.length),
  );
  return {
    score,
    weight: ALERT_PROCESSING_WEIGHT,
    evaluated: true,
    explanation: `${resolved.length}/${relevant.length} значимых алертов имеют сохранённое успешное вмешательство; нерешённые алерты дают 0`,
  };
}

/** Builds the policy comparison tuple used for deterministic lexicographic ordering. */
function policyTuple(row: PolicyComparisonRow): readonly number[] {
  const urgentCoverage =
    row.metrics.urgentTotal === 0 ? 1 : row.metrics.urgentAssignedCount / row.metrics.urgentTotal;
  const totalCoverage =
    row.metrics.requestsTotal === 0 ? 1 : row.metrics.assignedCount / row.metrics.requestsTotal;
  return [
    urgentCoverage,
    totalCoverage,
    -row.metrics.lateAssignedCount,
    -row.metrics.totalLatenessSec,
    -row.metrics.travelTimeSec,
    -row.metrics.distanceKm,
  ];
}

function compareTuples(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return b - a;
  }
  return 0;
}

/** Calculates a policy-choice score from immutable same-input measured rows. */
export function scorePolicyChoice(
  evidence: PolicyComparisonEvidence | null,
  selectedPolicyId: string | null,
): ScoreComponent {
  if (evidence === null || selectedPolicyId === null) {
    return {
      score: 100,
      weight: POLICY_CHOICE_WEIGHT,
      evaluated: false,
      explanation: 'не измерялось: нет сравнения политик на том же входе',
    };
  }
  // Extra-engineer covering rows are evidence for a separate operational question. They
  // cannot make a fixed-roster policy look worse or better in the selected-policy score.
  const comparable = evidence.rows
    .filter((row) => row.isUsable && row.additionalEngineers === 0)
    .sort((left, right) => {
      const order = compareTuples(policyTuple(left), policyTuple(right));
      return order !== 0 ? order : left.strategyId.localeCompare(right.strategyId);
    });
  const selected = comparable.find((row) => row.strategyId === selectedPolicyId);
  if (!selected || comparable.length === 0) {
    return {
      score: 100,
      weight: POLICY_CHOICE_WEIGHT,
      evaluated: false,
      explanation:
        'не измерялось: для выбранной политики нет сопоставимой строки того же состава бригады',
    };
  }
  const selectedTuple = policyTuple(selected);
  const uniqueTupleKeys = new Set(comparable.map((row) => JSON.stringify(policyTuple(row))));
  const betterTupleKeys = new Set(
    comparable
      .filter((row) => compareTuples(policyTuple(row), selectedTuple) < 0)
      .map((row) => JSON.stringify(policyTuple(row))),
  );
  const rank = betterTupleKeys.size;
  const score =
    uniqueTupleKeys.size === 1
      ? 100
      : Math.round((100 * (uniqueTupleKeys.size - 1 - rank)) / (uniqueTupleKeys.size - 1));
  return {
    score,
    weight: POLICY_CHOICE_WEIGHT,
    evaluated: true,
    explanation: `лексикографическое сравнение: покрытие срочных заявок, общее покрытие, просрочка SLA, затем время в пути; место ${rank + 1}/${uniqueTupleKeys.size}`,
  };
}

/** Combines the two weighted components and preserves not-evaluated explanations. */
export function combineScore(
  alertProcessing: ScoreComponent,
  policyChoice: ScoreComponent,
): DispatcherPerformanceScore {
  const score = Math.round(
    alertProcessing.score * alertProcessing.weight + policyChoice.score * policyChoice.weight,
  );
  const evaluated = alertProcessing.evaluated || policyChoice.evaluated;
  return {
    score,
    evaluated,
    alertProcessing,
    policyChoice,
    explanation: [
      alertProcessing.explanation,
      policyChoice.explanation,
      `взвешенный итоговый балл = ${alertProcessing.score} × 70% + ${policyChoice.score} × 30% = ${score}`,
    ],
  };
}
