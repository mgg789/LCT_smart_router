import { toPlanView } from '../../api/plan-view';
import type { AppliedPlanCurrentShape } from '../../api/plan-view.types';
import {
  readSimulation,
  rememberSimulation,
  simulationPatchHash,
  toRouterPatch,
} from '../../orchestrator/simulator';
import {
  type DispatcherExplanationFactor,
  type DispatcherExplanationSource,
  dispatcherExplanationFactor,
} from '../explain/dispatcher-explanation';
import type { EvidenceReader } from '../explain/evidence.reader';
import type { CandidateEvidence, RequestEvidence } from '../explain/evidence.schema';
import type { DispatcherReadToolDeps } from './dispatcher-read.tools';
import type { ToolResult } from './tool.types';

type Entity =
  | { readonly type: 'request'; readonly id: string }
  | { readonly type: 'route'; readonly engineerId: string }
  | { readonly type: 'leg'; readonly legId: string }
  | { readonly type: 'lunch'; readonly engineerId: string }
  | { readonly type: 'plan' };
type Aspect =
  | 'overview'
  | 'assignment'
  | 'window'
  | 'travel'
  | 'alternatives'
  | 'schedule'
  | 'lunch'
  | 'metrics'
  | 'policy';

interface CurrentBasis {
  readonly publicationId: string | null;
  readonly inputHash: string | null;
  readonly routerContextVersion: string | null;
  readonly plan: AppliedPlanCurrentShape | null;
  readonly planFresh: boolean;
  readonly evidenceFresh: boolean;
}

function ok(summary: string, body: unknown): ToolResult {
  return { ok: true, summary, resultContent: JSON.stringify(body) };
}

