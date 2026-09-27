import type { PolicyId } from '../api/types';
import { t } from '../i18n';

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
  green: t('domain.planQuality.edeb94fe86'),
  yellow: t('domain.planQuality.4e891d562d'),
  red: t('domain.planQuality.9a90fc788d'),
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
      ? t('domain.planQuality.e7e85e7d2c')
      : t('domain.planQuality.b7e0a562f8', { value0: input.unassignedCount });
  return {
    band: 'red',
    title: TITLES.red,
    summary: t('domain.planQuality.cd9edaff65'),
    lines: [
      textLine(uncovered),
      textLine(
        input.rosterOffline
          ? t('domain.planQuality.30e395ddc2')
          : t('domain.planQuality.a0fa3fc616'),
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
        ? t('domain.planQuality.2eabc8c909')
        : input.activePolicy === 'sla'
          ? t('domain.planQuality.d2405e8f23')
          : t('domain.planQuality.3925f7569d');
    lines.push({
      before: t('domain.planQuality.564feb0f79'),
      requestId: request.requestId,
      shortId: request.shortId,
      after: t('domain.planQuality.b17baca053', { value0: share, value1: remedy }),
    });
  }
  for (const engineer of input.engineers.filter((item) => item.overrunProb >= 0.3).slice(0, 2)) {
    lines.push(
      textLine(
        input.activePolicy === 'balanced'
          ? t('domain.planQuality.79463780ad', { value0: engineer.name })
          : t('domain.planQuality.5986a59fc3', { value0: engineer.name }),
      ),
    );
  }
  if (lines.length === 0) {
    lines.push(textLine(t('domain.planQuality.e11f38ef7c')));
  }
  const summary = t('domain.planQuality.e57713f5e8', { value0: latePhrase, value1: total });
  return {
    band,
    title: TITLES[band],
    summary,
    lines,
  };
}

/** "~1 заявка", "~2 заявки", "~8 заявок", "меньше одной заявки". */
function lateCountPhrase(expectedLate: number): string {
  if (expectedLate < 0.95) return t('domain.planQuality.426a2aac0b');
  const count = Math.round(expectedLate);
  const form =
    count % 10 === 1 && count % 100 !== 11
      ? t('domain.planQuality.672e27048b')
      : count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 10 || count % 100 >= 20)
        ? t('domain.planQuality.39bcdf6888')
        : t('domain.planQuality.a2f012e5ff');
  return `~${count} ${form}`;
}

function unassignedLine(count: number, active: PolicyId): string {
  const head = t('common.unassigned', { count });
  if (active === 'covering') {
    return t('domain.planQuality.1198b6b8ab', { value0: head });
  }
  return t('domain.planQuality.fc8981d100', { value0: head });
}

function textLine(text: string): AdviceLine {
  return { before: text, requestId: null, shortId: null, after: '' };
}
