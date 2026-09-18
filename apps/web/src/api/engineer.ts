import { z } from 'zod';
import { requestJson } from './client';
import type {
  EngineerAuthSession,
  EngineerDayView,
  EngineerPlanResponse,
  EngineerView,
  PlanStopView,
  RequestView,
} from './types';

const loginCodeSchema = z.object({
  email: z.email(),
  expiresAt: z.number().int(),
  devCode: z.string().optional(),
});

const engineerSessionSchema = z.object({
  token: z.string().min(1),
  role: z.literal('engineer'),
  expiresAt: z.number().int(),
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
  email: z.string().nullable(),
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
  requiredSkill: z.string(),
  normProfileCode: z.string().optional(),
  normativeTravelDurationSec: z.number().int().optional(),
  technicalDurationSec: z.number().int().optional(),
  documentationDurationSec: z.number().int().optional(),
  serviceDurationSec: z.number().int(),
  actualDurationSec: z.number().int().nullable().optional(),
  durationVarianceSec: z.number().int().nullable().optional(),
  windowStartAt: z.number().int(),
  windowEndAt: z.number().int(),
  priority: z.enum(['normal', 'urgent']),
  contactName: z.string().nullable(),
  problemText: z.string().nullable(),
  createdAt: z.number().int(),
  submittedAt: z.number().int().nullable(),
  startedAt: z.number().int().nullable(),
  expectedCompletionAt: z.number().int().nullable().optional(),
  continuationAvailableAt: z.number().int().nullable().optional(),
  overrunDetectedAt: z.number().int().nullable().optional(),
  completedAt: z.number().int().nullable(),
  cancelledAt: z.number().int().nullable(),
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
  trafficFactor: z.number().min(1),
  geometry: z
    .object({
      points: z.array(z.object({ lat: z.number(), lon: z.number() })).min(2),
    })
    .nullable(),
});

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
  lunchStatus: z.enum([
    'none',
    'planned',
    'taken',
    'skipped',
    'disabled',
    'already_taken',
    'scheduled',
    'skipped_for_work',
    'not_scheduled',
    'required_conflict',
  ]),
  stops: z.array(planStopSchema),
  legs: z
    .array(planLegSchema)
    .optional()
    .transform((value) => value ?? []),
});

const daySchema = z.object({
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

const planSchema = z.object({
  planAsOf: z.number().int().nullable(),
  origin: z.enum(['auto', 'manual']).nullable().optional(),
  revision: z.number().int().nullable().optional(),
  route: routeSchema.nullable(),
  requests: z.array(requestSchema).optional().default([]),
});

/** Asks the public login-code contour to mail a one-time code. */
export function requestEngineerLoginCode(email: string): Promise<z.infer<typeof loginCodeSchema>> {
  return requestJson('/api/v1/auth/login-code', loginCodeSchema, undefined, {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}

/** Exchanges a mailed code for an engineer session. The role is granted, never claimed. */
export function verifyEngineerLoginCode(email: string, code: string): Promise<EngineerAuthSession> {
  return requestJson('/api/v1/auth/login-code/verify', engineerSessionSchema, undefined, {
    method: 'POST',
    body: JSON.stringify({ email, code, role: 'engineer' }),
  });
}

/** Ends the current engineer session on the server. */
export async function signOutEngineer(token: string): Promise<void> {
  await requestJson('/api/v1/auth/session', z.object({ signedOut: z.boolean() }), token, {
    method: 'DELETE',
  });
}

/** Profile of the signed-in engineer. */
export async function loadEngineerProfile(token: string): Promise<EngineerView> {
  const body = await requestJson(
    '/api/v1/engineer/profile',
    z.object({ engineer: engineerSchema }),
    token,
  );
  return body.engineer;
}

/** Shift and lunch state of the current working day. */
export async function loadEngineerDay(token: string): Promise<EngineerDayView> {
  const body = await requestJson('/api/v1/engineer/day', z.object({ day: daySchema }), token);
  return body.day;
}

/** Working route plus the request cards that belong on it. */
export async function loadEngineerPlan(token: string): Promise<EngineerPlanResponse> {
  const body = await requestJson('/api/v1/engineer/plan', planSchema, token);
  return {
    planAsOf: body.planAsOf,
    origin: body.origin ?? null,
    revision: body.revision ?? null,
    route: body.route,
    requests: body.requests,
  };
}

/** One assigned request, only when it is on this engineer's applied route. */
export async function loadEngineerRequest(
  token: string,
  requestId: string,
): Promise<{ request: RequestView; stop: PlanStopView }> {
  return requestJson(
    `/api/v1/engineer/requests/${encodeURIComponent(requestId)}`,
    z.object({ request: requestSchema, stop: planStopSchema }),
    token,
  );
}

/** Updates the engineer's own name or transport. */
export async function updateEngineerProfile(
  token: string,
  input: {
    readonly expectedVersion: number;
    readonly displayName?: string;
    readonly transportType?: EngineerView['transportType'];
  },
): Promise<EngineerView> {
  const body = await requestJson(
    '/api/v1/engineer/profile',
    z.object({ engineer: engineerSchema }),
    token,
    {
      method: 'PATCH',
      body: JSON.stringify({
        operationId: crypto.randomUUID(),
        expectedVersion: input.expectedVersion,
        ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
        ...(input.transportType === undefined ? {} : { transportType: input.transportType }),
      }),
    },
  );
  return body.engineer;
}

/** Sends a confirmation code to the address the engineer wants to use next. */
export function requestEngineerEmailChange(
  token: string,
  email: string,
): Promise<z.infer<typeof loginCodeSchema>> {
  return requestJson('/api/v1/engineer/email-change', loginCodeSchema, token, {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}

/** Confirms the new login after the code arrived. */
export async function confirmEngineerEmailChange(
  token: string,
  email: string,
  code: string,
): Promise<EngineerView> {
  const body = await requestJson(
    '/api/v1/engineer/email-change/confirm',
    z.object({ engineer: engineerSchema }),
    token,
    {
      method: 'POST',
      body: JSON.stringify({ email, code }),
    },
  );
  return body.engineer;
}