/** Collects factual, source-linked dispatcher explanations without invoking a model. */
export async function runDispatcherExplainEntity(
  deps: DispatcherReadToolDeps,
  evidenceReader: EvidenceReader,
  input: { readonly entity: Entity; readonly aspect: Aspect },
): Promise<ToolResult> {
  const basis = await currentBasis(deps);
  const factors: DispatcherExplanationFactor[] = [];
  const unavailable: string[] = [];
  const subject = subjectOf(input.entity);
  const plan = basis.plan;
  const planView = plan ? toPlanView(plan) : null;
  const planSource = sourceOfPlan(plan);
  let requestVersion: { readonly version: number; readonly updatedAt: bigint } | null = null;
  const evidenceSource = routerEvidenceSource(plan, basis);

  if (input.entity.type === 'request') {
    const request = await deps.prisma.request.findUnique({ where: { id: input.entity.id } });
    if (!request) {
      unavailable.push('Заявка не найдена.');
    } else {
      requestVersion = { version: request.version, updatedAt: request.updatedAt };
      const currentSource = currentRequestSource(basis, request.id, Number(request.updatedAt));
      if (input.aspect === 'overview' || input.aspect === 'window') {
        factors.push(
          dispatcherExplanationFactor({
            id: 'request.window',
            label: 'Окно заявки',
            value: {
              startAt: Number(request.windowStartAt),
              endAt: Number(request.windowEndAt),
              origin: request.windowOrigin,
            },
            basis: 'fact',
            source: currentSource,
            subject,
          }),
        );
      }
      if (
        input.aspect === 'overview' ||
        input.aspect === 'assignment' ||
        input.aspect === 'schedule'
      ) {
        const assignment = plan?.assignments.find((row) => row.requestId === request.id);
        if (assignment) {
          factors.push(
            dispatcherExplanationFactor({
              id: 'request.applied_assignment',
              label: 'Назначение в применённом плане',
              value: {
                status: assignment.status,
                engineerId: assignment.engineerId,
                planFresh: basis.planFresh,
              },
              basis: 'fact',
              source: planSource,
              subject,
              limitation: basis.planFresh
                ? undefined
                : 'Факт старой редакции плана; он не описывает текущую публикацию.',
            }),
          );
        } else unavailable.push('В применённом плане нет назначения этой заявки.');
      }
      if (
        input.aspect === 'overview' ||
        input.aspect === 'assignment' ||
        input.aspect === 'schedule' ||
        input.aspect === 'travel' ||
        input.aspect === 'alternatives'
      ) {
        const evidence = requestEvidence(plan, evidenceReader, request.id, basis.evidenceFresh);
        if (evidence) {
          if (input.aspect === 'overview' || input.aspect === 'schedule') {
            factors.push(
              factor(
                'request.schedule',
                'Расчётное расписание',
                {
                  arrivalAt: evidence.arrival_at,
                  startAt: evidence.start_at,
                  endAt: evidence.end_at,
                  waitingTimeSec: evidence.waiting_time_sec,
                  windowStartOffsetSec: evidence.window_start_offset_sec,
                  windowEndMarginSec: evidence.window_end_margin_sec,
                  serviceDurationSec: evidence.service_duration_sec,
                  status: evidence.status,
                },
                'calculation_outcome',
                evidenceSource,
                subject,
              ),
            );
          }
          if (input.aspect === 'overview' || input.aspect === 'travel') {
            factors.push(
              factor(
                'request.travel',
                'Время и расстояние дороги',
                {
                  travelTimeSec: evidence.travel_time_sec,
                  distanceKm: evidence.distance_km,
                  predecessorRequestId: evidence.predecessor_request_id,
                },
                evidence.travel_time_sec === null ? 'unknown' : 'calculation_outcome',
                evidenceSource,
                subject,
                evidence.travel_time_sec === null
                  ? 'В evidence нет рассчитанного значения дороги.'
                  : undefined,
              ),
            );
          }
          if (input.aspect === 'alternatives') {
            factors.push(
              factor(
                'request.alternatives',
                'Проверенные кандидаты',
                evidence.candidates.map(candidateView),
                'calculation_outcome',
                evidenceSource,
                subject,
                'Кандидаты показывают проверки Router, не глобальную переоптимизацию назначения.',
              ),
            );
          }
          if (input.aspect === 'overview' || input.aspect === 'assignment') {
            if (evidence.reasons.length) {
              for (const reason of evidence.reasons) {
                factors.push(
                  factor(
                    `request.reason.${reason.code}`,
                    'Структурированное основание Router',
                    { code: reason.code, text: reason.text, facts: reason.facts },
                    reason.basis,
                    evidenceSource,
                    subject,
                    'Это сохранённое основание результата, не доказательство глобального оптимума.',
                  ),
                );
              }
            } else unavailable.push('В evidence нет структурированных оснований назначения.');
          }
        } else if (
          input.aspect === 'alternatives' ||
          input.aspect === 'travel' ||
          input.aspect === 'schedule'
        ) {
          unavailable.push(
            basis.evidenceFresh
              ? 'Router evidence для заявки отсутствует.'
              : 'Текущего Router evidence нет: версия плана или контекста не совпадает с опубликованной.',
          );
        }
      }
    }
  } else if (input.entity.type === 'plan') {
    if (
      plan &&
      (input.aspect === 'overview' || input.aspect === 'metrics' || input.aspect === 'schedule')
    ) {
      factors.push(
        factor(
          'plan.summary',
          'Сводка применённого плана',
          {
            revision: plan.revision,
            origin: plan.origin,
            planAsOf: Number(plan.planAsOf),
            routeCount: plan.routes.length,
            assignedCount: plan.assignments.filter((row) => row.status === 'assigned').length,
            unassignedCount: plan.assignments.filter((row) => row.status === 'unassigned').length,
          },
          'fact',
          planSource,
          subject,
          basis.planFresh ? undefined : 'Применённая редакция расходится с текущей публикацией.',
        ),
      );
    } else
      unavailable.push(
        plan
          ? `Аспект «${input.aspect}» не представлен для плана.`
          : 'Применённый план отсутствует.',
      );
    if (input.aspect === 'policy')
      unavailable.push(
        'Причина выбора политики и глобальный компромисс не хранятся как проверяемый фактор плана.',
      );
  } else if (input.entity.type === 'route') {
    const engineerId = input.entity.engineerId;
    const route = planView?.routes.find((row) => row.engineerId === engineerId);
    if (!route) unavailable.push('Маршрут инженера отсутствует в применённом плане.');
    else if (
      input.aspect === 'overview' ||
      input.aspect === 'metrics' ||
      input.aspect === 'schedule' ||
      input.aspect === 'lunch'
    ) {
      factors.push(
        factor(
          'route.metrics',
          'Показатели маршрута',
          {
            engineerId: route.engineerId,
            startAt: route.startAt === null ? null : Number(route.startAt),
            finishAt: route.finishAt === null ? null : Number(route.finishAt),
            distanceKm: route.distanceKm,
            travelTimeSec: route.travelTimeSec,
            workTimeSec: route.workTimeSec,
            waitingTimeSec: route.waitingTimeSec,
            lunchTimeSec: route.lunchTimeSec,
            assignedCount: route.assignedCount,
            lunchStatus: route.lunchStatus,
          },
          'fact',
          planSource,
          subject,
          basis.planFresh ? undefined : 'Показатели относятся к старой редакции плана.',
        ),
      );
      if (input.aspect === 'overview' || input.aspect === 'schedule') {
        factors.push(
          factor(
            'route.stops',
            'Остановки и время',
            route.stops.map((stop) => ({
              sequence: stop.sequence,
              kind: stop.kind,
              requestId: stop.requestId,
              arrivalAt: Number(stop.arrivalAt),
              startAt: Number(stop.startAt),
              endAt: Number(stop.endAt),
            })),
            'fact',
            planSource,
            subject,
          ),
        );
      }
      if (input.aspect === 'overview' || input.aspect === 'lunch') {
        factors.push(
          factor(
            'route.lunch',
            'Факт обеда маршрута',
            route.stops.filter((stop) => stop.kind === 'lunch'),
            'fact',
            planSource,
            subject,
            'Доступен сохранённый плановый останов; альтернативное время обеда не рассчитывалось.',
          ),
        );
      }
    } else unavailable.push(`Аспект «${input.aspect}» не представлен для маршрута.`);
  } else if (input.entity.type === 'leg') {
    const legId = input.entity.legId;
    const matches =
      planView?.routes.flatMap((route) =>
        route.legs.filter((leg) => leg.legId === legId).map((leg) => ({ route, leg })),
      ) ?? [];
    const match = matches[0];
    if (!match)
      unavailable.push(
        'Плечо отсутствует в применённом плане либо не имеет проверяемой структуры.',
      );
    else if (input.aspect === 'overview' || input.aspect === 'travel') {
      factors.push(
        factor(
          'leg.travel',
          'Расчётное дорожное плечо',
          {
            engineerId: match.route.engineerId,
            legId: match.leg.legId,
            fromStopId: match.leg.fromStopId,
            toStopId: match.leg.toStopId,
            departureAt: match.leg.departureAt,
            arrivalAt: match.leg.arrivalAt,
            travelTimeSec: match.leg.travelTimeSec,
            distanceKm: match.leg.distanceKm,
            travelSource: match.leg.travelSource,
            trafficFactor: match.leg.trafficFactor,
            segments:
              match.leg.segments?.map((segment) => ({
                travelSource: segment.travelSource,
                travelTimeSec: segment.travelTimeSec,
                distanceKm: segment.distanceKm,
              })) ?? null,
          },
          'calculation_outcome',
          planSource,
          subject,
          [
            !basis.planFresh ? 'Плечо взято из старой редакции плана.' : null,
            'Профиль транспорта и отдельная величина access buffer в сохранённом плече отсутствуют.',
          ]
            .filter((item): item is string => item !== null)
            .join(' '),
        ),
      );
    } else unavailable.push(`Аспект «${input.aspect}» не представлен для дорожного плеча.`);
  } else {
    const engineerId = input.entity.engineerId;
    const route = planView?.routes.find((row) => row.engineerId === engineerId);
    if (!route) unavailable.push('Маршрут инженера отсутствует в применённом плане.');
    else if (
      input.aspect === 'overview' ||
      input.aspect === 'lunch' ||
      input.aspect === 'schedule'
    ) {
      const lunches = route.stops.filter((stop) => stop.kind === 'lunch');
      factors.push(
        factor(
          'lunch.plan',
          'Сохранённый обед',
          lunches.length ? lunches : { status: route.lunchStatus, stops: [] },
          'fact',
          planSource,
          subject,
          'Точное альтернативное время требует отдельного расчёта и здесь не выведено.',
        ),
      );
    } else unavailable.push(`Аспект «${input.aspect}» не представлен для обеда.`);
  }

  const stable =
    (await sameBasis(deps, basis)) &&
    (input.entity.type !== 'request' ||
      !requestVersion ||
      (await requestVersionStillCurrent(deps, input.entity.id, requestVersion)));
  if (!stable)
    unavailable.push(
      'Публикация, версия Router или применённый план изменились во время чтения; результат нельзя считать текущим.',
    );
  if (factors.length === 0 && unavailable.length === 0)
    unavailable.push(`Аспект «${input.aspect}» недоступен для выбранной сущности.`);
  const status = !stable
    ? 'stale'
    : factors.length
      ? unavailable.length
        ? 'partial'
        : 'available'
      : 'unavailable';
  return ok(`${status}: ${factors.length} factor(s)`, {
    schema_version: '1.0',
    status,
    entity: input.entity,
    aspect: input.aspect,
    factors,
    unavailable,
    provenance: {
      publicationId: basis.publicationId,
      inputHash: basis.inputHash,
      routerContextVersion: basis.routerContextVersion,
      appliedPlanRevision: plan?.revision ?? null,
      appliedPlanInputHash: plan
        ? (plan.validatedInputHash ?? plan.routerResult?.inputHash ?? null)
        : null,
      routerEvidenceFresh: basis.evidenceFresh,
    },
  });
}

