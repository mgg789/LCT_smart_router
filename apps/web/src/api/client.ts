import { z } from 'zod';
import { t } from '../i18n';
import { formatClock } from '../lib/time';
import type {
  AlertResolutionInput,
  ApiTokenCategory,
  ApiTokenSummary,
  AssignmentReasons,
  AuthSession,
  CreateDispatchEngineerInput,
  CreateDispatchRequestInput,
  CreatedApiToken,
  DashboardSnapshot,
  DataUploadFile,
  DataUploadSummary,
  DispatcherSettingsPatch,
  DispatcherSettingsView,
  EngineerDayView,
  GeocodeHit,
  ImportPreparationView,
  MapProvidersStatus,
  McpSettingsView,
  OfficialImportSummary,
  PlanAssignmentView,
  PolicyComparisonResponse,
  PolicyId,
  ReviewImportQuality,
  RoadImportSummary,
  RouterTechnicalSettings,
} from './types';
import {
  confirmWindowChange,
  WindowChangeDeclined,
  windowConfirmationFrom,
} from './windowConfirmation';

const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '');
const policyIdSchema = z.enum([
  'compact',
  'fast',
  'sla',
  'balanced',
  'eco',
  'covering',
  'personal',
]);

const roadImportSummarySchema = z.object({
  operationId: z.string().min(1),
  status: z.enum(['accepted', 'replayed']),
  graphVersion: z.string().min(1),
  routerContextVersion: z.string().min(1),
  inputSha256: z.string().length(64),
  profiles: z.array(z.enum(['car', 'walk', 'bike', 'transit'])),
  nodes: z.number().int().nonnegative(),
  edges: z.number().int().nonnegative(),
});

const requestSchema = z.object({
  id: z.string(),
  version: z.number().int(),
  lifecycle: z.enum(['draft', 'submitted', 'in_progress', 'completed', 'cancelled']),
  assignmentState: z.enum(['pending', 'unassigned', 'assigned', 'in_progress', 'done']),
  addressText: z.string(),
  region: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  lat: z.number().nullable(),
  lon: z.number().nullable(),
  needsGeocoding: z.boolean(),
  geocodeQuality: z.string().nullable(),
  requiredEquipment: z.enum(['router', 'set_top_box', 'smart_speaker']).nullable(),
  workType: z.string().nullable(),
  workTypeTitle: z.string().nullable(),
  workCategory: z.enum(['emergency', 'connection', 'service']).optional(),
  receivedAt: z.number().nullable().optional(),
  requiredSkill: z.string(),
  normProfileCode: z.string(),
  normativeTravelDurationSec: z.number().int().nonnegative(),
  technicalDurationSec: z.number().int().nonnegative(),
  documentationDurationSec: z.number().int().nonnegative(),
  serviceDurationSec: z.number().int().nonnegative(),
  actualDurationSec: z.number().int().nonnegative().nullable(),
  durationVarianceSec: z.number().int().nullable(),
  windowStartAt: z.number().int(),
  windowEndAt: z.number().int(),
  priority: z.enum(['normal', 'urgent']),
  contactName: z.string().nullable(),
  problemText: z.string().nullable(),
  createdAt: z.number().int(),
  submittedAt: z.number().int().nullable(),
  startedAt: z.number().int().nullable(),
  expectedCompletionAt: z.number().int().nullable(),
  continuationAvailableAt: z.number().int().nullable(),
  overrunDetectedAt: z.number().int().nullable(),
  assumedStartedAt: z.number().int().nullable().optional().default(null),
  assumedCompletedAt: z.number().int().nullable().optional().default(null),
  completedAt: z.number().int().nullable(),
  cancelledAt: z.number().int().nullable(),
});

const engineerDaySchema = z.object({
  attendanceOptOut: z.boolean().default(false),
  lastAttendanceAt: z.number().int().nullable().default(null),
  engineerId: z.string(),
  workDate: z.string(),
  version: z.number().int(),
  shiftStartAt: z.number().int(),
  shiftEndAt: z.number().int(),
  availability: z.enum(['online', 'offline', 'technical_break']),
  expectedOnlineAt: z.number().int().nullable(),
  equipmentStock: z.object({
    router: z.number().int().nonnegative(),
    setTopBox: z.number().int().nonnegative(),
    smartSpeaker: z.number().int().nonnegative(),
  }),
  equipmentIssuedAt: z.number().int().nullable(),
  lunch: z.object({
    enabled: z.boolean(),
    durationSec: z.number().int().nullable(),
    windowStartAt: z.number().int().nullable(),
    windowEndAt: z.number().int().nullable(),
    required: z.boolean(),
    taken: z.boolean(),
    startedAt: z.number().int().nullable(),
  }),
});

const engineerSchema = z.object({
  id: z.string(),
  version: z.number().int(),
  displayName: z.string(),
  inputOrder: z.number().int(),
  skills: z.array(z.string()),
  transportType: z.enum(['car', 'walk', 'bike', 'transit']),
  transitEligible: z.boolean().optional().default(true),
  region: z.string().nullable(),
  homeLat: z.number().nullable(),
  homeLon: z.number().nullable(),
  hasAccount: z.boolean().optional().default(false),
  email: z.string().nullable().optional().default(null),
  day: engineerDaySchema.nullable(),
});

const planStopSchema = z.object({
  sequence: z.number().int(),
  kind: z.enum(['job', 'lunch', 'wait', 'start', 'handoff', 'delivery', 'office_pickup']),
  logistics: z
    .object({
      logistics_id: z.string(),
      kind: z.enum(['donor_delivery', 'office_pickup']),
      request_id: z.string(),
      equipment_type: z.enum(['router', 'set_top_box', 'smart_speaker']),
    })
    .nullable()
    .optional(),

  handoff: z
    .object({
      handoff_id: z.string(),
      donor_engineer_id: z.string(),
      receiver_engineer_id: z.string(),
      request_id: z.string(),
      items: z.object({
        router: z.number().int().nonnegative(),
        set_top_box: z.number().int().nonnegative(),
        smart_speaker: z.number().int().nonnegative(),
      }),
    })
    .nullable()
    .optional(),
  requestId: z.string().nullable(),
  lat: z.number(),
  lon: z.number(),
  arrivalAt: z.number().int(),
  startAt: z.number().int(),
  endAt: z.number().int(),
});

const planLegSchema = z.object({
  legId: z.string(),
  fromStopId: z.string().nullable(),
  toStopId: z.string(),
  departureAt: z.number().int(),
  arrivalAt: z.number().int(),
  travelTimeSec: z.number().int().nonnegative(),
  distanceKm: z.number().nonnegative(),
  travelSource: z.enum(['approximate', 'road_matrix', 'route_api', 'traffic_api', 'metro']),
  geometryProvider: z.enum(['twogis', 'yandex']).optional(),
  trafficFactor: z.number().min(1),
  geometry: z
    .object({
      points: z
        .array(z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) }))
        .min(2),
    })
    .nullable(),
  segments: z
    .array(
      z.object({
        geometry: z.object({
          points: z
            .array(
              z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) }),
            )
            .min(2),
        }),
        travelSource: z.enum(['approximate', 'road_matrix', 'route_api', 'traffic_api', 'metro']),
        travelTimeSec: z.number().int().nonnegative(),
        distanceKm: z.number().nonnegative(),
        geometryProvider: z.enum(['twogis', 'yandex']).optional(),
      }),
    )
    .optional(),
});

const lunchStatusSchema = z.enum([
  'none',
  'disabled',
  'already_taken',
  'scheduled',
  'skipped_for_work',
  'not_scheduled',
  'required_conflict',
]);

const routeSchema = z.object({
  engineerId: z.string(),
  startLat: z.number(),
  startLon: z.number(),
  startAt: z.number().int().nullable(),
  finishAt: z.number().int().nullable(),
  distanceKm: z.number(),
  travelTimeSec: z.number().int(),
  workTimeSec: z.number().int(),
  waitingTimeSec: z.number().int(),
  lunchTimeSec: z.number().int(),
  assignedCount: z.number().int(),
  lunchStatus: lunchStatusSchema,
  stops: z.array(planStopSchema),
  legs: z
    .array(planLegSchema)
    .optional()
    .transform((value) => value ?? []),
});

