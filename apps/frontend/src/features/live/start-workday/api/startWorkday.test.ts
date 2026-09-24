import { afterEach, expect, it, vi } from 'vitest';
import { useSessionStore } from '@/entities/session';
import { jsonResponse, stubApi } from '@/test/stubApi';
import { startWorkday } from './startWorkday';

afterEach(() => {
  useSessionStore.getState().signOut();
  vi.unstubAllGlobals();
});

it('starts the prepared day with an operation ID and reads the returned state', async () => {
  useSessionStore.getState().signIn({
    token: 'tok',
    role: 'dispatcher',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    email: 'dispatcher@local.test',
  });
  const fetchMock = stubApi({
    '/dispatch/live/start': () =>
      jsonResponse({ workday: { status: 'running', workDate: '2026-09-23' } }),
  });

  const result = await startWorkday();
  expect(result.workday.status).toBe('running');
  const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/dispatch/live/start'));
  expect(call?.[1]?.method).toBe('POST');
  expect(JSON.parse(String(call?.[1]?.body ?? '{}')).operationId).toMatch(/^[0-9a-f-]{36}$/);
});
