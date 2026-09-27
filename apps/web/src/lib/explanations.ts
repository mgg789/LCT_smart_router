import type {
  AssignmentReasons,
  DashboardSnapshot,
  EngineerDayView,
  EngineerView,
  PlanAssignmentView,
  PlanRouteView,
  PolicyId,
  RequestView,
} from '../api/types';
import { engineerSummaries, requestById, unassignedRequests } from '../domain/dashboard';
import { t } from '../i18n';
import { POLICY_LABELS, skillLabel, transportLabel } from './reasons';
import { formatClock, formatDurationMin, formatKm } from './time';

export type FactIcon = 'skills' | 'transport' | 'equipment' | 'window' | 'lunch' | 'route';

export interface IconFact {
  readonly icon: FactIcon;
  readonly text: string;
}

export interface CaseExplanation {
  readonly title: string;
  readonly facts: string[];
  readonly baseFacts?: string[];
  readonly iconFacts?: IconFact[];
  readonly influence: string;
  readonly result: string;
}

/**
 * Build a dispatcher explanation from the current snapshot, not a stock phrase.
 * Shape is always Facts → Influence → Result (context/11).
 */
export function explainSelection(
  snapshot: DashboardSnapshot,
  request: RequestView | null,
  assignment: PlanAssignmentView | null,
  engineer: EngineerView | null,
  route: PlanRouteView | null,
): CaseExplanation | null {
  let explanation: CaseExplanation | null;
  if (request) {
    if (assignment?.status === 'unassigned') {
      explanation = explainUnassigned(snapshot, request, assignment);
    } else {
      explanation = explainAssigned(snapshot, request, assignment, engineer, route);
    }
  } else if (engineer) {
    explanation =
      route && route.assignedCount > 0
        ? explainRoute(snapshot, engineer, route)
        : explainIdleEngineer(snapshot, engineer);
  } else {
    explanation = null;
  }
  const iconFacts = decisionIconFacts(snapshot, request, engineer, route);
  return explanation
    ? {
        ...explanation,
        iconFacts,
        baseFacts: iconFacts.map((fact) => fact.text),
      }
    : null;
}

/** Short decision or engineer lines, one icon each. */
function decisionIconFacts(
  snapshot: DashboardSnapshot,
  request: RequestView | null,
  engineer: EngineerView | null,
  route: PlanRouteView | null,
): IconFact[] {
  if (request) return requestDecisionFacts(snapshot, request, engineer, route);
  if (engineer) return engineerParameterFacts(snapshot, engineer, route);
  return [];
}

function requestDecisionFacts(
  snapshot: DashboardSnapshot,
  request: RequestView,
  engineer: EngineerView | null,
  route: PlanRouteView | null,
): IconFact[] {
  const chosen =
    engineer ??
    snapshot.engineers.find((item) => item.id === assignmentEngineerId(snapshot, request.id));
  const name = chosen?.displayName ?? t('lib.explanations.35329e6dbe');
  const selected = chosen ? snapshot.engineers.find((item) => item.id === chosen.id) : null;
  const lines: IconFact[] = [];
  if (chosen) {
    lines.push({
      icon: 'skills',
      text: chosen.skills.includes(request.requiredSkill)
        ? t('lib.explanations.768e43b8b6', {
            value0: skillLabel(request.requiredSkill),
            value1: name,
          })
        : t('lib.explanations.c818b56af5', {
            value0: skillLabel(request.requiredSkill),
            value1: name,
          }),
    });
    lines.push({
      icon: 'transport',
      text:
        chosen.transportType === 'car'
          ? t('lib.explanations.7863feaa0f', { value0: name })
          : t('lib.explanations.a575707750', {
              value0: name,
              value1: transportLabel(chosen.transportType),
            }),
    });
  } else {
    lines.push({
      icon: 'skills',
      text: t('lib.explanations.c16d9150d5', { value0: skillLabel(request.requiredSkill) }),
    });
  }
  if (request.requiredEquipment) {
    const stock = selected?.day?.equipmentStock;
    const count = stock ? stockCount(stock, request.requiredEquipment) : 0;
    lines.push({
      icon: 'equipment',
      text:
        count > 0
          ? t('lib.explanations.0fc2486121', {
              value0: equipmentLabel(request.requiredEquipment),
              value1: count,
            })
          : t('lib.explanations.3adaa028b1', { value0: equipmentLabel(request.requiredEquipment) }),
    });
  }
  lines.push({
    icon: 'window',
    text: chosen
      ? t('lib.explanations.bfbf0a20d2', {
          value0: formatClock(request.windowStartAt),
          value1: formatClock(request.windowEndAt),
          value2: name,
        })
      : t('lib.explanations.a073664543', {
          value0: formatClock(request.windowStartAt),
          value1: formatClock(request.windowEndAt),
        }),
  });
  const lunchLine = lunchFact(selected, route);
  if (lunchLine) lines.push(lunchLine);
  if (route && chosen) {
    lines.push({
      icon: 'route',
      text: t('lib.explanations.59ce4d44ad', {
        value0: route.assignedCount,
        value1: formatKm(route.distanceKm),
      }),
    });
  }
  return lines;
}