const rawAssignmentSchema = z.object({
  requestId: z.string(),
  status: z.enum(['assigned', 'unassigned', 'in_progress', 'done']),
  engineerId: z.string().nullable(),
  reasons: z.unknown(),
});

const planSchema = z.object({
  revision: z.number().int(),
  origin: z.enum(['auto', 'manual', 'restore']),
  planAsOf: z.number().int(),
  appliedAt: z.number().int(),
  routes: z.array(routeSchema),
  assignments: z.array(rawAssignmentSchema),
});

/** Read persisted revisions; restore eligibility is never inferred from browser state. */
export async function loadPlanHistory(token: string) {
  const history = await requestJson(
    '/api/v1/dispatch/plan/previous',
    z.object({
      current: planSchema.nullable(),
      previous: planSchema.nullable(),
      eligibility: z.object({ eligible: z.boolean(), reason: z.string().nullable() }),
    }),
    token,
  );
  const normalize = (plan: z.infer<typeof planSchema> | null) =>
    plan
      ? {
          ...plan,
          assignments: plan.assignments.map(normalizeAssignment),
        }
      : null;
  return { ...history, current: normalize(history.current), previous: normalize(history.previous) };
}

/** Restore the server's predecessor as a new revision, with a stale-view CAS guard. */
export async function restorePreviousPlan(token: string, expectedRevision: number) {
  return requestJson(
    '/api/v1/dispatch/plan/restore',
    z.object({
      fromRevision: z.number().int(),
      restoredRevision: z.number().int(),
      origin: z.literal('restore'),
    }),
    token,
    {
      method: 'POST',
      body: JSON.stringify({ operationId: crypto.randomUUID(), expectedRevision }),
    },
  );
}

const dispatchPlanSchema = z.object({
  mode: z.enum(['auto', 'manual']),
  modeVersion: z.number().int(),
  plan: planSchema.nullable(),
  appliedResult: z
    .object({
      resultId: z.string(),
      inputHash: z.string(),
      routerContextVersion: z.string(),
    })
    .nullable(),
  lastResult: z
    .object({
      resultId: z.string(),
      inputHash: z.string(),
      routerContextVersion: z.string(),
      accepted: z.boolean(),
      rejectionCode: z.string().nullable(),
      receivedAt: z.number().int(),
    })
    .nullable(),
  /** True while the published task is newer than the plan on screen. */
  calculating: z.boolean().optional().default(false),
  routerPhase: z.enum(['building', 'ready', 'error']).optional(),
  routerMessage: z.string().nullable().optional(),
  geometryDone: z.number().int().nonnegative().optional(),
  geometryTotal: z.number().int().nonnegative().optional(),
});

const alertSchema = z.object({
  id: z.string(),
  code: z.string(),
  severity: z.enum(['info', 'warning', 'error']),
  engineerIds: z.array(z.string()),
  requestIds: z.array(z.string()),
  reasons: z.array(z.unknown()),
  restoreOption: z
    .union([
      z.string(),
      z.object({ engineer_id: z.string(), reject_request_ids: z.array(z.string()) }),
    ])
    .nullable(),
  createdAt: z.number().int(),
  seenAt: z.number().int().nullable(),
  resolvedAt: z.number().int().nullable(),
  kind: z.enum(['alert', 'notice']).default('alert'),
  actions: z.array(z.string()).default([]),
  workDate: z.string().nullable().default(null),
  resolutionAction: z.string().nullable().default(null),
  resolutionReason: z.string().nullable().default(null),
  resolutionDelaySec: z.number().int().nonnegative().nullable().default(null),
});

const shiftSchema = z.object({
  workDate: z.string(),
  closedAt: z.number().int().nullable(),
  unresolvedCount: z.number().int().nonnegative(),
});

/** Reads the revision bound to confirmation when replacing another request's priority. */
export function loadRequestPriority(token: string, workDate: string) {
  return requestJson(
    `/api/v1/dispatch/request-priority?workDate=${encodeURIComponent(workDate)}`,
    z.object({ priority: z.object({ requestId: z.string(), version: z.string() }).nullable() }),
    token,
  );
}

/** Executes one allowed decision; the caller keeps operationId stable for retries. */
export async function resolveDispatchAlert(
  token: string,
  id: string,
  input: AlertResolutionInput,
): Promise<void> {
  await requestJson(
    `/api/v1/dispatch/alerts/${encodeURIComponent(id)}/resolve`,
    z.unknown(),
    token,
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
  );
}

/** Exempts this working day from attendance checks while preserving shift bounds. */
export async function setEngineerAttendanceOptOut(
  token: string,
  day: EngineerDayView,
  attendanceOptOut: boolean,
): Promise<void> {
  await requestJson(
    `/api/v1/dispatch/engineers/${encodeURIComponent(day.engineerId)}/workday`,
    z.object({ day: engineerDaySchema }),
    token,
    {
      method: 'POST',
      body: JSON.stringify({
        operationId: crypto.randomUUID(),
        workDate: day.workDate,
        shiftStartAt: day.shiftStartAt,
        shiftEndAt: day.shiftEndAt,
        lunch: {
          enabled: day.lunch.enabled,
          durationSec: day.lunch.durationSec,
          windowStartAt: day.lunch.windowStartAt,
          windowEndAt: day.lunch.windowEndAt,
        },
        lunchRequired: day.lunch.required,
        attendanceOptOut,
      }),
    },
  );
}

/** Marks an ordinary notice as read without resolving an actionable alert. */
export async function markDispatchNoticeSeen(token: string, id: string): Promise<void> {
  await requestJson(`/api/v1/dispatch/alerts/${encodeURIComponent(id)}/seen`, z.unknown(), token, {
    method: 'POST',
  });
}

/** Requests closure after the server checks for unresolved problems. */
export async function closeDispatchShift(
  token: string,
  workDate: string,
  operationId: string,
): Promise<void> {
  await requestJson('/api/v1/dispatch/shift/close', z.unknown(), token, {
    method: 'POST',
    body: JSON.stringify({ operationId, workDate }),
  });
}

const demoStandRestoreSchema = z.object({
  restored: z.literal(true),
  workDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  requestsCreated: z.number().int().nonnegative(),
  engineersCreated: z.number().int().nonnegative(),
  generation: z.number().int().positive(),
});

/** Rewinds the public 14/2 demo day. No-op contract unless the API has DEMO_STAND. */
export function restartDemoStand(token: string): Promise<z.infer<typeof demoStandRestoreSchema>> {
  return requestJson(
    '/api/v1/dispatch/data/restart-demo',
    demoStandRestoreSchema,
    token,
    {
      method: 'POST',
      body: JSON.stringify({ operationId: crypto.randomUUID() }),
    },
    35_000,
  );
}

const policiesSchema = z.object({
  policies: z.array(
    z.object({
      policyId: policyIdSchema,
      title: z.string(),
      description: z.string(),
      isDefault: z.boolean(),
    }),
  ),
  active: z.object({
    policyId: policyIdSchema,
    version: z.number().int(),
    changedAt: z.number(),
    ordinaryReplanningDisabled: z.boolean().default(false),
  }),
});

const technicalSettingsSchema = z.object({
  lunchesEnabled: z.boolean(),
  metroEnabled: z.boolean().default(false),
  departureLatenessToleranceSec: z.number().int().nonnegative(),
  taskStartLatenessToleranceSec: z.number().int().nonnegative(),
  strictTimeWindows: z.boolean().default(true),
  windowLatenessToleranceSec: z.number().int().nonnegative().max(1_200).default(0),
  trafficEnabled: z.boolean().default(true),
  equipmentEnabled: z.boolean().default(true),
  equipmentTransfersEnabled: z.boolean().default(false),
  travelTimeMode: z.enum(['graph_with_access_buffer', 'fixed_normative']),
  accessBufferSec: z.number().int().nonnegative(),
  fixedTravelTimeSec: z.number().int().positive(),
  earlyFinishReplanThresholdSec: z.number().int().nonnegative(),
  taskOverrunToleranceSec: z.number().int().nonnegative(),
  routerContextVersion: z.string().min(1),
});

