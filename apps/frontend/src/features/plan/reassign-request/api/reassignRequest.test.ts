import { afterEach, expect, it, vi } from 'vitest';
import { useSessionStore } from '@/entities/session';
import { jsonResponse, stubApi } from '@/test/stubApi';
import { reassignRequest } from './reassignRequest';

afterEach(() => {
  useSessionStore.getState().signOut();
  vi.unstubAllGlobals();
});

it('guards a manual reassignment with the plan and mode versions', async () => {
  useSessionStore.getState().signIn({
    token: 'tok',
    role: 'dispatcher',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    email: 'dispatcher@local.test',
  });
  const fetchMock = stubApi({ '/dispatch/plan/reassign': () => jsonResponse({ applied: true }) });

  await reassignRequest({
    requestId: 'request-1',
    engineerId: 'engineer-2',
    expectedModeVersion: 5,
    expectedPlanRevision: 3,
  });

  const call = fetchMock.mock.calls.find(([url]) =>
    String(url).endsWith('/dispatch/plan/reassign'),
  );
  expect(JSON.parse(String(call?.[1]?.body ?? '{}'))).toMatchObject({
    requestId: 'request-1',
    engineerId: 'engineer-2',
    expectedModeVersion: 5,
    expectedPlanRevision: 3,
  });
});