function engineerParameterFacts(
  snapshot: DashboardSnapshot,
  engineer: EngineerView,
  route: PlanRouteView | null,
): IconFact[] {
  const selected = snapshot.engineers.find((item) => item.id === engineer.id);
  const day = selected?.day ?? null;
  const lines: IconFact[] = [
    {
      icon: 'skills',
      text: t('lib.explanations.dafa5189bf', {
        value0: engineer.skills.map(skillLabel).join(', ') || t('lib.explanations.f297d20da1'),
      }),
    },
    {
      icon: 'transport',
      text: t('lib.explanations.1e0732bce0', { value0: transportLabel(engineer.transportType) }),
    },
  ];
  if (day?.equipmentStock) {
    const stock = day.equipmentStock;
    lines.push({
      icon: 'equipment',
      text: t('lib.explanations.69b9401149', {
        value0: stock.router,
        value1: stock.setTopBox,
        value2: stock.smartSpeaker,
      }),
    });
  }
  if (day) {
    lines.push({
      icon: 'window',
      text: t('lib.explanations.254d3b1850', {
        value0: formatClock(day.shiftStartAt),
        value1: formatClock(day.shiftEndAt),
      }),
    });
  }
  const lunchLine = lunchFact(selected, route);
  lines.push(lunchLine ?? { icon: 'lunch', text: t('lib.explanations.f17c078636') });
  lines.push({
    icon: 'route',
    text: route
      ? t('lib.explanations.da3c9b7150', {
          value0: route.assignedCount,
          value1: formatKm(route.distanceKm),
        })
      : t('lib.explanations.43fae4fe88'),
  });
  return lines;
}

function lunchFact(
  engineer: (EngineerView & { day?: EngineerDayView | null }) | null | undefined,
  route: PlanRouteView | null,
): IconFact | null {
  const lunch = route?.stops.find((stop) => stop.kind === 'lunch');
  const actualStart = engineer?.day?.lunch.startedAt ?? lunch?.startAt ?? null;
  if (actualStart !== null) {
    const actualEnd = lunch?.endAt ?? engineer?.day?.lunch.windowEndAt ?? null;
    const planned = engineer?.day?.lunch.windowStartAt ?? null;
    const shifted = planned !== null && Math.abs(actualStart - planned) >= 60;
    return {
      icon: 'lunch',
      text: shifted
        ? t('lib.explanations.bb6795dd14', {
            value0: formatClock(actualStart),
            value1: actualEnd ? `–${formatClock(actualEnd)}` : '',
          })
        : t('lib.explanations.6979ffddc5', {
            value0: formatClock(actualStart),
            value1: actualEnd ? `–${formatClock(actualEnd)}` : '',
          }),
    };
  }
  if (engineer?.day?.lunch.enabled === false || route?.lunchStatus === 'disabled') {
    return { icon: 'lunch', text: t('lib.explanations.2c6d19ac14') };
  }
  return null;
}