const technicalSettingsUpdateSchema = technicalSettingsSchema.extend({
  operationId: z.string().uuid(),
  status: z.literal('accepted'),
});

const policySelectionSchema = z.object({
  policyId: policyIdSchema,
  publication: z.object({
    published: z.boolean(),
    inputHash: z.string().min(1),
    planningAsOf: z.number().int(),
    snapshotId: z.string().nullable(),
  }),
});

const authSessionSchema = z.object({
  token: z.string().min(1),
  role: z.literal('dispatcher'),
  expiresAt: z.number().int(),
});

const policyComparisonSchema = z.object({
  inputPublicationId: z.string().min(1),
  inputHash: z.string().min(1),
  routerContextVersion: z.string().min(1),
  computedAt: z.number().int(),
  searchBudgetMs: z.number().int().positive().max(8_000),
  rows: z
    .array(
      z.object({
        strategyId: z.enum(['fast', 'compact', 'sla', 'balanced', 'eco', 'covering', 'baseline']),
        kind: z.enum(['policy', 'baseline']),
        additionalEngineers: z.number().int().nonnegative().default(0),
        isUsable: z.boolean(),
        calculationMs: z.number().nonnegative(),
        metrics: z.object({
          requestsTotal: z.number().int().nonnegative(),
          assignedCount: z.number().int().nonnegative(),
          unassignedCount: z.number().int().nonnegative(),
          urgentTotal: z.number().int().nonnegative(),
          urgentAssignedCount: z.number().int().nonnegative(),
          engineersUsed: z.number().int().nonnegative(),
          distanceKm: z.number().nonnegative(),
          travelTimeSec: z.number().int().nonnegative(),
          workTimeSec: z.number().int().nonnegative(),
          waitingTimeSec: z.number().int().nonnegative(),
          lunchTimeSec: z.number().int().nonnegative(),
          lateAssignedCount: z.number().int().nonnegative(),
          totalLatenessSec: z.number().int().nonnegative(),
          minWindowSlackSec: z.number().int().nullable(),
          workloadSpreadSec: z.number().int().nonnegative(),
          maxWorkloadSec: z.number().int().nonnegative(),
        }),
      }),
    )
    .min(6)
    .max(7)
    .superRefine((rows, context) => {
      const strategyIds = new Set(rows.map((row) => row.strategyId));
      if (strategyIds.size !== rows.length) {
        context.addIssue({ code: 'custom', message: t('api.client.01ad9de2da') });
      }
      if (
        !['fast', 'compact', 'sla', 'balanced', 'eco', 'baseline'].every((id) =>
          rows.some((row) => row.strategyId === id),
        )
      ) {
        context.addIssue({ code: 'custom', message: t('api.client.41da24a8b7') });
      }
      if (rows.some((row) => (row.strategyId === 'baseline') !== (row.kind === 'baseline'))) {
        context.addIssue({ code: 'custom', message: t('api.client.0e88f7b84e') });
      }
    }),
});

const availabilityUpdateSchema = z.object({
  publication: z
    .object({
      inputHash: z.string().min(1),
    })
    .nullable(),
});

const dataUploadSummarySchema = z.object({
  applied: z.boolean(),
  region: z.string(),
  mode: z.enum(['new_region', 'append_requests']),
  requestsCreated: z.number().int().nonnegative(),
  engineersCreated: z.number().int().nonnegative(),
  depotsCreated: z.number().int().nonnegative(),
  warnings: z.array(z.string()),
  publicationId: z.string().nullable(),
  inputHash: z.string().nullable(),
});

const reasonSchema = z.object({
  code: z.string(),
  text: z.string(),
  basis: z.string().optional(),
  facts: z.record(z.string(), z.unknown()).optional(),
});

/** Error returned by the live Dashboard API client. */
export class DashboardApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly path = '',
    readonly requestId: string | null = null,
  ) {
    super(message);
    this.name = 'DashboardApiError';
  }
}

const normalizedAssignmentSchema = rawAssignmentSchema.extend({
  reasons: z.object({
    assignment: z
      .object({
        chosen: z.string().nullable(),
        factors: z.array(
          z.object({
            code: z.string(),
            detail: z.string(),
            ok: z.boolean().optional(),
            value: z.number().optional(),
            basis: z.string().optional(),
            facts: z.record(z.string(), z.unknown()).optional(),
          }),
        ),
        alternatives: z.array(
          z.object({
            engineerId: z.string(),
            blocked: z.boolean(),
            whyNot: z.string(),
            costDeltaMin: z.number().optional(),
          }),
        ),
      })
      .optional(),
    sequence: z
      .array(z.object({ swapWith: z.string(), costDeltaMin: z.number(), why: z.string() }))
      .optional(),
  }),
});

const snapshotSchema = z.object({
  workDate: z.string(),
  timeZone: z.literal('Europe/Moscow'),
  nowAt: z.number().int(),
  policyId: policyIdSchema,
  lunchesEnabled: z.boolean(),
  routerSettings: technicalSettingsSchema.optional(),
  routerContextVersion: z.string(),
  policies: policiesSchema.shape.policies,
  engineers: z.array(engineerSchema),
  requests: z.array(requestSchema),
  plan: dispatchPlanSchema.extend({
    plan: planSchema.extend({ assignments: z.array(normalizedAssignmentSchema) }).nullable(),
  }),
  alerts: z.array(alertSchema.extend({ reasons: z.array(z.string()) })),
});

/** Validate persisted/demo data against the same views as HTTP; rejects broken references. */
export function parseDashboardSnapshot(value: unknown): DashboardSnapshot {
  const snapshot = snapshotSchema.parse(value);
  const engineers = new Set(snapshot.engineers.map((item) => item.id));
  const requests = new Set(snapshot.requests.map((item) => item.id));
  if (
    engineers.size !== snapshot.engineers.length ||
    requests.size !== snapshot.requests.length ||
    snapshot.plan.plan?.assignments.some(
      (item) =>
        !requests.has(item.requestId) ||
        (item.engineerId !== null && !engineers.has(item.engineerId)),
    ) ||
    snapshot.plan.plan?.routes.some(
      (route) =>
        !engineers.has(route.engineerId) ||
        route.stops.some((stop) => stop.requestId !== null && !requests.has(stop.requestId)),
    )
  ) {
    throw new DashboardApiError(t('api.client.fcd54ecfd2'), 0, 'snapshot');
  }
  return snapshot;
}

/** Validate recorded policy comparison data without issuing an HTTP request. */
export function parsePolicyComparison(value: unknown): PolicyComparisonResponse {
  return policyComparisonSchema.parse(value);
}

const dispatcherLoginCodeSchema = z.object({
  email: z.email(),
  expiresAt: z.number().int(),
  devCode: z.string().optional(),
});

