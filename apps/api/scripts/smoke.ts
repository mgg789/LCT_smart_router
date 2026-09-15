import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Smoke gate: the whole spine of the System Layer, end to end, against a running contour.
 *
 * Deliberately not an in-process test. It talks to the deployed artifact over HTTP, so it
 * proves the thing that actually ships works -- migrations applied, configuration read,
 * dataset mounted, every contour reachable (AGENTS.md section 11.1).
 *
 * Run it after `pnpm compose:up`. It is destructive: it resets the application data first,
 * so it never runs against anything but a development or demo contour.
 */

const BASE = process.env.SMOKE_BASE_URL ?? 'http://localhost:8000';

interface Step {
  readonly name: string;
  readonly detail?: string;
}

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
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

function loadRootEnv(): Record<string, string> {
  const values: Record<string, string> = {};
  try {
    const content = readFileSync(resolve(process.cwd(), '../../.env'), 'utf8');
    for (const line of content.split('\n')) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (match?.[1]) {
        values[match[1]] = (match[2] ?? '').trim();
      }
    }
  } catch {
    // Falls through to process.env below.
  }
  return values;
}

async function main(): Promise<void> {
  process.stdout.write(`Smoke gate against ${BASE}\n\n`);
  const env = loadRootEnv();
  const dispatcherEmail = process.env.DISPATCHER_EMAIL ?? env.DISPATCHER_EMAIL;
  const dispatcherPassword = process.env.DISPATCHER_PASSWORD ?? env.DISPATCHER_PASSWORD;
  if (!dispatcherEmail || !dispatcherPassword) {
    throw new Error('DISPATCHER_EMAIL and DISPATCHER_PASSWORD are needed; copy .env.example');
  }

  // 1. The contour is up and honest about what it does not have.
  const health = await call('GET', '/health/services');
  const services = (health.body.services ?? {}) as Record<string, { status: string }>;
  check(health.status === 200, 'contour answers', `/health/services -> ${health.status}`);
  check(
    services.database?.status === 'ok',
    'database reachable',
    `database=${services.database?.status}`,
  );
  check(
    services.router?.status === 'not_configured',
    'missing integrations reported honestly',
    `router=${services.router?.status}, ai=${services.ai?.status}, smtp=${services.smtp?.status}`,
  );

  // 2. The dispatcher signs in without SMTP.
  const signIn = async (): Promise<string> => {
    const response = await call('POST', '/api/v1/auth/dispatcher/password', undefined, {
      email: dispatcherEmail,
      password: dispatcherPassword,
    });
    if (response.status !== 201) {
      throw new Error(`dispatcher sign-in failed: ${JSON.stringify(response.body)}`);
    }
    return response.body.token as string;
  };
  let dispatcher = await signIn();
  pass('dispatcher signs in by password', 'no SMTP involved');

  // 3. A clean slate, so the gate measures this run and not the last one.
  const reset = await call('POST', '/api/v1/dispatch/data/reset', dispatcher, {
    operationId: randomUUID(),
    kind: 'empty',
    confirmation: 'erase all application data',
  });
  check(reset.status === 201, 'application data reset', `status ${reset.status}`);
  dispatcher = await signIn();

  // 4. The official dataset loads.
  const imported = await call('POST', '/api/v1/dispatch/data/import', dispatcher, {
    operationId: randomUUID(),
    region: 'east',
  });
  const summary = imported.body as {
    applied: boolean;
    requestsCreated: number;
    engineersCreated: number;
    requestsWithoutCoordinates: number;
    errors: string[];
  };
  check(
    imported.status === 201 && summary.applied && summary.errors.length === 0,
    'official dataset imports',
    `${summary.requestsCreated} requests, ${summary.engineersCreated} engineers`,
  );
  check(
    summary.requestsWithoutCoordinates === summary.requestsCreated,
    'coordinates are not invented',
    `${summary.requestsWithoutCoordinates} awaiting geocoding`,
  );

  // 5. A working engineer and a request with a real point, so the task is non-empty.
  const workDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: process.env.APP_TIME_ZONE ?? env.APP_TIME_ZONE ?? 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const now = Math.floor(Date.now() / 1000);

  const engineerResponse = await call('POST', '/api/v1/dispatch/engineers', dispatcher, {
    operationId: randomUUID(),
    email: `smoke.engineer.${randomUUID().slice(0, 8)}@example.test`,
    displayName: 'Smoke Engineer',
    skills: ['connection', 'emergency'],
    transportType: 'car',
    homeLat: 55.7155,
    homeLon: 37.7789,
  });
  const engineer = (engineerResponse.body as { engineer: { id: string } }).engineer;
  await call('POST', `/api/v1/dispatch/engineers/${engineer.id}/workday`, dispatcher, {
    operationId: randomUUID(),
    workDate,
    shiftStartAt: now - 3600,
    shiftEndAt: now + 8 * 3600,
  });
  pass('engineer created with a shift', engineer.id);

  const before = await call('GET', '/api/v1/dispatch/debug/snapshot', dispatcher);
  const hashBefore = before.body.inputHash as string | undefined;

  const created = await call('POST', '/api/v1/dispatch/requests', dispatcher, {
    operationId: randomUUID(),
    clientEmail: 'smoke.client@example.test',
    contactName: 'Смоук Клиент',
    addressText: 'Москва, ул.Грайвороновская, д. 10 к 2',
    lat: 55.7231,
    lon: 37.7328,
    workType: 'outage',
    windowStartAt: now + 1800,
    windowEndAt: now + 3 * 3600,
  });
  const request = (created.body as { request: { id: string; priority: string } }).request;
  check(
    created.status === 201 && request.priority === 'urgent',
    'request created and classified',
    `priority ${request.priority} derived from the type of work`,
  );

  // 6. The task is published, and its hash changed.
  const after = await call('GET', '/api/v1/dispatch/debug/snapshot', dispatcher);
  const hashAfter = after.body.inputHash as string;
  const planningAsOf = after.body.planningAsOf as number;
  check(
    hashAfter !== hashBefore,
    'task republished on a real trigger',
    `hash ${hashAfter.slice(0, 12)}`,
  );

  const document = JSON.parse(after.body.payload as string) as {
    requests: Array<{ request_id: string }>;
    engineers: Array<{ engineer_id: string }>;
    policy: { policy_id: string };
  };
  check(
    document.requests.some((item) => item.request_id === request.id) &&
      document.engineers.some((item) => item.engineer_id === engineer.id),
    'published task carries the work and the engineer',
    `${document.requests.length} requests, ${document.engineers.length} engineers, policy ${document.policy.policy_id}`,
  );

  // 7. Reading twice must not republish.
  const again = await call('GET', '/api/v1/dispatch/debug/snapshot', dispatcher);
  check(
    (again.body.inputHash as string) === hashAfter &&
      (again.body.planningAsOf as number) === planningAsOf,
    'a read publishes nothing',
    'planning_as_of unchanged',
  );

  // 8. A Router result, shaped by the contract, becomes the working plan.
  const resultId = `smoke-${randomUUID().slice(0, 8)}`;
  const plan = {
    is_usable: true,
    metric_scope: 'snapshot_remaining',
    routes: [
      {
        engineer_id: engineer.id,
        start_location: { lat: 55.7155, lon: 37.7789 },
        start_at: now + 1800,
        finish_at: now + 1800 + 5400,
        stops: [
          {
            stop_id: 'smoke-stop-1',
            sequence: 0,
            kind: 'job',
            request_id: request.id,
            location: { lat: 55.7231, lon: 37.7328 },
            arrival_at: now + 1800,
            start_at: now + 1800,
            end_at: now + 1800 + 5400,
          },
        ],
        legs: [],
        lunch: { status: 'disabled', stop_id: null, reasons: [] },
        metrics: {
          distance_km: 4.8,
          travel_time_sec: 900,
          work_time_sec: 5400,
          waiting_time_sec: 0,
          lunch_time_sec: 0,
          assigned_count: 1,
        },
        reasons: [
          {
            code: 'CONSTRAINTS_SATISFIED',
            text: 'Навык, транспорт и окно соблюдены',
            basis: 'constraint_check',
            facts: {},
          },
        ],
      },
    ],
    assignments: [
      {
        request_id: request.id,
        status: 'assigned',
        engineer_id: engineer.id,
        stop_id: 'smoke-stop-1',
        reasons: [
          {
            code: 'CONSTRAINTS_SATISFIED',
            text: 'Ближайший подходящий инженер',
            basis: 'constraint_check',
            facts: {},
          },
        ],
      },
    ],
    summary: {
      requests_total: 1,
      assigned_count: 1,
      unassigned_count: 0,
      urgent_total: 1,
      urgent_assigned_count: 1,
      engineers_used: 1,
      distance_km: 4.8,
      travel_time_sec: 900,
      work_time_sec: 5400,
      waiting_time_sec: 0,
      lunch_time_sec: 0,
    },
    alerts: [],
  };

  const result = {
    schema_version: '1.0',
    status: 'ready',
    result_id: resultId,
    input_hash: hashAfter,
    planning_as_of: planningAsOf,
    computed_at: planningAsOf + 2,
    router_context_version: 'smoke-ctx-1',
    main: plan,
    baseline: plan,
    errors: [],
  };

  const accepted = await call('POST', '/api/v1/dispatch/debug/router-result', dispatcher, {
    operationId: randomUUID(),
    result,
    activeContextVersion: 'smoke-ctx-1',
  });
  const acceptance = accepted.body as { accepted: boolean; planRevision?: number; detail?: string };
  check(
    acceptance.accepted === true,
    'valid result becomes the working plan',
    `revision ${acceptance.planRevision ?? '?'}${acceptance.detail ? ` (${acceptance.detail})` : ''}`,
  );

  // 9. The same result again changes nothing.
  const repeated = await call('POST', '/api/v1/dispatch/debug/router-result', dispatcher, {
    operationId: randomUUID(),
    result,
    activeContextVersion: 'smoke-ctx-1',
  });
  const repeat = repeated.body as { accepted: boolean; reason?: string };
  check(
    repeat.accepted === false && repeat.reason === 'ALREADY_APPLIED',
    'a repeated result is not applied twice',
    `reason ${repeat.reason}`,
  );

  // 10. A stale result is refused with its own distinguishable code.
  const stale = await call('POST', '/api/v1/dispatch/debug/router-result', dispatcher, {
    operationId: randomUUID(),
    result: { ...result, result_id: `${resultId}-stale`, input_hash: 'an-older-task' },
    activeContextVersion: 'smoke-ctx-1',
  });
  const staleBody = stale.body as { accepted: boolean; reason?: string };
  check(
    staleBody.accepted === false && staleBody.reason === 'SNAPSHOT_STALE',
    'a stale result is refused distinguishably',
    `reason ${staleBody.reason}`,
  );

  // 11. Each contour sees what it should.
  const dispatcherPlan = await call('GET', '/api/v1/dispatch/plan', dispatcher);
  const planBody = dispatcherPlan.body as {
    mode: string;
    plan: { revision: number; planAsOf: number; origin: string };
  };
  check(
    planBody.mode === 'auto' && planBody.plan.origin === 'auto',
    'dispatcher sees the applied plan and the mode',
    `revision ${planBody.plan.revision}, plan as of ${planBody.plan.planAsOf}`,
  );

  const intents = await call('GET', '/api/v1/dispatch/data/state', dispatcher);
  check(intents.status === 200, 'data state readable', `initialized=${intents.body.initialized}`);

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