function assignmentEngineerId(snapshot: DashboardSnapshot, requestId: string): string | null {
  return (
    snapshot.plan.plan?.assignments.find((item) => item.requestId === requestId)?.engineerId ?? null
  );
}

function stockCount(
  stock: { router: number; setTopBox: number; smartSpeaker: number },
  type: NonNullable<RequestView['requiredEquipment']>,
): number {
  if (type === 'router') return stock.router;
  if (type === 'set_top_box') return stock.setTopBox;
  return stock.smartSpeaker;
}

function equipmentLabel(type: NonNullable<RequestView['requiredEquipment']>): string {
  return {
    router: t('lib.explanations.4037da5b81'),
    set_top_box: t('lib.explanations.140d6d4877'),
    smart_speaker: t('lib.explanations.24e5c4c34e'),
  }[type];
}

function explainAssigned(
  snapshot: DashboardSnapshot,
  request: RequestView,
  assignment: PlanAssignmentView | null,
  engineer: EngineerView | null,
  route: PlanRouteView | null,
): CaseExplanation {
  const chosen = engineer ?? snapshot.engineers.find((item) => item.id === assignment?.engineerId);
  const name = chosen?.displayName ?? t('lib.explanations.daf982a580');
  const facts = assignment ? firstFactorFacts(assignment.reasons) : undefined;
  const stop = route?.stops.find((item) => item.requestId === request.id);
  const previousJob = previousRequest(snapshot, route, request.id);
  const travelMin = minutesFromFacts(
    facts,
    'travel_time_sec',
    stop && route ? inboundTravelSec(route, stop.sequence) : null,
  );
  const travelKm =
    numberFromFacts(facts, 'distance_km') ?? inboundDistanceKm(route, stop?.sequence ?? null);
  const marginSec = numberFromFacts(facts, 'window_end_margin_sec');
  const margin = marginSec ?? (stop ? request.windowEndAt - stop.startAt : null);
  const sameRegionIdle = idleInRegion(snapshot, request.region).filter(
    (item) => item.engineerId !== chosen?.id,
  );
  const skilledIdle = sameRegionIdle.filter((item) => item.skills.includes(request.requiredSkill));

  const factsLines = [
    t('lib.explanations.7eafb85952', {
      value0: skillLabel(request.requiredSkill),
      value1: formatClock(request.windowStartAt),
      value2: formatClock(request.windowEndAt),
      value3: formatDurationMin(request.serviceDurationSec),
    }),
    chosen
      ? t('lib.explanations.e51f69e4d2', {
          value0: name,
          value1: chosen.skills.map(skillLabel).join(', ') || t('lib.explanations.f297d20da1'),
          value2: transportLabel(chosen.transportType),
          value3: route?.assignedCount ?? 0,
        })
      : t('lib.explanations.8c8e3de7c1', { value0: name }),
    previousJob
      ? t('lib.explanations.b4875e2f66', {
          value0: previousJob.id,
          value1: previousJob.workTypeTitle ? ` (${previousJob.workTypeTitle})` : '',
          value2: travelMin !== null ? t('lib.explanations.b8f4af3b7c', { value0: travelMin }) : '',
          value3: travelKm !== null ? ` / ${formatKm(travelKm)}` : '',
        })
      : t('lib.explanations.de1e8c9f35', {
          value0: travelMin !== null ? t('lib.explanations.b8f4af3b7c', { value0: travelMin }) : '',
          value1: travelKm !== null ? ` / ${formatKm(travelKm)}` : '',
        }),
    stop
      ? t('lib.explanations.1c7a93baf9', {
          value0: formatClock(stop.startAt),
          value1:
            margin !== null
              ? t('lib.explanations.b0fa282aa1', { value0: Math.round(margin / 60) })
              : '',
        })
      : t('lib.explanations.1e52af945e', {
          value0: formatClock(request.windowStartAt),
          value1: formatClock(request.windowEndAt),
        }),
  ];

  const influenceParts = [
    chosen?.skills.includes(request.requiredSkill)
      ? t('lib.explanations.73cde936a1', {
          value0: skillLabel(request.requiredSkill),
          value1: name,
        })
      : t('lib.explanations.93ce4145b0'),
    margin !== null && margin >= 0
      ? t('lib.explanations.032dbafeb1')
      : t('lib.explanations.d1507b6c0c'),
    skilledIdle.length
      ? t('lib.explanations.b596f813ac', {
          value0: skilledIdle.map((item) => item.displayName).join(', '),
        })
      : sameRegionIdle.length
        ? t('lib.explanations.7d7ce94439', {
            value0: sameRegionIdle.map((item) => item.displayName).join(', '),
            value1: skillLabel(request.requiredSkill),
          })
        : t('lib.explanations.623625ae77'),
  ];

  return {
    title: t('lib.explanations.0986563787', { value0: name }),
    facts: factsLines,
    influence: influenceParts.join(' '),
    result: t('lib.explanations.d06456bc40', { value0: request.id, value1: name }),
  };
}