/** Authenticates a dispatcher without exposing configured credentials to the bundle. */
export async function loginDispatcher(email: string, password: string): Promise<AuthSession> {
  return requestJson('/api/v1/auth/dispatcher/password', authSessionSchema, undefined, {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

/** Asks the public login-code contour to mail a one-time dispatcher code. */
export function requestDispatcherLoginCode(
  email: string,
): Promise<z.infer<typeof dispatcherLoginCodeSchema>> {
  return requestJson('/api/v1/auth/login-code', dispatcherLoginCodeSchema, undefined, {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}

/**
 * Exchanges a mailed code for the dispatcher session. The role must already
 * belong to the configured dispatcher account; verifying does not grant it.
 */
export function verifyDispatcherLoginCode(email: string, code: string): Promise<AuthSession> {
  return requestJson('/api/v1/auth/login-code/verify', authSessionSchema, undefined, {
    method: 'POST',
    body: JSON.stringify({ email, code, role: 'dispatcher' }),
  });
}

/** Invalidates the current server session. */
export async function signOutDispatcher(token: string): Promise<void> {
  await requestJson('/api/v1/auth/session', z.object({ signedOut: z.boolean() }), token, {
    method: 'DELETE',
  });
}

const apiTokenCategorySchema = z.enum(['client', 'eng', 'client_eng', 'master']);

const apiTokenSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  category: apiTokenCategorySchema,
  createdAt: z.number().int(),
  expiresAt: z.number().int().nullable(),
  revokedAt: z.number().int().nullable(),
});

const createdApiTokenSchema = apiTokenSummarySchema.omit({ revokedAt: true }).extend({
  token: z.string().min(1),
});

/** Lists the integration keys without ever re-revealing their secrets. */
export async function listApiTokens(sessionToken: string): Promise<ApiTokenSummary[]> {
  const listed = await requestJson(
    '/api/v1/auth/tokens',
    z.object({ tokens: z.array(apiTokenSummarySchema) }),
    sessionToken,
  );
  return listed.tokens;
}

/** Creates an integration key; the returned secret is shown once and never again. */
export function createApiToken(
  sessionToken: string,
  input: { name: string; category: ApiTokenCategory; expiresAt: number | null },
): Promise<CreatedApiToken> {
  return requestJson('/api/v1/auth/tokens', createdApiTokenSchema, sessionToken, {
    method: 'POST',
    body: JSON.stringify({
      name: input.name,
      category: input.category,
      ...(input.expiresAt === null ? {} : { expiresAt: input.expiresAt }),
    }),
  });
}

/** Revokes an integration key; created requests and applied changes stay. */
export async function revokeApiToken(sessionToken: string, id: string): Promise<void> {
  await requestJson(
    `/api/v1/auth/tokens/${encodeURIComponent(id)}`,
    z.object({ revoked: z.boolean() }),
    sessionToken,
    { method: 'DELETE' },
  );
}

const mcpSettingsViewSchema = z.object({
  enabled: z.boolean(),
  pinSet: z.boolean(),
  pinLast4: z.string().nullable(),
  activeNow: z.boolean(),
  lastToolName: z.string().nullable(),
  lastToolCallAt: z.number().int().nullable(),
  endpoint: z.string(),
});

/** Reads the dashboard MCP server state: switch, pin presence and live agent activity. */
export function getMcpSettings(token: string): Promise<McpSettingsView> {
  return requestJson('/api/v1/dispatch/mcp', mcpSettingsViewSchema, token);
}

/**
 * Switches the MCP server and sets or rotates its pin. The pin travels to the server
 * exactly once; the response mirrors the same view as [[getMcpSettings]].
 */
export function saveMcpSettings(
  token: string,
  input: { enabled: boolean; pin?: string },
): Promise<McpSettingsView> {
  return requestJson('/api/v1/dispatch/mcp', mcpSettingsViewSchema, token, {
    method: 'PUT',
    body: JSON.stringify({ operationId: crypto.randomUUID(), ...input }),
  });
}

const engineerProfileSchema = engineerSchema.omit({ day: true });

const dispatcherSettingsSchema = z.object({
  dayStartMin: z.number().int(),
  dayEndMin: z.number().int(),
  noShowSec: z.number().int(),
  overdueSec: z.number().int(),
  timeRiskSec: z.number().int(),
  repeatAfterSec: z.number().int(),
  twogisApiKeySet: z.boolean(),
  twogisApiKeyLast4: z.string().nullable(),
  yandexApiKeySet: z.boolean(),
  yandexApiKeyLast4: z.string().nullable(),
  equipmentCapacityWalk: z.number().int().nonnegative().default(5),
  equipmentCapacityBike: z.number().int().nonnegative().default(12),
  equipmentCapacityCar: z.number().int().nonnegative().default(30),
});

const geocodeHitSchema = z.object({
  displayName: z.string(),
  lat: z.number(),
  lon: z.number(),
});

const mapProviderStatusSchema = z.object({
  provider: z.enum(['twogis', 'yandex']),
  configured: z.boolean(),
  ok: z.boolean().nullable(),
  message: z.string(),
});

/** Reads dispatcher-owned day clocks, alert timers and map-key presence. */
export function getDispatcherSettings(token: string): Promise<DispatcherSettingsView> {
  return requestJson('/api/v1/dispatch/settings', dispatcherSettingsSchema, token);
}

/** Replaces dispatcher-owned operational settings. Empty map keys are omitted, not cleared. */
export function updateDispatcherSettings(
  token: string,
  patch: DispatcherSettingsPatch,
): Promise<DispatcherSettingsView> {
  return requestJson('/api/v1/dispatch/settings', dispatcherSettingsSchema, token, {
    method: 'PUT',
    body: JSON.stringify({ operationId: crypto.randomUUID(), ...patch }),
  });
}

/** Probes configured 2GIS / Yandex keys with a short Moscow sample route. */
export function getMapProvidersStatus(token: string): Promise<MapProvidersStatus> {
  return requestJson(
    '/api/v1/dispatch/settings/maps/status',
    z.object({
      active: z.enum(['twogis', 'yandex', 'none']),
      twogis: mapProviderStatusSchema,
      yandex: mapProviderStatusSchema,
    }),
    token,
  );
}

/** LocationIQ autocomplete. Pass a free-form address or city+street. */
export async function geocodeAddress(
  token: string,
  query: { q?: string; city?: string; street?: string },
): Promise<GeocodeHit[]> {
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  if (query.city) params.set('city', query.city);
  if (query.street) params.set('street', query.street);
  const result = await requestJson(
    `/api/v1/dispatch/geocode?${params.toString()}`,
    z.object({ hits: z.array(geocodeHitSchema) }),
    token,
  );
  return result.hits;
}

/** Cancels a visit that has not started. */
export function cancelDispatchRequest(
  token: string,
  requestId: string,
  expectedVersion?: number,
  reason?: string,
): Promise<{ request: z.infer<typeof requestSchema> }> {
  return requestJson(
    `/api/v1/dispatch/requests/${encodeURIComponent(requestId)}/cancel`,
    z.object({ request: requestSchema }),
    token,
    {
      method: 'POST',
      body: JSON.stringify({
        operationId: crypto.randomUUID(),
        ...(expectedVersion === undefined ? {} : { expectedVersion }),
        ...(reason === undefined ? {} : { reason }),
      }),
    },
  );
}

/** Moves an unstarted visit onto another engineer. Requires manual control. */
export function reassignDispatchRequest(
  token: string,
  requestId: string,
  engineerId: string,
): Promise<unknown> {
  return requestJson('/api/v1/dispatch/plan/reassign', z.unknown(), token, {
    method: 'POST',
    body: JSON.stringify({ operationId: crypto.randomUUID(), requestId, engineerId }),
  });
}

/** Creates and immediately submits an unplanned request from the compact dashboard form. */
export function createDispatchRequest(
  token: string,
  input: CreateDispatchRequestInput,
): Promise<{ request: z.infer<typeof requestSchema> }> {
  return requestJson('/api/v1/dispatch/requests', z.object({ request: requestSchema }), token, {
    method: 'POST',
    body: JSON.stringify({ operationId: crypto.randomUUID(), ...input }),
  });
}

/** Adds a routing profile, with Engineer App access only when an email was supplied. */
export function createDispatchEngineer(
  token: string,
  input: CreateDispatchEngineerInput,
): Promise<{ engineer: z.infer<typeof engineerProfileSchema> }> {
  return requestJson(
    '/api/v1/dispatch/engineers',
    z.object({ engineer: engineerProfileSchema }),
    token,
    {
      method: 'POST',
      body: JSON.stringify({ operationId: crypto.randomUUID(), ...input }),
    },
  );
}

/** Updates roster transport or region with optimistic version checking. */
export function updateDispatchEngineerProfile(
  token: string,
  engineerId: string,
  expectedVersion: number,
  patch: { region?: string; transportType?: 'car' | 'walk' | 'bike' | 'transit' },
): Promise<unknown> {
  return requestJson(
    `/api/v1/dispatch/engineers/${encodeURIComponent(engineerId)}`,
    z.object({ engineer: engineerProfileSchema }),
    token,
    {
      method: 'PATCH',
      body: JSON.stringify({ operationId: crypto.randomUUID(), expectedVersion, ...patch }),
    },
  );
}

/** Archives a routing profile while preserving its historical plans and facts. */
export function deleteDispatchEngineer(
  token: string,
  engineerId: string,
  expectedVersion?: number,
): Promise<{ engineer: z.infer<typeof engineerProfileSchema> }> {
  return requestJson(
    `/api/v1/dispatch/engineers/${encodeURIComponent(engineerId)}`,
    z.object({ engineer: engineerProfileSchema }),
    token,
    {
      method: 'DELETE',
      body: JSON.stringify({
        operationId: crypto.randomUUID(),
        ...(expectedVersion === undefined ? {} : { expectedVersion }),
      }),
    },
  );
}

/** Removes the login from a brigade. The routing profile stays; live sessions die. */
export function unlinkEngineerAccount(
  token: string,
  engineerId: string,
): Promise<{ engineer: z.infer<typeof engineerProfileSchema> }> {
  return requestJson(
    '/api/v1/dispatch/engineers/unlink-account',
    z.object({ engineer: engineerProfileSchema }),
    token,
    {
      method: 'POST',
      body: JSON.stringify({ operationId: crypto.randomUUID(), engineerId }),
    },
  );
}

/** Grants a login address to an imported brigade that still has none. */
export function linkEngineerAccount(
  token: string,
  engineerId: string,
  email: string,
): Promise<{ engineer: z.infer<typeof engineerProfileSchema> }> {
  return requestJson(
    '/api/v1/dispatch/engineers/link-account',
    z.object({ engineer: engineerProfileSchema }),
    token,
    {
      method: 'POST',
      body: JSON.stringify({ operationId: crypto.randomUUID(), engineerId, email }),
    },
  );
}

/** Replaces an existing Engineer App login and revokes sessions of the old address. */
export function changeEngineerEmail(
  token: string,
  engineerId: string,
  email: string,
  expectedVersion?: number,
): Promise<{ engineer: z.infer<typeof engineerProfileSchema> }> {
  return requestJson(
    `/api/v1/dispatch/engineers/${encodeURIComponent(engineerId)}/email`,
    z.object({ engineer: engineerProfileSchema }),
    token,
    {
      method: 'PUT',
      body: JSON.stringify({
        operationId: crypto.randomUUID(),
        email,
        ...(expectedVersion === undefined ? {} : { expectedVersion }),
      }),
    },
  );
}

/**
 * Loads the dispatcher day.
 *
 * The six reads go in two waves of three. A browser allows about six connections
 * to one host; filling all of them left icons and clicks waiting.
 */
export async function loadDashboardSnapshot(token: string): Promise<DashboardSnapshot> {
  const [requests, engineers, planResponse] = await Promise.all([
    requestJson('/api/v1/dispatch/requests', z.object({ requests: z.array(requestSchema) }), token),
    requestJson(
      '/api/v1/dispatch/engineers',
      z.object({ engineers: z.array(engineerSchema) }),
      token,
    ),
    requestJson('/api/v1/dispatch/plan', dispatchPlanSchema, token),
  ]);
  const [alerts, policies, settings] = await Promise.all([
    requestJson('/api/v1/dispatch/alerts', z.object({ alerts: z.array(alertSchema) }), token),
    requestJson('/api/v1/dispatch/policies', policiesSchema, token),
    getRouterTechnicalSettings(token),
  ]);

  const plan = planResponse.plan
    ? {
        ...planResponse.plan,
        assignments: planResponse.plan.assignments.map(normalizeAssignment),
      }
    : null;
  const workDate =
    engineers.engineers.find((engineer) => engineer.day)?.day?.workDate ?? moscowDate(new Date());
  const shift = await requestJson(
    `/api/v1/dispatch/shift?workDate=${encodeURIComponent(workDate)}`,
    shiftSchema,
    token,
  );

  return {
    workDate,
    shift,
    timeZone: 'Europe/Moscow',
    nowAt: Math.floor(Date.now() / 1000),
    policyId: policies.active.policyId,
    ordinaryReplanningDisabled: policies.active.ordinaryReplanningDisabled,
    lunchesEnabled: settings.lunchesEnabled,
    routerSettings: settings,
    routerContextVersion: settings.routerContextVersion,
    policies: policies.policies,
    engineers: engineers.engineers,
    requests: requests.requests,
    plan: { ...planResponse, plan },
    alerts: alerts.alerts.map((alert) => ({
      ...alert,
      reasons: alert.reasons.map(formatUnknownReason),
    })),
  };
}

/** Selects one prepared routing policy. */
export async function selectRoutingPolicy(token: string, policyId: PolicyId): Promise<string> {
  const selected = await requestJson('/api/v1/dispatch/policy', policySelectionSchema, token, {
    method: 'POST',
    body: JSON.stringify({ operationId: crypto.randomUUID(), policyId }),
  });
  return selected.publication.inputHash;
}

/** Reads Router-owned technical settings through the backend boundary. */
export function getRouterTechnicalSettings(token: string): Promise<RouterTechnicalSettings> {
  return requestJson('/api/v1/dispatch/router/technical-settings', technicalSettingsSchema, token);
}

/** Replaces the complete Router-owned settings revision through the backend CAS boundary. */
export async function updateRouterTechnicalSettings(
  token: string,
  settings: RouterTechnicalSettings,
): Promise<RouterTechnicalSettings> {
  const updated = await requestJson(
    '/api/v1/dispatch/router/technical-settings',
    technicalSettingsUpdateSchema,
    token,
    {
      method: 'PUT',
      body: JSON.stringify({
        operationId: crypto.randomUUID(),
        expectedContextVersion: settings.routerContextVersion,
        strictTimeWindows: settings.strictTimeWindows ?? true,
        lunchesEnabled: settings.lunchesEnabled,
        metroEnabled: settings.metroEnabled,
        departureLatenessToleranceSec: settings.departureLatenessToleranceSec,
        taskStartLatenessToleranceSec: settings.taskStartLatenessToleranceSec,
        windowLatenessToleranceSec: settings.windowLatenessToleranceSec,
        trafficEnabled: settings.trafficEnabled,
        equipmentEnabled: settings.equipmentEnabled,
        equipmentTransfersEnabled: settings.equipmentTransfersEnabled,
        travelTimeMode: settings.travelTimeMode,
        accessBufferSec: settings.accessBufferSec,
        fixedTravelTimeSec: settings.fixedTravelTimeSec,
        earlyFinishReplanThresholdSec: settings.earlyFinishReplanThresholdSec,
        taskOverrunToleranceSec: settings.taskOverrunToleranceSec,
      }),
    },
  );
  return updated;
}

/** Replaces only the lunch choice while preserving every other Router-owned setting. */
export async function setLunchesEnabled(token: string, enabled: boolean): Promise<string> {
  const current = await getRouterTechnicalSettings(token);
  const updated = await updateRouterTechnicalSettings(token, {
    ...current,
    lunchesEnabled: enabled,
  });
  return updated.routerContextVersion;
}

/** Switches the dispatch control mode through an idempotent backend operation. */
export async function setDispatchMode(
  token: string,
  mode: 'auto' | 'manual',
  reason?: string,
): Promise<void> {
  await requestJson('/api/v1/dispatch/mode', z.unknown(), token, {
    method: 'POST',
    body: JSON.stringify({ operationId: crypto.randomUUID(), mode, reason }),
  });
}

const simulationPointSchema = z.object({ lat: z.number(), lon: z.number() });
const simulationRouteSchema = z.object({
  engineerId: z.string(),
  segments: z.array(
    z.object({
      travelSource: z.string(),
      points: z.array(simulationPointSchema),
    }),
  ),
});
const simulationDeltaSchema = z.object({
  assigned: z.number(),
  unassigned: z.number(),
  lateAssigned: z.number(),
  totalLatenessSec: z.number(),
  distanceKm: z.number(),
  transfers: z.number(),
  beforeLate: z.number(),
  afterLate: z.number(),
  beforeUnassigned: z.number(),
  afterUnassigned: z.number(),
});
export const simulationResponseSchema = z.object({
  method: z.enum(['insertion', 'bounded', 'catalog']),
  cached: z.boolean(),
  patchHash: z.string(),
  inputHash: z.string(),
  routerContextVersion: z.string(),
  text: z.string(),
  delta: simulationDeltaSchema.nullable(),
  routes: z.array(simulationRouteSchema),
  strategies: z.array(
    z.object({
      strategyId: z.string(),
      metrics: z.object({
        assignedCount: z.number(),
        unassignedCount: z.number(),
        lateAssignedCount: z.number(),
        distanceKm: z.number(),
      }),
      routes: z.array(simulationRouteSchema),
    }),
  ),
});
export type SimulationResponse = z.infer<typeof simulationResponseSchema>;

export interface SimulationPatch {
  readonly catalog?: boolean;
  readonly policyId?: 'fast' | 'compact' | 'sla' | 'balanced' | 'eco' | 'covering';
  readonly lunchesEnabled?: boolean;
  readonly metroEnabled?: boolean;
  readonly trafficEnabled?: boolean;
  readonly equipmentEnabled?: boolean;
  readonly equipmentTransfersEnabled?: boolean;
  readonly window?: {
    readonly requestId: string;
    readonly windowStartAt: number;
    readonly windowEndAt: number;
  };
  readonly pin?: { readonly requestId: string; readonly engineerId: string };
  readonly unassignRequestId?: string;
}

/** Read-only what-if. The working plan is not replaced. */
export function simulateChange(token: string, patch: SimulationPatch): Promise<SimulationResponse> {
  return requestJson(
    '/api/v1/dispatch/simulate',
    simulationResponseSchema,
    token,
    { method: 'POST', body: JSON.stringify(patch) },
    90_000,
  );
}

/**
 * Same what-if call the manual editor will use later.
 * This pass does not rebuild the manual editor; callers still have to confirm a worse delta.
 */
export function previewManualChange(
  token: string,
  patch: SimulationPatch,
): Promise<SimulationResponse> {
  return simulateChange(token, patch);
}

/** Lateness or unassigned count grew. A shorter route by itself is not a warning. */
export function simulationWorsens(delta: SimulationResponse['delta']): boolean {
  return delta !== null && (delta.lateAssigned > 0 || delta.unassigned > 0);
}

/** Loads all Router strategies and the official FIFO baseline for one immutable input. */
export function loadPolicyComparison(token: string): Promise<PolicyComparisonResponse> {
  // Allow the API's bounded cold comparison to finish before the UI gives up.
  return requestJson(
    '/api/v1/dispatch/policy-comparison',
    policyComparisonSchema,
    token,
    {},
    90_000,
  );
}

/** Changes an engineer's line availability and returns the publication that must be applied. */
export async function setEngineerAvailability(
  token: string,
  engineerId: string,
  availability: 'online' | 'offline',
): Promise<string> {
  const updated = await requestJson(
    `/api/v1/dispatch/engineers/${encodeURIComponent(engineerId)}/availability`,
    availabilityUpdateSchema,
    token,
    {
      method: 'POST',
      body: JSON.stringify({
        operationId: crypto.randomUUID(),
        availability,
        expectedOnlineAt: null,
      }),
    },
  );
  if (!updated.publication) {
    throw new Error(t('api.client.94d9cb4a8d'));
  }
  return updated.publication.inputHash;
}

/** Uploads one locally validated data package as an idempotent backend operation. */
export async function uploadDataPackage(
  token: string,
  file: DataUploadFile,
  review?: ReviewImportQuality,
): Promise<DataUploadSummary> {
  const path = '/api/v1/dispatch/data/upload/prepare';
  const report = await requestJson(path, importPreparationSchema, token, {
    method: 'POST',
    body: JSON.stringify({ ...file, operationId: crypto.randomUUID() }),
  });
  await acknowledgeImport(token, path, report, review);
  return requestJson(`${path}/${report.prepareId}/confirm`, dataUploadSummarySchema, token, {
    method: 'POST',
    body: JSON.stringify({ operationId: crypto.randomUUID() }),
  });
}

const importPreparationSchema = z.object({
  prepareId: z.string(),
  source: z.string(),
  immutableBatchHash: z.string(),
  expiresAt: z.number(),
  versions: z.object({
    rules: z.string(),
    statistics: z.string(),
    student: z.string(),
    transform: z.string().optional(),
  }),
  findings: z.array(
    z.object({
      code: z.string(),
      layer: z.enum(['rules', 'statistics', 'student']),
      count: z.number().int().nonnegative(),
      examples: z.array(z.string()),
      message: z.string(),
      score: z.number().optional(),
    }),
  ),
});

/** Distinguishes an explicit pre-write cancellation from an uncertain commit failure. */
export class ImportCancelledError extends Error {
  constructor() {
    super(t('api.client.71fd0f5097'));
  }
}

async function acknowledgeImport(
  token: string,
  path: string,
  report: ImportPreparationView,
  review?: ReviewImportQuality,
): Promise<void> {
  if (report.findings.length === 0) return;
  if (review && (await review(report))) return;
  await requestJson(
    `${path}/${report.prepareId}/cancel`,
    z.object({ cancelled: z.boolean() }),
    token,
    {
      method: 'POST',
      body: JSON.stringify({ operationId: crypto.randomUUID() }),
    },
  );
  throw new ImportCancelledError();
}

/** Imports one native OSRM JSON or gzip payload without adding user-defined envelope fields. */
export function importRoadData(token: string, payloadBase64: string): Promise<RoadImportSummary> {
  return requestJson('/api/v1/dispatch/data/road-import', roadImportSummarySchema, token, {
    method: 'POST',
    body: JSON.stringify({
      operationId: crypto.randomUUID(),
      profile: 'car',
      payloadBase64,
    }),
  });
}

const officialImportSummarySchema = z
  .object({
    source: z.string().default('official-dataset'),
    applied: z.boolean(),
    requestsCreated: z.number().int().nonnegative(),
    requestsSkippedAsDuplicate: z.number().int().nonnegative(),
    engineersCreated: z.number().int().nonnegative(),
    depotsCreated: z.number().int().nonnegative(),
    requestsWithoutCoordinates: z.number().int().nonnegative(),
    warnings: z.array(z.string()),
    errors: z.array(z.string()),
  })
  .passthrough();

/**
 * Loads the official TZ dataset shipped in the repo (`regions: all`) without curl.
 */
export async function importOfficialDataset(
  token: string,
  review?: ReviewImportQuality,
): Promise<OfficialImportSummary> {
  const path = '/api/v1/dispatch/data/import/prepare';
  const report = await requestJson(path, importPreparationSchema, token, {
    method: 'POST',
    body: JSON.stringify({ operationId: crypto.randomUUID(), regions: 'all' }),
  });
  await acknowledgeImport(token, path, report, review);
  return requestJson(`${path}/${report.prepareId}/confirm`, officialImportSummarySchema, token, {
    method: 'POST',
    body: JSON.stringify({ operationId: crypto.randomUUID() }),
  });
}

function normalizeAssignment(raw: z.infer<typeof rawAssignmentSchema>): PlanAssignmentView {
  return {
    requestId: raw.requestId,
    status: raw.status,
    engineerId: raw.engineerId,
    reasons: normalizeReasons(raw.reasons, raw.engineerId),
  };
}

function normalizeReasons(raw: unknown, engineerId: string | null): AssignmentReasons {
  const structured = z
    .object({
      assignment: z
        .object({
          chosen: z.string().nullable().optional(),
          factors: z.array(reasonSchema).default([]),
          alternatives: z
            .array(
              z.object({
                engineerId: z.string().optional(),
                engineer: z.string().optional(),
                blocked: z.boolean().optional(),
                costDeltaMin: z.number().optional(),
                cost_delta: z.number().optional(),
                whyNot: z.string().optional(),
                why_not: z.string().optional(),
              }),
            )
            .optional(),
        })
        .optional(),
    })
    .safeParse(raw);
  if (structured.success && structured.data.assignment) {
    const assignment = structured.data.assignment;
    return {
      assignment: {
        chosen: assignment.chosen ?? engineerId,
        factors: assignment.factors.map((reason) => ({
          code: reason.code,
          detail: reason.text,
          basis: reason.basis,
          facts: reason.facts,
        })),
        alternatives: (assignment.alternatives ?? []).flatMap((item) => {
          const id = item.engineerId ?? item.engineer;
          if (!id) {
            return [];
          }
          return [
            {
              engineerId: id,
              blocked: item.blocked ?? false,
              costDeltaMin: item.costDeltaMin ?? item.cost_delta,
              whyNot: item.whyNot ?? item.why_not ?? '',
            },
          ];
        }),
      },
    };
  }
  const parsed = z.array(reasonSchema).safeParse(raw);
  if (!parsed.success) {
    return { assignment: { chosen: engineerId, factors: [], alternatives: [] } };
  }
  return {
    assignment: {
      chosen: engineerId,
      factors: parsed.data.map((reason) => ({
        code: reason.code,
        detail: reason.text,
        basis: reason.basis,
        facts: reason.facts,
      })),
      alternatives: [],
    },
  };
}

function formatUnknownReason(reason: unknown): string {
  if (typeof reason === 'string') {
    return reason;
  }
  const parsed = z.object({ text: z.string() }).safeParse(reason);
  if (parsed.success) return parsed.data.text;
  const facts = z
    .object({
      expectedAt: z.number().optional(),
      shiftStartAt: z.number().optional(),
      thresholdAt: z.number().optional(),
      lastAttendanceAt: z.number().nullable().optional(),
      plannedStartAt: z.number().optional(),
      windowEndAt: z.number().optional(),
      assignment: z.string().optional(),
      ordinaryReplanningDisabled: z.boolean().optional(),
      lunchStatus: z.string().optional(),
      assignedBefore: z.number().optional(),
      assignedAfter: z.number().optional(),
      lostSubmittedRequestIds: z.array(z.string()).optional(),
      baselineAssignedRequestIds: z.array(z.string()).optional(),
    })
    .safeParse(reason);
  if (facts.success) {
    const value = facts.data;
    if (value.lostSubmittedRequestIds && value.baselineAssignedRequestIds)
      return t('api.client.601f883bca', {
        value0: value.lostSubmittedRequestIds.length,
        value1: value.baselineAssignedRequestIds.length,
      });
    if (value.shiftStartAt !== undefined && value.thresholdAt !== undefined)
      return t('api.client.2b5f70e2d9', {
        value0: formatClock(value.shiftStartAt),
        value1: formatClock(value.thresholdAt),
      });
    if (value.plannedStartAt !== undefined && value.windowEndAt !== undefined) {
      return t('api.client.c605cb42f0', {
        value0: formatClock(value.plannedStartAt),
        value1: formatClock(value.windowEndAt),
        value2: Math.ceil((value.plannedStartAt - value.windowEndAt) / 60),
      });
    }
    if (value.expectedAt !== undefined)
      return t('api.client.ad90dd7a0e', {
        value0: formatClock(value.expectedAt),
        value1: value.lastAttendanceAt
          ? t('api.client.b3a79cd20b', { value0: formatClock(value.lastAttendanceAt) })
          : t('api.client.bb65c1e96e'),
      });
    if (value.ordinaryReplanningDisabled) return t('api.client.e8a273fcd9');
    if (value.assignment === 'unassigned') return t('api.client.ae96b9cfba');
    if (value.lunchStatus) return t('api.client.890dabf416');
    if (value.assignedBefore !== undefined && value.assignedAfter !== undefined)
      return t('api.client.60c40a2374', {
        value0: value.assignedBefore,
        value1: value.assignedAfter,
      });
  }
  return t('api.client.ce4471e17d');
}

/** Read-only same-day insertion preview; none is distinct from unavailable Router. */
export function loadAlertWindowProposal(token: string, alertId: string) {
  return requestJson(
    `/api/v1/dispatch/alerts/${encodeURIComponent(alertId)}/window-proposal`,
    z.discriminatedUnion('status', [
      z.object({ status: z.literal('none'), proposal: z.null(), requestVersion: z.number().int() }),
      z.object({
        status: z.literal('available'),
        requestVersion: z.number().int(),
        proposal: z.object({
          engineerId: z.string(),
          windowStartAt: z.number(),
          windowEndAt: z.number(),
          serviceStartAt: z.number(),
          serviceEndAt: z.number(),
        }),
      }),
    ]),
    token,
    {},
    35_000,
  );
}

/** Runs async work with a fixed number of slots so the rest of the origin stays free. */
export async function allWithLimit<T>(
  limit: number,
  tasks: ReadonlyArray<() => Promise<T>>,
): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < tasks.length) {
      const index = cursor;
      cursor += 1;
      const task = tasks[index];
      if (!task) break;
      results[index] = await task();
    }
  };
  const slots = Math.max(1, Math.min(limit, tasks.length));
  await Promise.all(Array.from({ length: slots }, () => worker()));
  return results;
}

