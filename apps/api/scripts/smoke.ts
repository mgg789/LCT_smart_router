import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveSmokeBaseUrl } from './smoke-base-url';
import {
  type ExpectedSmokePlan,
  matchesSmokePlan,
  type SmokePlanResponse as PlanResponse,
} from './smoke-plan';

/**
 * End-to-end smoke gate for the real Docker contour.
 *
 * The script talks only to the public System Layer API. Router must read the published
 * snapshot from PostgreSQL, solve it, expose the result over the private Docker network,
 * and let sys apply it through the ordinary acceptance path. No result package is
 * fabricated here and the official dataset is deliberately not imported.
 *
 * Sequence: health → reset → policy → synthetic East sector → Router acceptance →
 * urgent-request event → second accepted plan. The last pair is TZ demo step 6
 * (one live event rebuilds the day). There is no UI button for that event; this
 * script uses the same dispatcher create-request path the stand already has.
 *
 * Run after `docker compose -f infra/docker-compose.yml up -d --build`. The gate is
 * destructive: it resets application data, and target validation therefore permits
 * loopback by default and requires an explicit allow-list for any other host.
 */

const BASE = resolveSmokeBaseUrl(process.env.SMOKE_BASE_URL, process.env.SMOKE_ALLOWED_HOSTS);
const DEFAULT_PLAN_TIMEOUT_MS = 45_000;
const POLL_INTERVAL_MS = 500;
const DEFAULT_SMOKE_POLICY_ID = 'balanced';

interface Step {
  readonly name: string;
  readonly detail?: string;
}

interface HttpResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly rawBody: string;
}

interface WaitForAppliedPlanInput extends ExpectedSmokePlan {
  readonly token: string;
  readonly publicationId: string;
  readonly timeoutMs: number;
}

interface SyntheticRequest {
  readonly addressText: string;
  readonly lat: number;
  readonly lon: number;
  readonly workType: string;
}

const EAST_ENGINEER_START = { lat: 55.6997977, lon: 37.7725762 };

// Exact nodes from core/scenarios/east-v1/geocodes.json. GraphTravel intentionally
// accepts only exact graph coordinates, so rounded or invented points would not prove
// that the complete routing path works.
const EAST_REQUESTS: readonly SyntheticRequest[] = [
  {
    addressText: 'Город Москва, пр-кт.Волгоградский, д. 128 к 5',
    lat: 55.7062794,
    lon: 37.7738951,
    workType: 'outage',
  },
  {
    addressText: 'Город Москва, пер.Маяковского, д. 2',
    lat: 55.7397743,
    lon: 37.6599082,
    workType: 'connection_request',
  },
  {
    addressText: 'Город Москва, ул.Грайвороновская, д. 10 к 2',
    lat: 55.7173273,
    lon: 37.7266148,
    workType: 'monitoring',
  },
  {
    addressText: 'Город Москва, ул.Михайлова, д. 14',
    lat: 55.7270299,
    lon: 37.7659603,
    workType: 'information',
  },
];

/** Fifth exact East graph node, used only as the post-acceptance urgent event. */
const EAST_URGENT_REQUEST: SyntheticRequest = {
  addressText: 'Город Москва, ул.3-я Институтская, д. 5 к 2',
  lat: 55.7219922,
  lon: 37.7821899,
  workType: 'monitoring',
};

const steps: Step[] = [];
let failures = 0;

function pass(name: string, detail?: string): void {
  steps.push({ name, detail });
  process.stdout.write(`  ok    ${name}${detail ? ` — ${detail}` : ''}\n`);
}

function fail(name: string, detail: string): void {
  failures += 1;
  steps.push({ name, detail });
  process.stdout.write(`  FAIL  ${name} — ${detail}\n`);
}

function check(condition: boolean, name: string, detail: string): void {
  if (condition) {
    pass(name, detail);
  } else {
    fail(name, detail);
  }
}