function explainUnassigned(
  snapshot: DashboardSnapshot,
  request: RequestView,
  assignment: PlanAssignmentView,
): CaseExplanation {
  const facts = firstFactorFacts(assignment.reasons);
  const code = assignment.reasons.assignment?.factors[0]?.code ?? 'NO_FEASIBLE_ASSIGNMENT_FOUND';
  const regional = engineersInRegion(snapshot, request.region);
  const skilled = regional.filter((item) => item.skills.includes(request.requiredSkill));
  const idle = idleInRegion(snapshot, request.region);
  const idleSkilled = idle.filter((item) => item.skills.includes(request.requiredSkill));
  const idleFromFacts = csv(facts, 'idle_skilled_ids').map((id) => engineerName(snapshot, id));
  const idleNames = unique(idleSkilled.map((item) => item.displayName).concat(idleFromFacts));

  const factsLines = [
    t('lib.explanations.e79a55ac51', {
      value0: request.id,
      value1: skillLabel(request.requiredSkill),
      value2: formatClock(request.windowStartAt),
      value3: formatClock(request.windowEndAt),
      value4: formatDurationMin(request.serviceDurationSec),
    }),
    request.region
      ? t('lib.explanations.a82ce5befa', {
          value0: request.region,
          value1: regional.length,
          value2: skilled.length,
        })
      : t('lib.explanations.8505720fa2', {
          value0: snapshot.engineers.length,
          value1: skilled.length,
        }),
    idle.length
      ? t('lib.explanations.1c73076c99', {
          value0: idle
            .map(
              (item) =>
                `${item.displayName} (${item.skills.map(skillLabel).join(', ') || t('lib.explanations.7ddc9df9fd')})`,
            )
            .join('; '),
        })
      : t('lib.explanations.4641ad4844'),
    t('lib.explanations.a06fbaca4c', { value0: policyTitle(snapshot.policyId) }),
  ];

  let influence: string;
  if (code === 'NO_SKILL_MATCH' || code === 'skill_missing' || skilled.length === 0) {
    influence = t('lib.explanations.d4b8069f14', { value0: skillLabel(request.requiredSkill) });
  } else if (code === 'NO_TRANSPORT_MATCH' || code === 'transport_mismatch') {
    influence = t('lib.explanations.c95b9173c0');
  } else if (code === 'NO_EQUIPMENT_STOCK') {
    influence = t('lib.explanations.4be419cf74');
  } else if (code === 'NO_AVAILABLE_ENGINEER' || code === 'NO_REGION_MATCH') {
    influence = t('lib.explanations.8079bca88b');
  } else if (idleSkilled.length || idleNames.length) {
    influence = t('lib.explanations.2f64f1a2aa', { value0: idleNames.join(', ') });
  } else if (idle.length) {
    influence = t('lib.explanations.f9f811c6f1', {
      value0: idle.map((item) => item.displayName).join(', '),
      value1: skillLabel(request.requiredSkill),
      value2:
        unique(idle.flatMap((item) => item.skills))
          .map(skillLabel)
          .join(', ') || t('lib.explanations.c1b36f91a9'),
    });
  } else {
    influence = t('lib.explanations.df3452ec71', { value0: skillLabel(request.requiredSkill) });
  }

  return {
    title: t('lib.explanations.9da41e73a4'),
    facts: factsLines,
    influence,
    result:
      code === 'NO_SKILL_MATCH' || code === 'skill_missing' || skilled.length === 0
        ? t('lib.explanations.48c2258d01', {
            value0: request.id,
            value1: skillLabel(request.requiredSkill),
          })
        : t('lib.explanations.841816ee81', { value0: request.id }),
  };
}