const situationPredictionSchema = z.object({
  plan: z.object({
    robustness: z.number().min(0).max(1),
    visits_total: z.number().int().nonnegative(),
    expected_late: z.number().nonnegative(),
    expected_late_share: z.number().min(0).max(1),
    p95_late_count: z.number().nonnegative(),
    p95_max_late_sec: z.number().nonnegative(),
  }),
  requests: z.record(
    z.string(),
    z.object({
      breach_prob: z.number().min(0).max(1).nullable(),
      expected_late_sec: z.number().nonnegative(),
      p90_late_sec: z.number().nonnegative(),
      cancel_rate_sim: z.number().min(0).max(1),
    }),
  ),
  engineers: z.record(z.string(), z.object({ overrun_prob: z.number().min(0).max(1) })),
});

export interface SituationPredictionView {
  readonly robustness: number;
  readonly visitsTotal: number;
  readonly expectedLate: number;
  readonly expectedLateShare: number;
  readonly p95LateCount: number;
  readonly p95MaxLateSec: number;
  readonly requests: Readonly<
    Record<string, { readonly breachProb: number | null; readonly expectedLateSec: number }>
  >;
  readonly engineers: Readonly<Record<string, { readonly overrunProb: number }>>;
}

/**
 * Dry reliability of one applied plan. The call does not change routes.
 * `routes` is the fixed visit order already on screen.
 */