async function call(
  method: string,
  path: string,
  token?: string,
  body?: unknown,
): Promise<HttpResult> {
  const target = new URL(path, BASE).toString();
  const response = await fetch(target, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const rawBody = await response.text();
  let parsed: unknown = {};
  if (rawBody) {
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      parsed = { raw: rawBody };
    }
  }
  return {
    status: response.status,
    body:
      typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : { value: parsed },
    rawBody,
  };
}

function requireStatus(result: HttpResult, expected: number, action: string): void {
  if (result.status !== expected) {
    throw new Error(
      `${action} returned HTTP ${result.status}; response: ${result.rawBody || '<empty>'}`,
    );
  }
}

function loadRootEnv(): Record<string, string> {
  const values: Record<string, string> = {};
  try {
    const content = readFileSync(resolve(process.cwd(), '../../.env'), 'utf8');
    for (const line of content.split('\n')) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (match?.[1]) {
        values[match[1]] = (match[2] ?? '').trim();
      }
    }
  } catch {
    // Environment variables remain the source when the script is not run from apps/api.
  }
  return values;
}

function positiveInteger(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${raw}`);
  }
  return value;
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function waitForAppliedPlan(input: WaitForAppliedPlanInput): Promise<PlanResponse> {
  const deadline = Date.now() + input.timeoutMs;
  let last: PlanResponse = {};
  while (Date.now() < deadline) {
    const response = await call('GET', '/api/v1/dispatch/plan', input.token);
    requireStatus(response, 200, 'read working plan');
    last = response.body as PlanResponse;
    if (matchesSmokePlan(last, input)) {
      return last;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(
    `Router plan was not applied within ${input.timeoutMs} ms for publication ${input.publicationId}; ` +
      `last backend state: ${JSON.stringify(last)}`,
  );
}

async function main(): Promise<void> {
  process.stdout.write(`Smoke gate against ${BASE}\n\n`);
  const env = loadRootEnv();
  const dispatcherEmail = process.env.DISPATCHER_EMAIL ?? env.DISPATCHER_EMAIL;
  const dispatcherPassword = process.env.DISPATCHER_PASSWORD ?? env.DISPATCHER_PASSWORD;
  const appTimeZone = process.env.APP_TIME_ZONE ?? env.APP_TIME_ZONE ?? 'Europe/Moscow';
  const planTimeoutMs = positiveInteger(
    process.env.SMOKE_PLAN_TIMEOUT_MS,
    DEFAULT_PLAN_TIMEOUT_MS,
    'SMOKE_PLAN_TIMEOUT_MS',
  );
  const targetPolicyId = process.env.SMOKE_POLICY_ID ?? DEFAULT_SMOKE_POLICY_ID;
  if (!dispatcherEmail || !dispatcherPassword) {
    throw new Error('DISPATCHER_EMAIL and DISPATCHER_PASSWORD are needed; copy .env.example');
  }

  // Check the public health surface before the destructive reset begins.
  const live = await call('GET', '/health/live');
  requireStatus(live, 200, 'liveness probe');
  check(live.body.status === 'ok', 'API process is live', `status=${String(live.body.status)}`);

  const ready = await call('GET', '/health/ready');
  requireStatus(ready, 200, 'readiness probe');
  check(
    ready.body.status === 'ok',
    'required services are ready',
    `status=${String(ready.body.status)}`,
  );

  const health = await call('GET', '/health/services');
  requireStatus(health, 200, 'service health probe');
  const services = (health.body.services ?? {}) as Record<string, { status?: string }>;
  check(
    services.database?.status === 'ok',
    'database reachable',
    `database=${String(services.database?.status)}`,
  );
  check(
    services.router?.status === 'ok',
    'Router reachable from backend',
    `router=${String(services.router?.status)}`,
  );
  if (failures > 0) {
    throw new Error('health prerequisites failed; application data was not reset');
  }

  const signIn = async (): Promise<string> => {
    const response = await call('POST', '/api/v1/auth/dispatcher/password', undefined, {
      email: dispatcherEmail,
      password: dispatcherPassword,
    });
    requireStatus(response, 201, 'dispatcher sign-in');
    const token = response.body.token;
    if (typeof token !== 'string' || token.length === 0) {
      throw new Error('dispatcher sign-in returned no bearer token');
    }
    return token;
  };

  let dispatcher = await signIn();
  pass('dispatcher signs in by password', 'no SMTP involved');

  const reset = await call('POST', '/api/v1/dispatch/data/reset', dispatcher, {
    operationId: randomUUID(),
    kind: 'empty',
    confirmation: 'erase all application data',
  });
  requireStatus(reset, 201, 'empty data reset');
  dispatcher = await signIn();
  pass('application data reset', `generation=${String(reset.body.generation)}`);

  // Ensure the intended policy and the complete backend policy catalogue are active.
  let policiesResponse = await call('GET', '/api/v1/dispatch/policies', dispatcher);
  requireStatus(policiesResponse, 200, 'read policy catalogue');
  const catalogue = policiesResponse.body.policies as Array<{ policyId: string }> | undefined;
  const policyIds = catalogue?.map((policy) => policy.policyId) ?? [];
  check(
    ['fast', 'compact', 'sla', 'balanced', 'eco'].every((policyId) => policyIds.includes(policyId)),
    'five Router policies are exposed by backend',
    policyIds.join(', '),
  );
  if (!policyIds.includes(targetPolicyId)) {
    throw new Error(`SMOKE_POLICY_ID is not in the backend catalogue: ${targetPolicyId}`);
  }
  const active = policiesResponse.body.active as { policyId?: string } | undefined;
  if (active?.policyId !== targetPolicyId) {
    const selected = await call('POST', '/api/v1/dispatch/policy', dispatcher, {
      operationId: randomUUID(),
      policyId: targetPolicyId,
    });
    requireStatus(selected, 201, `select ${targetPolicyId} policy`);
    policiesResponse = await call('GET', '/api/v1/dispatch/policies', dispatcher);
    requireStatus(policiesResponse, 200, 're-read active policy');
  }
  const activeAfter = policiesResponse.body.active as { policyId?: string } | undefined;
  check(
    activeAfter?.policyId === targetPolicyId,
    `${targetPolicyId} policy is active`,
    `active=${String(activeAfter?.policyId)}`,
  );

  // Build a small feasible task through the backend using exact East graph nodes.
  const now = Math.floor(Date.now() / 1000);
  const workDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: appTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const engineerResponse = await call('POST', '/api/v1/dispatch/engineers', dispatcher, {
    operationId: randomUUID(),
    email: `smoke.engineer.${randomUUID().slice(0, 8)}@example.test`,
    displayName: 'Smoke East Engineer',
    skills: ['local', 'connection', 'emergency'],
    transportType: 'car',
    region: 'east',
    homeLat: EAST_ENGINEER_START.lat,
    homeLon: EAST_ENGINEER_START.lon,
  });
  requireStatus(engineerResponse, 201, 'create smoke engineer');
  const engineer = (engineerResponse.body as { engineer?: { id?: string } }).engineer;
  if (!engineer?.id) {
    throw new Error('engineer creation returned no id');
  }

  const workday = await call(
    'POST',
    `/api/v1/dispatch/engineers/${engineer.id}/workday`,
    dispatcher,
    {
      operationId: randomUUID(),
      workDate,
      shiftStartAt: now - 5 * 60,
      shiftEndAt: now + 10 * 3600,
      lunch: {
        enabled: false,
        durationSec: null,
        windowStartAt: null,
        windowEndAt: null,
      },
    },
  );
  requireStatus(workday, 201, 'set smoke engineer workday');
  pass('East engineer and shift created', engineer.id);

  const requestIds: string[] = [];
  for (const [index, synthetic] of EAST_REQUESTS.entries()) {
    const created = await call('POST', '/api/v1/dispatch/requests', dispatcher, {
      operationId: randomUUID(),
      clientEmail: `smoke.client.${index + 1}@example.test`,
      contactName: `Smoke Client ${index + 1}`,
      addressText: synthetic.addressText,
      lat: synthetic.lat,
      lon: synthetic.lon,
      workType: synthetic.workType,
      windowStartAt: now + 60,
      windowEndAt: now + 8 * 3600,
    });
    requireStatus(created, 201, `create synthetic request ${index + 1}`);
    const request = (created.body as { request?: { id?: string } }).request;
    if (!request?.id) {
      throw new Error(`synthetic request ${index + 1} returned no id`);
    }
    requestIds.push(request.id);
  }
  pass('synthetic requests accepted by backend', `${requestIds.length} exact East points`);

  // Inspect the publication through sys only; Router reads the same bytes from PostgreSQL.
  const snapshotResponse = await call('GET', '/api/v1/dispatch/debug/snapshot', dispatcher);
  requireStatus(snapshotResponse, 200, 'read published snapshot diagnostics');
  const publicationId = snapshotResponse.body.publicationId;
  const inputHash = snapshotResponse.body.inputHash;
  const payload = snapshotResponse.body.payload;
  if (
    typeof publicationId !== 'string' ||
    typeof inputHash !== 'string' ||
    typeof payload !== 'string'
  ) {
    throw new Error(`backend did not publish a complete snapshot: ${snapshotResponse.rawBody}`);
  }
  const document = JSON.parse(payload) as {
    requests: Array<{ request_id: string }>;
    engineers: Array<{ engineer_id: string }>;
    policy: { policy_id: string };
  };
  check(
    requestIds.every((requestId) =>
      document.requests.some((request) => request.request_id === requestId),
    ) && document.engineers.some((item) => item.engineer_id === engineer.id),
    'published sector contains the complete synthetic task',
    `${document.requests.length} requests, ${document.engineers.length} engineers`,
  );
  check(
    document.policy.policy_id === targetPolicyId,
    `published task carries ${targetPolicyId} policy`,
    `publication=${publicationId}, hash=${inputHash.slice(0, 12)}`,
  );

  // Real asynchronous route: sector -> Router -> private HTTP -> sys acceptance -> plan.
  const plan = await waitForAppliedPlan({
    token: dispatcher,
    requestIds,
    engineerId: engineer.id,
    publicationId,
    inputHash,
    timeoutMs: planTimeoutMs,
  });
  const firstRevision = plan.plan?.revision;
  const firstResultId = plan.appliedResult?.resultId;
  if (firstRevision === undefined || firstResultId === undefined) {
    throw new Error(`accepted plan is missing revision or result id: ${JSON.stringify(plan)}`);
  }
  check(
    plan.plan?.origin === 'auto' && plan.plan.assignments.length === requestIds.length,
    'Router result became the automatic working plan',
    `revision=${String(plan.plan?.revision)}, assignments=${String(plan.plan?.assignments.length)}`,
  );
  check(
    plan.appliedResult?.inputHash === inputHash,
    'backend accepted the current Router package',
    `result=${String(plan.appliedResult?.resultId)}`,
  );

  const requestsResponse = await call('GET', '/api/v1/dispatch/requests', dispatcher);
  requireStatus(requestsResponse, 200, 'read requests after routing');
  const requestViews = requestsResponse.body.requests as
    | Array<{ id: string; assignmentState: string }>
    | undefined;
  check(
    requestIds.every(
      (requestId) =>
        requestViews?.find((request) => request.id === requestId)?.assignmentState === 'assigned',
    ),
    'backend request state reflects the applied plan',
    `${requestIds.length} assigned requests`,
  );

  // TZ demo step 6 / expert Q3: one event must rebuild the accepted day. Smoke talks
  // to the API; the UI event remains engineer-offline. Creating an urgent request is
  // the publication trigger `request.submitted`.
  const urgentCreated = await call('POST', '/api/v1/dispatch/requests', dispatcher, {
    operationId: randomUUID(),
    clientEmail: `smoke.urgent.${randomUUID().slice(0, 8)}@example.test`,
    contactName: 'Smoke Urgent Client',
    addressText: EAST_URGENT_REQUEST.addressText,
    lat: EAST_URGENT_REQUEST.lat,
    lon: EAST_URGENT_REQUEST.lon,
    workType: EAST_URGENT_REQUEST.workType,
    urgent: true,
    windowStartAt: now + 60,
    windowEndAt: now + 8 * 3600,
  });
  requireStatus(urgentCreated, 201, 'create urgent event request');
  const urgentRequest = (urgentCreated.body as { request?: { id?: string; priority?: string } })
    .request;
  if (!urgentRequest?.id) {
    throw new Error('urgent request returned no id');
  }
  check(
    urgentRequest.priority === 'urgent',
    'event request is urgent',
    `request=${urgentRequest.id}`,
  );

  const eventSnapshot = await call('GET', '/api/v1/dispatch/debug/snapshot', dispatcher);
  requireStatus(eventSnapshot, 200, 'read snapshot after urgent event');
  const eventPublicationId = eventSnapshot.body.publicationId;
  const eventInputHash = eventSnapshot.body.inputHash;
  if (typeof eventPublicationId !== 'string' || typeof eventInputHash !== 'string') {
    throw new Error(`urgent event did not publish a snapshot: ${eventSnapshot.rawBody}`);
  }
  check(
    eventPublicationId !== publicationId && eventInputHash !== inputHash,
    'urgent event published a new sector',
    `publication=${eventPublicationId}, hash=${eventInputHash.slice(0, 12)}`,
  );

  const replanned = await waitForAppliedPlan({
    token: dispatcher,
    requestIds: [...requestIds, urgentRequest.id],
    engineerId: engineer.id,
    publicationId: eventPublicationId,
    inputHash: eventInputHash,
    timeoutMs: planTimeoutMs,
    minRevision: firstRevision,
    previousResultId: firstResultId,
  });
  check(
    (replanned.plan?.revision ?? 0) > firstRevision &&
      replanned.appliedResult?.resultId !== firstResultId,
    'urgent event produced a new accepted plan',
    `revision=${firstRevision}→${String(replanned.plan?.revision)}, result=${String(replanned.appliedResult?.resultId)}`,
  );
  check(
    replanned.plan?.assignments.some(
      (item) =>
        item.requestId === urgentRequest.id &&
        item.status === 'assigned' &&
        item.engineerId === engineer.id,
    ) === true,
    'replanned day includes the urgent request',
    `assignments=${String(replanned.plan?.assignments.length)}`,
  );

  const afterEventRequests = await call('GET', '/api/v1/dispatch/requests', dispatcher);
  requireStatus(afterEventRequests, 200, 'read requests after replan');
  const afterViews = afterEventRequests.body.requests as
    | Array<{ id: string; assignmentState: string; priority: string }>
    | undefined;
  const urgentView = afterViews?.find((item) => item.id === urgentRequest.id);
  check(
    urgentView?.assignmentState === 'assigned' && urgentView.priority === 'urgent',
    'backend request state reflects the rebuilt plan',
    `urgent=${urgentRequest.id}`,
  );

  const state = await call('GET', '/api/v1/dispatch/data/state', dispatcher);
  requireStatus(state, 200, 'read data state');
  check(state.body.initialized === true, 'data state remains readable', 'initialized=true');

  process.stdout.write(
    `\n${failures === 0 ? 'SMOKE GATE GREEN' : 'SMOKE GATE RED'} — ${steps.length - failures}/${steps.length} checks passed\n`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error: unknown) => {
  process.stdout.write(
    `\nSMOKE GATE RED — ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
