import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse, stubApi } from '@/test/stubApi';
import { useSessionStore } from '../model/session.store';
import { authorizedRequest } from './authorizedRequest';

const liveSession = {
  token: 'tok-1',
  role: 'dispatcher' as const,
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
  email: 'dispatcher@navix.test',
};

beforeEach(() => {
  useSessionStore.getState().signIn(liveSession);
});

afterEach(() => {
  useSessionStore.getState().signOut();
  vi.unstubAllGlobals();
});

describe('authorizedRequest', () => {
  it('sends the session token', async () => {
    const fetchMock = stubApi({ '/dispatch/policies': () => jsonResponse({ policies: [] }) });

    await authorizedRequest('/dispatch/policies');

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok-1');
  });

  it('ends the session when the API rejects the token', async () => {
    stubApi({
      '/dispatch/plan': () =>
        jsonResponse({ error: { code: 'UNAUTHENTICATED', message: 'expired' } }, 401),
    });

    await expect(authorizedRequest('/dispatch/plan')).rejects.toThrow();

    expect(useSessionStore.getState().session).toBeNull();
  });

  it('keeps the session on failures that are not about the token', async () => {
    stubApi({
      '/dispatch/plan': () =>
        jsonResponse({ error: { code: 'SERVICE_NOT_CONFIGURED', message: 'router off' } }, 503),
    });

    await expect(authorizedRequest('/dispatch/plan')).rejects.toThrow();

    expect(useSessionStore.getState().session).toEqual(liveSession);
  });
});