export function predictSituation(
  token: string,
  input: {
    inputHash: string;
    routerContextVersion: string;
    routes: Record<string, string[]>;
    asOf?: number;
  },
): Promise<SituationPredictionView> {
  return requestJson(
    '/api/v1/dispatch/predictions/situation',
    situationPredictionSchema,
    token,
    {
      method: 'POST',
      body: JSON.stringify({
        inputHash: input.inputHash,
        routerContextVersion: input.routerContextVersion,
        routes: input.routes,
        simulations: 300,
        asOf: input.asOf,
      }),
    },
    25_000,
  ).then((parsed) => ({
    robustness: parsed.plan.robustness,
    visitsTotal: parsed.plan.visits_total,
    expectedLate: parsed.plan.expected_late,
    expectedLateShare: parsed.plan.expected_late_share,
    p95LateCount: parsed.plan.p95_late_count,
    p95MaxLateSec: parsed.plan.p95_max_late_sec,
    requests: Object.fromEntries(
      Object.entries(parsed.requests).map(([id, row]) => [
        id,
        { breachProb: row.breach_prob, expectedLateSec: row.expected_late_sec },
      ]),
    ),
    engineers: Object.fromEntries(
      Object.entries(parsed.engineers).map(([id, row]) => [id, { overrunProb: row.overrun_prob }]),
    ),
  }));
}