function explainRoute(
  snapshot: DashboardSnapshot,
  engineer: EngineerView,
  route: PlanRouteView,
): CaseExplanation {
  const jobs = route.stops
    .filter((stop) => stop.kind === 'job' && stop.requestId)
    .map((stop) => requestById(snapshot, stop.requestId as string))
    .filter((item): item is RequestView => item !== null);
  const sequence = jobs
    .map(
      (job, index) =>
        `${index + 1}) №${job.id} «${job.workTypeTitle ?? skillLabel(job.requiredSkill)}»`,
    )
    .join('; ');
  const travelMin = Math.round(route.travelTimeSec / 60);
  const facts = [
    t('lib.explanations.7f3212a3ea', {
      value0: engineer.displayName,
      value1: engineer.skills.map(skillLabel).join(', ') || t('lib.explanations.f297d20da1'),
      value2: transportLabel(engineer.transportType),
    }),
    t('lib.explanations.072845fd7d', {
      value0: route.assignedCount,
      value1: formatKm(route.distanceKm),
      value2: travelMin,
    }),
    sequence
      ? t('lib.explanations.43414df9b0', { value0: sequence })
      : t('lib.explanations.e95039b883'),
    t('lib.explanations.ef9a05dba0', { value0: policyTitle(snapshot.policyId) }),
  ];
  const first = jobs[0];
  const influence = first
    ? t('lib.explanations.6e89ed1b08', {
        value0: first.id,
        value1: formatClock(first.windowStartAt),
        value2: formatClock(first.windowEndAt),
      })
    : t('lib.explanations.f002bd1363');
  return {
    title: t('lib.explanations.42caed49a5', { value0: engineer.displayName }),
    facts,
    influence,
    result: t('lib.explanations.7f4c0ff00b', {
      value0: route.assignedCount,
      value1: formatKm(route.distanceKm),
    }),
  };
}

function explainIdleEngineer(snapshot: DashboardSnapshot, engineer: EngineerView): CaseExplanation {
  const leftover = unassignedRequests(snapshot).filter(
    (request) => !request.region || !engineer.region || request.region === engineer.region,
  );
  const leftoverSkills = unique(leftover.map((item) => item.requiredSkill));
  const matching = leftover.filter((request) => engineer.skills.includes(request.requiredSkill));
  const facts = [
    t('lib.explanations.b420fc96d1', {
      value0: engineer.displayName,
      value1: engineer.region ?? t('lib.explanations.646eca0d4c'),
      value2: engineer.skills.map(skillLabel).join(', ') || t('lib.explanations.f297d20da1'),
      value3: transportLabel(engineer.transportType),
    }),
    t('lib.explanations.d41b12bec6'),
    leftover.length
      ? t('lib.explanations.92ab72574f', {
          value0: leftover.length,
          value1: leftover
            .slice(0, 4)
            .map((item) => `№${item.id} «${skillLabel(item.requiredSkill)}»`)
            .join(', '),
          value2: leftover.length > 4 ? '…' : '',
        })
      : t('lib.explanations.3548b0dfaf'),
    t('lib.explanations.a06fbaca4c', { value0: policyTitle(snapshot.policyId) }),
  ];
  let influence: string;
  if (!leftover.length) {
    influence = t('lib.explanations.1a68b1e1c5');
  } else if (!matching.length) {
    influence = t('lib.explanations.828dffccf1', {
      value0: leftoverSkills.map(skillLabel).join(', '),
      value1: engineer.displayName,
    });
  } else if (snapshot.policyId === 'compact') {
    influence = t('lib.explanations.9d92e6ec14', { value0: matching.length });
  } else if (snapshot.policyId === 'covering') {
    influence = t('lib.explanations.f150a49b37');
  } else {
    influence = t('lib.explanations.c955a46240');
  }
  return {
    title: t('lib.explanations.44e3a67213', { value0: engineer.displayName }),
    facts,
    influence,
    result: leftover.length
      ? t('lib.explanations.cf97e99338', { value0: engineer.displayName, value1: leftover.length })
      : t('lib.explanations.d0ec564f77', { value0: engineer.displayName }),
  };
}