/** Calculates alternative pins on one published input; only local insertion confirms a pin.
 * Router's bounded fallback does not carry the pin into its optimization constraints.
 */
export async function runDispatcherCompareAssignments(
  deps: DispatcherReadToolDeps,
  evidenceReader: EvidenceReader,
  input: { readonly requestId: string; readonly engineerIds: readonly string[] },
): Promise<ToolResult> {
  const basis = await currentBasis(deps);
  const publicationId = basis.publicationId;
  const inputHash = basis.inputHash;
  const routerContextVersion = basis.routerContextVersion;
  if (!publicationId || !inputHash || !routerContextVersion) {
    return ok('unavailable: no current Router input', {
      schema_version: '1.0',
      status: 'unavailable',
      method: 'router.pin_simulation',
      requestId: input.requestId,
      rows: [],
      unavailable: ['Нет текущей опубликованной задачи и версии Router.'],
    });
  }
  const requestExists = await deps.prisma.request.findUnique({
    where: { id: input.requestId },
    select: { id: true },
  });
  if (!requestExists) {
    return ok('unavailable: request not found', {
      schema_version: '1.0',
      status: 'unavailable',
      method: 'router.pin_simulation',
      requestId: input.requestId,
      rows: [],
      unavailable: ['Заявка не найдена.'],
    });
  }
  const simulations = await Promise.all(
    input.engineerIds.map(async (engineerId) => {
      const patch = toRouterPatch({ pin: { requestId: input.requestId, engineerId } });
      const patchHash = simulationPatchHash(patch);
      const stored = await readSimulation(deps.prisma, inputHash, routerContextVersion, patchHash);
      return {
        engineerId,
        patch,
        patchHash,
        result: stored ?? (await deps.router.simulate(patch)),
        cached: Boolean(stored),
      };
    }),
  );
  const stable = await sameBasis(deps, basis);
  const echoesMatch = simulations.every(
    (row) =>
      row.result.input_hash === inputHash &&
      row.result.router_context_version === routerContextVersion &&
      row.result.patch_hash === row.patchHash &&
      (row.result.input_publication_id === publicationId ||
        row.result.input_publication_id === 'stored'),
  );
  const baselineKeys = simulations.map((row) => JSON.stringify(row.result.delta?.before ?? null));
  const methods = new Set(simulations.map((row) => row.result.method));
  const baselineMatch = baselineKeys.every((key) => key === baselineKeys[0] && key !== 'null');
  const available = Boolean(stable && echoesMatch && baselineMatch);
  const confirmedCount = available
    ? simulations.filter((row) => row.result.method === 'insertion' && row.result.delta).length
    : 0;
  const status = !stable
    ? 'stale'
    : confirmedCount === simulations.length
      ? 'compared'
      : confirmedCount > 0
        ? 'partial'
        : 'unavailable';
  const evidence =
    basis.plan && basis.evidenceFresh
      ? evidenceReader.forRequest(basis.plan.routerResult?.payload, input.requestId).main
      : null;
  const rows = available
    ? simulations.map(({ engineerId, patchHash, result, cached }) =>
        result.method !== 'insertion'
          ? {
              engineerId,
              method: result.method,
              outcome: 'pin_not_verified',
              evidenceCheck: candidateView(
                evidence?.candidates.find((candidate) => candidate.engineer_id === engineerId),
              ),
              limitations: [
                'Общий поиск Router не сохраняет закрепление за этим инженером. Его метрики не являются оценкой запрошенного назначения.',
              ],
            }
          : {
              engineerId,
              method: result.method,
              baseline: result.delta?.before ?? null,
              simulated: result.delta?.after ?? null,
              delta: result.delta ?? null,
              routes: result.routes ?? [],
              limitations: [
                'Router проверил вставки в фиксированный порядок остальных заявок своего базового плана; это не полная глобальная переоптимизация.',
              ],
              evidenceCheck: candidateView(
                evidence?.candidates.find((candidate) => candidate.engineer_id === engineerId),
              ),
              provenance: {
                publicationId:
                  result.input_publication_id === 'stored'
                    ? publicationId
                    : result.input_publication_id,
                inputHash: result.input_hash,
                routerContextVersion: result.router_context_version,
                patchHash,
                cached: cached || result.cached,
              },
            },
      )
    : input.engineerIds.map((engineerId) => ({ engineerId, outcome: 'unknown' as const }));
  if (available) {
    for (const { patch, result, cached } of simulations) {
      if (!cached) await rememberSimulation(deps.prisma, patch, result);
    }
  }
  return ok(`${status}: ${rows.length} candidate(s)`, {
    schema_version: '1.0',
    status,
    method: 'router.pin_simulation',
    comparisonScope:
      'Отдельная симуляция закрепления заявки за каждым инженером на одном опубликованном inputHash и версии Router. Это локальные counterfactual-варианты, не доказательство глобально лучшего назначения.',
    requestId: input.requestId,
    sharedBaseline: baselineMatch ? (simulations[0]?.result.delta?.before ?? null) : null,
    sharedMethod: methods.size === 1 ? (simulations[0]?.result.method ?? null) : null,
    rows,
    provenance: {
      publicationId,
      inputHash,
      routerContextVersion,
      appliedPlanRevision: basis.plan?.revision ?? null,
      evidenceSchemaVersion: evidence ? '1.0' : null,
    },
    unavailable: !stable
      ? ['Контекст изменился во время сравнения; повторите запрос.']
      : !echoesMatch
        ? [
            'Одна из симуляций вернула несовпадающие hash, publication, context или patch; результаты исключены.',
          ]
        : !baselineMatch
          ? ['Router вернул разные baseline либо не вернул baseline; результаты несопоставимы.']
          : confirmedCount < simulations.length
            ? [
                'Для части вариантов закрепление не подтверждено. Только строки insertion являются вычисленными контрфактами; общий поиск не доказывает невозможность назначения.',
              ]
            : [],
  });
}