const weatherSchema = z.object({
  observedAt: z.number(),
  temperatureC: z.number().nullable(),
  weatherCode: z.number().nullable(),
  kind: z.enum(['clear', 'cloud', 'rain', 'snow', 'storm', 'unknown']),
  label: z.string(),
  trafficMultiplier: z.number().min(1),
});

export type DispatchWeather = z.infer<typeof weatherSchema>;

/** Cached Moscow forecast. The multiplier is already inside car travel times. */
export function loadDispatchWeather(token: string): Promise<DispatchWeather> {
  return requestJson('/api/v1/dispatch/weather', weatherSchema, token);
}

/** Same forecast for the engineer shift screen. Dispatcher tokens cannot call this. */
export function loadEngineerWeather(token: string): Promise<DispatchWeather> {
  return requestJson('/api/v1/engineer/weather', weatherSchema, token);
}

const aiViewSchema = z.object({
  settings: z.object({
    planCalibrationEnabled: z.boolean(),
    planCalibrationEnabledRaw: z.boolean().nullable(),
    llmApiUrl: z.string().nullable(),
    llmModel: z.string().nullable(),
    llmApiKeySet: z.boolean(),
    llmApiKeyLast4: z.string().nullable(),
    jevApiUrl: z.string().nullable(),
    jevModel: z.string().nullable(),
    jevApiKeySet: z.boolean(),
    jevApiKeyLast4: z.string().nullable(),
  }),
  status: z.object({
    source: z.enum(['factory', 'learned']),
    version: z.string().nullable(),
    confidence: z.number().min(0).max(1),
    samples: z.object({
      service: z.number().int().nonnegative(),
      legs: z.number().int().nonnegative(),
      cancelRequests: z.number().int().nonnegative(),
      executionDays: z.number().int().nonnegative(),
    }),
    computedAt: z.number().nullable(),
    syncedToRouter: z.boolean(),
    weatherCalibration: z
      .object({
        status: z.enum(['factory', 'collecting', 'shadow', 'validated']),
        observationCount: z.number().int().nonnegative(),
        days: z.number().int().nonnegative(),
        eligibleGroups: z.number().int().nonnegative(),
        totalGroups: z.number().int().nonnegative(),
        version: z.string().nullable(),
        source: z.literal('travel_elapsed_proxy'),
        uncertainty: z.literal('not_estimated').optional(),
        reason: z.string(),
      })
      .optional(),
  }),
});