function policyTitle(policyId: PolicyId): string {
  return POLICY_LABELS[policyId] ?? policyId;
}

function engineersInRegion(snapshot: DashboardSnapshot, region: string | null) {
  return snapshot.engineers.filter((item) => !region || !item.region || item.region === region);
}

function idleInRegion(snapshot: DashboardSnapshot, region: string | null) {
  const summaries = new Map(engineerSummaries(snapshot).map((item) => [item.engineerId, item]));
  return engineersInRegion(snapshot, region)
    .map((item) => summaries.get(item.id))
    .filter(
      (item): item is NonNullable<typeof item> => item !== undefined && item.assignedCount === 0,
    );
}

function previousRequest(
  snapshot: DashboardSnapshot,
  route: PlanRouteView | null,
  requestId: string,
): RequestView | null {
  if (!route) {
    return null;
  }
  const jobs = route.stops.filter((stop) => stop.kind === 'job' && stop.requestId);
  const index = jobs.findIndex((stop) => stop.requestId === requestId);
  const previous = index > 0 ? jobs[index - 1] : null;
  return previous?.requestId ? requestById(snapshot, previous.requestId) : null;
}

function inboundTravelSec(route: PlanRouteView, sequence: number): number | null {
  const stop = route.stops.find((item) => item.sequence === sequence);
  if (!stop) {
    return null;
  }
  const incoming = route.legs.find((leg) => {
    const target = route.stops.find((item) => item.sequence === sequence);
    return target !== undefined && leg.arrivalAt === target.arrivalAt;
  });
  return incoming?.travelTimeSec ?? null;
}

function inboundDistanceKm(route: PlanRouteView | null, sequence: number | null): number | null {
  if (!route || sequence === null) {
    return null;
  }
  const stop = route.stops.find((item) => item.sequence === sequence);
  if (!stop) {
    return null;
  }
  const incoming = route.legs.find((leg) => leg.arrivalAt === stop.arrivalAt);
  return incoming?.distanceKm ?? null;
}

function firstFactorFacts(reasons: AssignmentReasons): Record<string, unknown> | undefined {
  return reasons.assignment?.factors[0]?.facts;
}

function numberFromFacts(facts: Record<string, unknown> | undefined, key: string): number | null {
  const value = facts?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function minutesFromFacts(
  facts: Record<string, unknown> | undefined,
  key: string,
  fallback: number | null,
): number | null {
  const sec = numberFromFacts(facts, key) ?? fallback;
  return sec === null ? null : Math.round(sec / 60);
}

function csv(facts: Record<string, unknown> | undefined, key: string): string[] {
  const value = facts?.[key];
  return typeof value === 'string' && value.length > 0 ? value.split(',').filter(Boolean) : [];
}

function engineerName(snapshot: DashboardSnapshot, id: string): string {
  return snapshot.engineers.find((item) => item.id === id)?.displayName ?? id;
}

function unique(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))];
}
