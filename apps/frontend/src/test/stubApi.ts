import { vi } from 'vitest';

export type StubHandler = () => Response;

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Replaces `fetch` with a router keyed by the tail of the request path, so a test
 * answers exactly the endpoints its screen calls and any other call fails loudly.
 */
export function stubApi(handlers: Record<string, StubHandler>) {
  const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const handler = Object.entries(handlers).find(([path]) => url.endsWith(path));
    if (!handler) throw new Error(`Unexpected call to ${url}`);
    return Promise.resolve(handler[1]());
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
