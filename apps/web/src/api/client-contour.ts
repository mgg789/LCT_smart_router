import { z } from 'zod';
import { requestJson } from './client';
import type { ClientAuthSession, ClientWorkType, EquipmentType, RequestView } from './types';

/**
 * Client App contour: login, the customer's own requests, and the plain-form fallback to
 * `POST /client/requests` (`apps/api/src/api/client.controller.ts`).
 *
 * The wire shape mirrors that controller and its `RequestView` field-for-field, the same
 * duplication `api/engineer.ts` and `api/client.ts` already carry -- this workspace has no
 * shared contract package (see `api/ai.ts`'s doc comment).
 */

const loginCodeSchema = z.object({
  email: z.email(),
  expiresAt: z.number().int(),
  devCode: z.string().optional(),
});

const clientSessionSchema = z.object({
  token: z.string().min(1),
  role: z.literal('client'),
  expiresAt: z.number().int(),
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
  assumedStartedAt: z.number().int().nullable().optional(),
  assumedCompletedAt: z.number().int().nullable().optional(),
  completedAt: z.number().int().nullable(),
  cancelledAt: z.number().int().nullable(),
});

/** Asks the public login-code contour to mail a one-time code. */
export function requestClientLoginCode(email: string): Promise<z.infer<typeof loginCodeSchema>> {
  return requestJson('/api/v1/auth/login-code', loginCodeSchema, undefined, {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}

/** Exchanges a mailed code for a client session; the client role is granted on first
 * successful verification (context/36 section 7.2), never merely claimed. */
export function verifyClientLoginCode(email: string, code: string): Promise<ClientAuthSession> {
  return requestJson('/api/v1/auth/login-code/verify', clientSessionSchema, undefined, {
    method: 'POST',
    body: JSON.stringify({ email, code, role: 'client' }),
  });
}

/** Ends the current client session on the server. */
export async function signOutClient(token: string): Promise<void> {
  await requestJson('/api/v1/auth/session', z.object({ signedOut: z.boolean() }), token, {
    method: 'DELETE',
  });
}

/** Types of work the customer can choose from; the skill and duration follow server-side. */
export async function loadClientWorkTypes(token: string): Promise<ClientWorkType[]> {
  const body = await requestJson(
    '/api/v1/client/work-types',
    z.object({ workTypes: z.array(z.object({ code: z.string(), title: z.string() })) }),
    token,
  );
  return body.workTypes;
}

/** Active requests of the signed-in customer (draft, submitted or in progress). Never
 * includes an engineer name or a route -- the server view carries neither. */
export async function loadClientRequests(token: string): Promise<RequestView[]> {
  const body = await requestJson(
    '/api/v1/client/requests',
    z.object({ requests: z.array(requestSchema) }),
    token,
  );
  return body.requests;
}

export interface PrepareClientRequestInput {
  readonly contactName: string;
  readonly addressText: string;
  readonly workType: string;
  readonly requiredEquipment?: EquipmentType;
  readonly windowStartAt: number;
  readonly windowEndAt: number;
  readonly urgent: boolean;
  readonly problemText?: string;
}

/** Prepares a request from the plain form; it is not yet submitted (context/32 section 4.1). */
export async function prepareClientRequest(
  token: string,
  input: PrepareClientRequestInput,
): Promise<RequestView> {
  const body = await requestJson(
    '/api/v1/client/requests',
    z.object({ request: requestSchema }),
    token,
    {
      method: 'POST',
      body: JSON.stringify({
        operationId: crypto.randomUUID(),
        contactName: input.contactName,
        addressText: input.addressText,
        workType: input.workType,
        ...(input.requiredEquipment ? { requiredEquipment: input.requiredEquipment } : {}),
        windowStartAt: input.windowStartAt,
        windowEndAt: input.windowEndAt,
        urgent: input.urgent,
        ...(input.problemText ? { problemText: input.problemText } : {}),
      }),
    },
  );
  return body.request;
}

/** Confirms the prepared content and sends the request. */
export async function submitClientRequest(
  token: string,
  id: string,
  expectedVersion: number,
): Promise<RequestView> {
  const body = await requestJson(
    `/api/v1/client/requests/${encodeURIComponent(id)}/submit`,
    z.object({ request: requestSchema }),
    token,
    {
      method: 'POST',
      body: JSON.stringify({ operationId: crypto.randomUUID(), expectedVersion }),
    },
  );
  return body.request;
}

/** Changes the date and window of an already-submitted request, immediately. The
 * assistant deliberately has no tool for this -- it stays an ordinary button. */
export async function rescheduleClientRequest(
  token: string,
  id: string,
  input: { readonly windowStartAt: number; readonly windowEndAt: number; expectedVersion: number },
): Promise<RequestView> {
  const body = await requestJson(
    `/api/v1/client/requests/${encodeURIComponent(id)}/reschedule`,
    z.object({ request: requestSchema }),
    token,
    {
      method: 'POST',
      body: JSON.stringify({
        operationId: crypto.randomUUID(),
        windowStartAt: input.windowStartAt,
        windowEndAt: input.windowEndAt,
        expectedVersion: input.expectedVersion,
      }),
    },
  );
  return body.request;
}

/** Cancels a request that has not started. Stays an ordinary button, same as reschedule. */
export async function cancelClientRequest(
  token: string,
  id: string,
  input: { readonly reason?: string; readonly expectedVersion: number },
): Promise<RequestView> {
  const body = await requestJson(
    `/api/v1/client/requests/${encodeURIComponent(id)}/cancel`,
    z.object({ request: requestSchema }),
    token,
    {
      method: 'POST',
      body: JSON.stringify({
        operationId: crypto.randomUUID(),
        expectedVersion: input.expectedVersion,
        ...(input.reason ? { reason: input.reason } : {}),
      }),
    },
  );
  return body.request;
}
