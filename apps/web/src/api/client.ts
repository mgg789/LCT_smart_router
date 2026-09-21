import { z } from 'zod';
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
  MapProvidersStatus,
  OfficialImportSummary,
  PlanAssignmentView,
  PolicyComparisonResponse,
  PolicyId,
  RouterTechnicalSettings,
} from './types';

const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '');
const policyIdSchema = z.enum(['compact', 'fast', 'sla', 'balanced', 'eco', 'covering']);

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
  region: z.string().nullable(),
  homeLat: z.number().nullable(),
  homeLon: z.number().nullable(),
  hasAccount: z.boolean().optional().default(false),
  email: z.string().nullable().optional().default(null),
  day: engineerDaySchema.nullable(),
});

const planStopSchema = z.object({
  sequence: z.number().int(),
  kind: z.enum(['job', 'lunch', 'wait', 'start']),
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
  travelSource: z.enum(['approximate', 'road_matrix', 'route_api', 'traffic_api']),
  geometryProvider: z.enum(['twogis', 'yandex']).optional(),
  trafficFactor: z.number().min(1),
  geometry: z
    .object({
      points: z
        .array(z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) }))
        .min(2),
    })
    .nullable(),
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
  origin: z.enum(['auto', 'manual']),
  planAsOf: z.number().int(),
  appliedAt: z.number().int(),
  routes: z.array(routeSchema),
  assignments: z.array(rawAssignmentSchema),
});

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
  active: z.object({ policyId: policyIdSchema, version: z.number().int(), changedAt: z.number() }),
});

const technicalSettingsSchema = z.object({
  lunchesEnabled: z.boolean(),
  departureLatenessToleranceSec: z.number().int().nonnegative(),
  taskStartLatenessToleranceSec: z.number().int().nonnegative(),
  windowLatenessToleranceSec: z.number().int().nonnegative().max(1_200).default(0),
  trafficEnabled: z.boolean().default(true),
  equipmentEnabled: z.boolean().default(true),
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
          lateAssignedCount: z.number().int().nonnegative().default(0),
          totalLatenessSec: z.number().int().nonnegative().default(0),
          minWindowSlackSec: z.number().int().nullable().default(null),
          workloadSpreadSec: z.number().int().nonnegative().default(0),
          maxWorkloadSec: z.number().int().nonnegative().default(0),
        }),
      }),
    )
    .min(6)
    .max(7)
    .superRefine((rows, context) => {
      const strategyIds = new Set(rows.map((row) => row.strategyId));
      if (strategyIds.size !== rows.length) {
        context.addIssue({ code: 'custom', message: 'comparison strategies must be unique' });
      }
      if (
        !['fast', 'compact', 'sla', 'balanced', 'eco', 'baseline'].every((id) =>
          rows.some((row) => row.strategyId === id),
        )
      ) {
        context.addIssue({ code: 'custom', message: 'comparison strategies are incomplete' });
      }
      if (rows.some((row) => (row.strategyId === 'baseline') !== (row.kind === 'baseline'))) {
        context.addIssue({ code: 'custom', message: 'comparison strategy kind is inconsistent' });
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
    throw new DashboardApiError('Несогласованный снимок рабочего дня', 0, 'snapshot');
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

/** Loads and validates all resources required by the dispatcher day screen. */
export async function loadDashboardSnapshot(token: string): Promise<DashboardSnapshot> {
  const [requests, engineers, planResponse, alerts, policies, settings] = await Promise.all([
    requestJson('/api/v1/dispatch/requests', z.object({ requests: z.array(requestSchema) }), token),
    requestJson(
      '/api/v1/dispatch/engineers',
      z.object({ engineers: z.array(engineerSchema) }),
      token,
    ),
    requestJson('/api/v1/dispatch/plan', dispatchPlanSchema, token),
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
        lunchesEnabled: settings.lunchesEnabled,
        departureLatenessToleranceSec: settings.departureLatenessToleranceSec,
        taskStartLatenessToleranceSec: settings.taskStartLatenessToleranceSec,
        windowLatenessToleranceSec: settings.windowLatenessToleranceSec,
        trafficEnabled: settings.trafficEnabled,
        equipmentEnabled: settings.equipmentEnabled,
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
export async function setDispatchMode(token: string, mode: 'auto' | 'manual'): Promise<void> {
  await requestJson('/api/v1/dispatch/mode', z.unknown(), token, {
    method: 'POST',
    body: JSON.stringify({ operationId: crypto.randomUUID(), mode }),
  });
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
    throw new Error('Backend did not publish the engineer availability change');
  }
  return updated.publication.inputHash;
}

/** Uploads one locally validated data package as an idempotent backend operation. */
export function uploadDataPackage(token: string, file: DataUploadFile): Promise<DataUploadSummary> {
  return requestJson('/api/v1/dispatch/data/upload', dataUploadSummarySchema, token, {
    method: 'POST',
    body: JSON.stringify({ operationId: crypto.randomUUID(), ...file }),
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
export function importOfficialDataset(token: string): Promise<OfficialImportSummary> {
  return requestJson('/api/v1/dispatch/data/import', officialImportSummarySchema, token, {
    method: 'POST',
    body: JSON.stringify({ operationId: crypto.randomUUID(), regions: 'all' }),
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
      lunchStatus: z.string().optional(),
      assignedBefore: z.number().optional(),
      assignedAfter: z.number().optional(),
    })
    .safeParse(reason);
  if (facts.success) {
    const value = facts.data;
    if (value.shiftStartAt !== undefined && value.thresholdAt !== undefined)
      return `Смена началась в ${formatClock(value.shiftStartAt)}. К ${formatClock(value.thresholdAt)} отметка о выходе не поступила.`;
    if (value.plannedStartAt !== undefined && value.windowEndAt !== undefined) {
      return `Начало по плану — ${formatClock(value.plannedStartAt)}, конец окна — ${formatClock(value.windowEndAt)}. Опоздание: ${Math.ceil((value.plannedStartAt - value.windowEndAt) / 60)} мин.`;
    }
    if (value.expectedAt !== undefined)
      return `Ожидалась отметка к ${formatClock(value.expectedAt)}. ${value.lastAttendanceAt ? `Последняя отметка: ${formatClock(value.lastAttendanceAt)}.` : 'Отметок пока нет.'}`;
    if (value.assignment === 'unassigned')
      return 'Для заявки не найдено допустимое назначение. Нужно изменить условия или добавить инженера.';
    if (value.lunchStatus)
      return 'Обед не помещается в текущий маршрут. Требуется выбор диспетчера.';
    if (value.assignedBefore !== undefined && value.assignedAfter !== undefined)
      return `Назначено заявок: ${value.assignedBefore} → ${value.assignedAfter}.`;
  }
  return 'Подробности доступны в структурированных данных';
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
        'Ответ сервера не соответствует контракту',
        0,
        path,
        response.headers.get('x-request-id'),
      );
    return parsed.data;
  } catch (cause) {
    if (cause instanceof DashboardApiError) throw cause;
    throw new DashboardApiError(
      controller.signal.aborted ? 'Сервер не ответил за 12 секунд' : 'Нет связи с сервером',
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