async function currentBasis(deps: DispatcherReadToolDeps): Promise<CurrentBasis> {
  const [publication, plan, routerContextVersion] = await Promise.all([
    deps.prisma.routingCurrent.findUnique({
      where: { id: 'singleton' },
      include: { snapshot: true },
    }),
    deps.plans.current(deps.prisma),
    deps.router.getActiveContextVersion(),
  ]);
  const inputHash = publication?.snapshot.inputHash ?? null;
  const planInputHash = plan
    ? (plan.validatedInputHash ?? plan.routerResult?.inputHash ?? null)
    : null;
  const planFresh = Boolean(inputHash && planInputHash === inputHash);
  const evidenceFresh = Boolean(
    plan?.origin === 'auto' &&
      plan.routerResult?.accepted &&
      plan.routerResult.inputHash === inputHash &&
      plan.routerResult.routerContextVersion === routerContextVersion,
  );
  return {
    publicationId: publication?.snapshot.id ?? null,
    inputHash,
    routerContextVersion,
    plan,
    planFresh,
    evidenceFresh,
  };
}

async function sameBasis(deps: DispatcherReadToolDeps, basis: CurrentBasis): Promise<boolean> {
  const latest = await deps.prisma.routingCurrent.findUnique({
    where: { id: 'singleton' },
    include: { snapshot: true },
  });
  const [plan, context] = await Promise.all([
    deps.plans.current(deps.prisma),
    deps.router.getActiveContextVersion(),
  ]);
  return Boolean(
    (latest?.snapshot.id ?? null) === basis.publicationId &&
      (latest?.snapshot.inputHash ?? null) === basis.inputHash &&
      context === basis.routerContextVersion &&
      plan?.revision === basis.plan?.revision,
  );
}

