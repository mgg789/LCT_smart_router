#!/usr/bin/env node
/**
 * External API reference client for the LCT Smart Router.
 *
 * Runs the key integration scenario with one API token and no UI:
 *   1. describe the actor behind the token (`GET /auth/session`),
 *   2. read the day plan for the dispatcher contour (`GET /dispatch/plan`),
 *   3. create a customer request (`POST /dispatch/requests`).
 *
 * Usage:
 *   node external-api-client.mjs <base-url> <token> [master|client|eng|client_eng]
 *
 * The default category example is `master` because only it reaches the dispatcher
 * contour used in steps 2-3; with a `client`/`eng`/`client_eng` key the same script
 * still runs step 1 and shows exactly which contour denies the key (`403 FORBIDDEN`
 * with `requiredRoles`), which is the intended role isolation, not a bug.
 *
 * No dependencies: Node 18+ global fetch only. The token travels in the Authorization
 * header, never in a URL (`context/41` section 12), and is never printed back.
 */

const [baseUrl = 'http://127.0.0.1:8000', token = '', category = 'master'] = process.argv.slice(2);

if (!token) {
  console.error('Usage: node external-api-client.mjs <base-url> <token> [category]');
  console.error('Create a token in the Dashboard (Settings -> API tokens) or by a');
  console.error('dispatcher session: POST /api/v1/auth/tokens {"name","category","expiresAt?"}');
  process.exit(2);
}

const api = async (path, init = {}) => {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/v1${path}`, {
    ...init,
    headers: {
      accept: 'application/json',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      authorization: `Bearer ${token}`,
    },
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, ok: response.ok, body };
};

const describeActor = await api('/auth/session');
console.log('1) auth/session:', describeActor.status, JSON.stringify(describeActor.body));
if (!describeActor.ok) {
  // 401 UNAUTHENTICATED: unknown, revoked or expired key.
  process.exit(1);
}

const plan = await api('/dispatch/plan');
console.log('2) dispatch/plan:', plan.status);
if (plan.ok) {
  const { mode, plan: dayPlan } = plan.body;
  console.log(
    `   mode=${mode}, revision=${dayPlan?.revision ?? 'none'}, routes=${dayPlan?.routes.length ?? 0}`,
  );
} else {
  console.log('   refused:', JSON.stringify(plan.body));
}

const now = Math.floor(Date.now() / 1000);
const request = await api('/dispatch/requests', {
  method: 'POST',
  body: JSON.stringify({
    operationId: crypto.randomUUID(),
    clientEmail: 'external-client@example.test',
    contactName: 'Внешний клиент',
    addressText: 'Москва, Пресненская набережная, 12',
    workType: 'connection_request',
    windowStartAt: now + 3600,
    windowEndAt: now + 4 * 3600,
    urgent: false,
  }),
});
console.log('3) dispatch/requests:', request.status);
if (request.ok) {
  console.log(`   created request ${request.body.request.id} (${request.body.request.lifecycle})`);
} else {
  console.log('   refused:', JSON.stringify(request.body));
}

console.log(`\nToken category: ${category}. A 403 FORBIDDEN with requiredRoles above means`);
console.log('the key reached a contour its category does not carry - check the table in docs/api.md.');