export type AiView = z.infer<typeof aiViewSchema>;

/** AI contour controls plus the live calibration reading. */
export function getAiSettings(token: string): Promise<AiView> {
  return requestJson('/api/v1/dispatch/ai', aiViewSchema, token);
}

const aiPolicySchema = z.object({
  id: z.string(),
  label: z.string(),
  steps: z.array(z.string()).default([]),
});
const aiResolveSchema = z.object({
  choice: z.string(),
  applied: z.boolean().optional(),
  engineerId: z.string().nullable().optional(),
  minutes: z.number().nullable().optional(),
  windowStartAt: z.number().nullable().optional(),
  windowEndAt: z.number().nullable().optional(),
  expectedRequestVersion: z.number().nullable().optional(),
});

/** System one picks a policy and the server publishes that choice. */
export function optimizePlanWithAi(
  token: string,
  summary: string,
): Promise<{ id: string; label: string; steps: string[] }> {
  return requestJson(
    '/api/v1/dispatch/ai/optimize',
    aiPolicySchema,
    token,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ summary }),
    },
    120_000,
  );
}

export interface AiAlertProposal {
  readonly choice: string;
  readonly applied?: boolean;
  readonly engineerId?: string | null;
  readonly minutes?: number | null;
  readonly windowStartAt?: number | null;
  readonly windowEndAt?: number | null;
  readonly expectedRequestVersion?: number | null;
}

/** System one picks an allowed action and does not apply it. */
export function proposeAlertWithAi(token: string, alertId: string): Promise<AiAlertProposal> {
  return requestJson(
    `/api/v1/dispatch/alerts/${alertId}/ai-resolve?apply=0`,
    aiResolveSchema,
    token,
    { method: 'POST' },
    30_000,
  );
}

/** System one picks an allowed action; the server applies the usual alert resolve. */
export function resolveAlertWithAi(token: string, alertId: string): Promise<AiAlertProposal> {
  return requestJson(
    `/api/v1/dispatch/alerts/${alertId}/ai-resolve`,
    aiResolveSchema,
    token,
    {
      method: 'POST',
    },
    30_000,
  );
}

export function saveAiSettings(
  token: string,
  input: {
    planCalibrationEnabled?: boolean;
    llmApiUrl?: string | null;
    llmModel?: string | null;
    llmApiKey?: string;
    clearLlmApiKey?: boolean;
    jevApiUrl?: string | null;
    jevModel?: string | null;
    jevApiKey?: string;
    clearJevApiKey?: boolean;
  },
): Promise<AiView> {
  return requestJson('/api/v1/dispatch/ai', aiViewSchema, token, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operationId: `ai-${Date.now()}`, ...input }),
  });
}

export async function requestJson<T>(
  path: string,
  schema: z.ZodType<T>,
  token?: string,
  init: RequestInit = {},
  timeoutMs = 12_000,
): Promise<T> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...Object.fromEntries(new Headers(init.headers)),
      },
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const conflict = z
        .object({ error: z.object({ details: z.object({ kind: z.literal('manual_conflict') }) }) })
        .safeParse(body);
      if (conflict.success && typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('manual-planning-open', { detail: 'priorities' }));
      }
      const challenge = windowConfirmationFrom(body);
      if (challenge) {
        if (new Headers(init.headers).has('x-window-change-confirmation')) {
          throw new DashboardApiError(t('api.client.de2eeb60e1'), 409, path);
        }
        globalThis.clearTimeout(timeout);
        if (!(await confirmWindowChange(challenge))) throw new WindowChangeDeclined();
        return await requestJson(
          path,
          schema,
          token,
          {
            ...init,
            headers: {
              ...Object.fromEntries(new Headers(init.headers)),
              'x-window-change-confirmation': challenge.confirmation,
            },
          },
          timeoutMs,
        );
      }
      throw new DashboardApiError(
        apiErrorMessage(body, response.status),
        response.status,
        path,
        response.headers.get('x-request-id'),
      );
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success)
      throw new DashboardApiError(
        t('api.client.5a8cee96af'),
        0,
        path,
        response.headers.get('x-request-id'),
      );
    return parsed.data;
  } catch (cause) {
    if (cause instanceof WindowChangeDeclined) throw cause;
    if (cause instanceof DashboardApiError) throw cause;
    throw new DashboardApiError(
      controller.signal.aborted
        ? t('api.client.cd789f99b2', { value0: Math.ceil(timeoutMs / 1000) })
        : t('api.client.80df7b5c58'),
      0,
      path,
    );
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

function apiErrorMessage(body: unknown, status: number): string {
  const parsed = z
    .object({
      message: z.union([z.string(), z.array(z.string())]).optional(),
      error: z.union([z.string(), z.object({ message: z.string().optional() })]).optional(),
    })
    .passthrough()
    .safeParse(body);
  if (!parsed.success) {
    return `HTTP ${status}`;
  }
  if (Array.isArray(parsed.data.message)) {
    return parsed.data.message.join('; ');
  }
  if (typeof parsed.data.message === 'string') {
    return parsed.data.message;
  }
  if (typeof parsed.data.error === 'string') {
    return parsed.data.error;
  }
  return parsed.data.error?.message ?? `HTTP ${status}`;
}

function moscowDate(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** Save only the System Layer arrival rule, without modifying Router optimization settings. */
export function setOrdinaryReplanning(token: string, disabled: boolean) {
  return requestJson(
    '/api/v1/dispatch/policy/ordinary-replanning',
    z.object({ ordinaryReplanningDisabled: z.boolean(), released: z.number().int() }),
    token,
    {
      method: 'POST',
      body: JSON.stringify({ operationId: crypto.randomUUID(), disabled }),
    },
  );
}