function requestEvidence(
  plan: AppliedPlanCurrentShape | null,
  reader: EvidenceReader,
  requestId: string,
  fresh: boolean,
): RequestEvidence | null {
  if (!plan || !fresh) return null;
  return reader.forRequest(plan.routerResult?.payload, requestId).main;
}

function sourceOfPlan(plan: AppliedPlanCurrentShape | null): DispatcherExplanationSource {
  return {
    kind: 'applied_plan',
    id: plan?.id ?? null,
    planRevision: plan?.revision ?? null,
    inputHash: plan ? (plan.validatedInputHash ?? plan.routerResult?.inputHash ?? null) : null,
    routerContextVersion: plan?.routerResult?.routerContextVersion ?? null,
    recordedAt: plan ? Number(plan.appliedAt) : null,
  };
}

function currentRequestSource(
  basis: CurrentBasis,
  requestId: string,
  updatedAt: number,
): DispatcherExplanationSource {
  return {
    kind: 'current_request',
    id: requestId,
    planRevision: null,
    inputHash: basis.inputHash,
    routerContextVersion: null,
    recordedAt: updatedAt,
  };
}

async function requestVersionStillCurrent(
  deps: DispatcherReadToolDeps,
  requestId: string,
  expected: { readonly version: number; readonly updatedAt: bigint },
): Promise<boolean> {
  const current = await deps.prisma.request.findUnique({
    where: { id: requestId },
    select: { version: true, updatedAt: true },
  });
  return current?.version === expected.version && current.updatedAt === expected.updatedAt;
}

