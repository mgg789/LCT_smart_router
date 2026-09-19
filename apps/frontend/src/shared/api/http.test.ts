import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  MALFORMED_RESPONSE_CODE,
  NETWORK_ERROR_CODE,
  UPSTREAM_UNAVAILABLE_CODE,
} from './errors';
import { apiRequest } from './http';

function mockFetch(response: Response | Error) {
  const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
    response instanceof Error ? Promise.reject(response) : Promise.resolve(response),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apiRequest', () => {
  it('prefixes the path and sends a JSON body', async () => {
    const fetchMock = mockFetch(jsonResponse({ ok: true }));

    await apiRequest('/auth/login-code', { method: 'POST', body: { email: 'a@b.test' } });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/v1/auth/login-code');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ email: 'a@b.test' }));
  });

  it('attaches the bearer token when given', async () => {
    const fetchMock = mockFetch(jsonResponse({ ok: true }));

    await apiRequest('/dispatch/plan', { token: 'tok-1' });

    const headers = (fetchMock.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok-1');
  });

  it('turns the error envelope into ApiError, keeping the code', async () => {
    mockFetch(
      jsonResponse(
        { error: { code: 'UNAUTHENTICATED', message: 'no token', requestId: 'req-9' } },
        401,
      ),
    );

    const error = await apiRequest('/dispatch/plan').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('UNAUTHENTICATED');
    expect((error as ApiError).status).toBe(401);
    expect((error as ApiError).requestId).toBe('req-9');
  });

  it('reports a transport failure as an ApiError instead of a raw rejection', async () => {
    mockFetch(new TypeError('Failed to fetch'));

    const error = await apiRequest('/dispatch/plan').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe(NETWORK_ERROR_CODE);
    expect((error as ApiError).status).toBe(0);
  });
});

describe('apiRequest without an error envelope', () => {
  it('names an unreachable API when a gateway answers 502', async () => {
    mockFetch(new Response('', { status: 502, statusText: 'Bad Gateway' }));

    const error = await apiRequest('/auth/login-code').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe(UPSTREAM_UNAVAILABLE_CODE);
  });

  it('keeps MALFORMED_RESPONSE for a non-gateway status without the envelope', async () => {
    mockFetch(new Response('nope', { status: 418, statusText: "I'm a teapot" }));

    const error = await apiRequest('/auth/login-code').catch((caught: unknown) => caught);

    expect((error as ApiError).code).toBe(MALFORMED_RESPONSE_CODE);
  });
});
