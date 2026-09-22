import { z } from 'zod';
import { requestJson } from '../api/client';
import {
  CLIENT_MAP_CENTER,
  type ClientProfileMemory,
  type ClientRequestDraft,
  type ClientRequestStatus,
  type ClientRequestView,
  clientPrepareBody,
  clientStatusLabel,
  isActualClientRequest,
} from './clientPreview';

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

const profileSchema = z.object({
  email: z.email(),
  contactName: z.string().nullable(),
  addressText: z.string().nullable(),
  lat: z.number().nullable(),
  lon: z.number().nullable(),
});

const requestSchema = z
  .object({
    id: z.string(),
    version: z.number().int(),
    lifecycle: z.string(),
    assignmentState: z.string(),
    addressText: z.string(),
    lat: z.number().nullable(),
    lon: z.number().nullable(),
    workTypeTitle: z.string().nullable(),
    serviceDurationSec: z.number().int(),
    windowStartAt: z.number().int(),
    windowEndAt: z.number().int(),
    contactName: z.string().nullable(),
    problemText: z.string().nullable(),
  })
  .passthrough();

/** One request as the client list and the detail page draw it. */
export type ClientApiRequest = z.infer<typeof requestSchema>;

export interface IssuedClientCode {
  readonly email: string;
  readonly expiresAt: number;
  readonly devCode?: string;
}

export interface IssuedClientSession {
  readonly token: string;
  readonly email: string;
  readonly expiresAt: number;
}

const geocodeHitSchema = z.object({
  displayName: z.string(),
  lat: z.number(),
  lon: z.number(),
});

/** One resolved address. The form uses it both for search and for a map click. */
export type ClientGeocodeHit = z.infer<typeof geocodeHitSchema>;

/**
 * Autocomplete for the new-request form.
 * No session header: the form is filled before the mailbox is confirmed,
 * and a stale bearer would be rejected even on this public route.
 */
export async function searchClientAddress(query: string): Promise<ClientGeocodeHit[]> {
  const params = new URLSearchParams({ q: query });
  const result = await requestJson(
    `/api/v1/client/geocode?${params.toString()}`,
    z.object({ hits: z.array(geocodeHitSchema) }),
  );
  return result.hits;
}

/**
 * Street address for a map click.
 * Null when the geocoder has no name; the form then writes the coordinates.
 */
export async function reverseClientPoint(point: {
  lat: number;
  lon: number;
}): Promise<ClientGeocodeHit | null> {
  const params = new URLSearchParams({ lat: String(point.lat), lon: String(point.lon) });
  const result = await requestJson(
    `/api/v1/client/geocode/reverse?${params.toString()}`,
    z.object({ hit: geocodeHitSchema.nullable() }),
  );
  return result.hit;
}

/** Mails a one-time code. Does not create an account and does not create a request. */
export function requestClientLoginCode(email: string): Promise<IssuedClientCode> {
  return requestJson('/api/v1/auth/login-code', loginCodeSchema, undefined, {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}

/**
 * Confirms the address and opens a client session.
 * The account is created on this call when it did not exist.
 */
export async function verifyClientLoginCode(
  email: string,
  code: string,
): Promise<IssuedClientSession> {
  const session = await requestJson(
    '/api/v1/auth/login-code/verify',
    clientSessionSchema,
    undefined,
    {
      method: 'POST',
      body: JSON.stringify({ email, code, role: 'client' }),
    },
  );
  return {
    token: session.token,
    email: email.trim().toLowerCase(),
    expiresAt: session.expiresAt,
  };
}

/** Card the list and the detail page already know how to draw. */
export function clientCardFromApi(request: ClientApiRequest): ClientRequestView {
  const actual = isActualClientRequest(request);
  return {
    id: request.id,
    number: request.id.replace(/-/g, '').slice(-4).toUpperCase(),
    startAt: request.windowStartAt,
    windowStartAt: request.windowStartAt,
    windowEndAt: request.windowEndAt,
    addressText: request.addressText,
    office: null,
    company: '',
    workTypeTitle: request.workTypeTitle ?? request.problemText ?? 'Заявка',
    problemTitle: request.problemText ?? request.workTypeTitle ?? 'Заявка',
    description: request.problemText ?? '',
    durationSec: request.serviceDurationSec,
    status: cardStatus(request, actual),
    statusLabel: clientStatusLabel(request),
    engineerName: null,
    engineerEtaLabel: null,
    engineerPortrait: null,
    lat: request.lat ?? CLIENT_MAP_CENTER.lat,
    lon: request.lon ?? CLIENT_MAP_CENTER.lon,
    archived: !actual,
  };
}

function cardStatus(
  request: { lifecycle: string; assignmentState: string },
  actual: boolean,
): ClientRequestStatus {
  if (!actual) return request.lifecycle === 'cancelled' ? 'cancelled' : 'completed';
  if (request.lifecycle === 'in_progress') return 'in_progress';
  if (request.assignmentState === 'assigned') return 'assigned';
  return 'unassigned';
}

/** Email, and the name and address kept from the last sent request. */
export function loadClientProfile(token: string): Promise<ClientProfileMemory> {
  return requestJson('/api/v1/client/profile', profileSchema, token);
}

/** Every sent request of this account, including completed and cancelled ones. */
export async function loadClientHistory(token: string): Promise<ClientApiRequest[]> {
  const body = await requestJson(
    '/api/v1/client/requests?scope=all',
    z.object({ requests: z.array(requestSchema) }),
    token,
  );
  return body.requests;
}

/** One owned request. A missing or foreign id is a not-found error. */
export async function loadClientRequest(token: string, id: string): Promise<ClientApiRequest> {
  const body = await requestJson(
    `/api/v1/client/requests/${encodeURIComponent(id)}`,
    z.object({ request: requestSchema }),
    token,
  );
  return body.request;
}

/**
 * Creates the request only after the caller holds a session for this email.
 * The server writes it already submitted, in one transaction.
 */
export async function createSubmittedClientRequest(
  token: string,
  draft: ClientRequestDraft,
): Promise<ClientApiRequest> {
  const prepared = clientPrepareBody(draft);
  if (prepared === null) {
    throw new Error('Заполните ФИО, адрес, точку на карте и почту.');
  }
  const body = await requestJson(
    '/api/v1/client/requests/submitted',
    z.object({ request: requestSchema }),
    token,
    {
      method: 'POST',
      body: JSON.stringify({ operationId: crypto.randomUUID(), ...prepared }),
    },
  );
  return body.request;
}
