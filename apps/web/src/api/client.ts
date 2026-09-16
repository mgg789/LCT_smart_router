import { z } from 'zod';
import type {
  AssignmentReasons,
  AuthSession,
  DashboardSnapshot,
  PlanAssignmentView,
  PolicyId,
  RouterTechnicalSettings,
} from './types';

const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '');
const policyIdSchema = z.enum(['compact', 'fast', 'sla', 'balanced', 'eco']);

const requestSchema = z.object({
  id: z.string(),
  version: z.number().int(),
  lifecycle: z.enum(['draft', 'submitted', 'in_progress', 'completed', 'cancelled']),
  assignmentState: z.enum(['pending', 'unassigned', 'assigned', 'in_progress', 'done']),
  addressText: z.string(),
  lat: z.number().nullable(),
  lon: z.number().nullable(),
  needsGeocoding: z.boolean(),
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
  completedAt: z.number().int().nullable(),
  cancelledAt: z.number().int().nullable(),
});

const engineerDaySchema = z.object({
  engineerId: z.string(),
  workDate: z.string(),
  version: z.number().int(),
  shiftStartAt: z.number().int(),
  shiftEndAt: z.number().int(),
  availability: z.enum(['online', 'offline', 'technical_break']),
  expectedOnlineAt: z.number().int().nullable(),
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
  hasAccount: z.boolean(),
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
  restoreOption: z.string().nullable(),
  createdAt: z.number().int(),
  seenAt: z.number().int().nullable(),
  resolvedAt: z.number().int().nullable(),
});

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
  ) {
    super(message);
    this.name = 'DashboardApiError';
  }
}

/** Authenticates a dispatcher without exposing configured credentials to the bundle. */
export async function loginDispatcher(email: string, password: string): Promise<AuthSession> {
  return requestJson('/api/v1/auth/dispatcher/password', authSessionSchema, undefined, {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

/** Invalidates the current server session. */
export async function signOutDispatcher(token: string): Promise<void> {
  await requestJson('/api/v1/auth/session', z.object({ signedOut: z.boolean() }), token, {
    method: 'DELETE',
  });
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

  return {
    workDate,
    timeZone: 'Europe/Moscow',
    nowAt: Math.floor(Date.now() / 1000),
    policyId: policies.active.policyId,
    lunchesEnabled: settings.lunchesEnabled,
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

/** Replaces only the lunch choice while preserving every other Router-owned setting. */
export async function setLunchesEnabled(token: string, enabled: boolean): Promise<string> {
  const current = await getRouterTechnicalSettings(token);
  const updated = await requestJson(
    '/api/v1/dispatch/router/technical-settings',
    technicalSettingsUpdateSchema,
    token,
    {
      method: 'PUT',
      body: JSON.stringify({
        operationId: crypto.randomUUID(),
        expectedContextVersion: current.routerContextVersion,
        lunchesEnabled: enabled,
        departureLatenessToleranceSec: current.departureLatenessToleranceSec,
        taskStartLatenessToleranceSec: current.taskStartLatenessToleranceSec,
        travelTimeMode: current.travelTimeMode,
        accessBufferSec: current.accessBufferSec,
        fixedTravelTimeSec: current.fixedTravelTimeSec,
        earlyFinishReplanThresholdSec: current.earlyFinishReplanThresholdSec,
        taskOverrunToleranceSec: current.taskOverrunToleranceSec,
      }),
    },
  );
  return updated.routerContextVersion;
}

/** Switches the dispatch control mode through an idempotent backend operation. */
export async function setDispatchMode(token: string, mode: 'auto' | 'manual'): Promise<void> {
  await requestJson('/api/v1/dispatch/mode', z.unknown(), token, {
    method: 'POST',
    body: JSON.stringify({ operationId: crypto.randomUUID(), mode }),
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
  const parsed = reasonSchema.safeParse(reason);
  return parsed.success ? parsed.data.text : 'Подробности доступны в структурированных данных';
}

async function requestJson<T>(
  path: string,
  schema: z.ZodType<T>,
  token?: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      accept: 'application/json',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...Object.fromEntries(new Headers(init.headers)),
    },
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = z
      .object({
        message: z.string().optional(),
        error: z.object({ message: z.string() }).optional(),
      })
      .safeParse(body);
    throw new DashboardApiError(
      message.success
        ? (message.data.error?.message ?? message.data.message ?? `HTTP ${response.status}`)
        : `HTTP ${response.status}`,
      response.status,
    );
  }
  return schema.parse(body);
}

function moscowDate(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}