function routerEvidenceSource(
  plan: AppliedPlanCurrentShape | null,
  basis: CurrentBasis,
): DispatcherExplanationSource {
  return {
    kind: 'router_evidence',
    id: plan?.routerResult?.resultId ?? null,
    planRevision: plan?.revision ?? null,
    inputHash: plan?.routerResult?.inputHash ?? basis.inputHash,
    routerContextVersion: plan?.routerResult?.routerContextVersion ?? basis.routerContextVersion,
    recordedAt:
      plan?.routerResult?.computedAt === null || plan?.routerResult?.computedAt === undefined
        ? null
        : Number(plan.routerResult.computedAt),
  };
}

function factor(
  id: string,
  label: string,
  value: unknown,
  basis: DispatcherExplanationFactor['basis'],
  source: DispatcherExplanationSource,
  subject: string,
  limitation?: string,
): DispatcherExplanationFactor {
  return dispatcherExplanationFactor({
    id,
    label,
    value,
    basis,
    source,
    subject,
    ...(limitation ? { limitation } : {}),
  });
}

function candidateView(candidate: CandidateEvidence | undefined): Record<string, unknown> | null {
  if (!candidate) return null;
  return {
    engineerId: candidate.engineer_id,
    label: candidate.label,
    checks: {
      skill: candidate.skill_match,
      transport: candidate.transport_match,
      equipment: candidate.equipment_match,
      available: candidate.available,
      soloFeasible: candidate.solo_feasible,
      appendAtRouteEndFeasible: candidate.append_at_route_end_feasible,
    },
    routeEndEstimate: {
      startAt: candidate.append_start_at,
      endAt: candidate.append_end_at,
      incrementalTravelTimeSec: candidate.append_incremental_travel_time_sec,
      incrementalDistanceKm: candidate.append_incremental_distance_km,
    },
    assignedJobCount: candidate.assigned_job_count,
    blockers: candidate.blockers,
  };
}

function subjectOf(entity: Entity): string {
  switch (entity.type) {
    case 'request':
      return `заявки №${entity.id}`;
    case 'route':
      return `маршрута инженера ${entity.engineerId}`;
    case 'leg':
      return `дорожного плеча ${entity.legId}`;
    case 'lunch':
      return `обеда инженера ${entity.engineerId}`;
    case 'plan':
      return 'применённого плана';
  }
}
