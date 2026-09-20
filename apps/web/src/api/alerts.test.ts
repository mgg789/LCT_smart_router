import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeDispatchShift, markDispatchNoticeSeen, resolveDispatchAlert } from './client';

afterEach(() => vi.unstubAllGlobals());

describe('dispatcher decision requests', () => {
  it('preserves operation identity across retries and sends exact decision parameters', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetcher);
    const input = { operationId: 'same-operation', action: 'extend', minutes: 15 };
    await resolveDispatchAlert('session', 'alert/id', input);
    await resolveDispatchAlert('session', 'alert/id', input);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      '/api/v1/dispatch/alerts/alert%2Fid/resolve',
      expect.objectContaining({ method: 'POST', body: JSON.stringify(input) }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      '/api/v1/dispatch/alerts/alert%2Fid/resolve',
      expect.objectContaining({ body: JSON.stringify(input) }),
    );
  });
  it('does not resolve an alert when a notice is marked read', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    await markDispatchNoticeSeen('session', 'notice');
    expect(fetcher).toHaveBeenCalledWith(
      '/api/v1/dispatch/alerts/notice/seen',
      expect.objectContaining({ method: 'POST' }),
    );
  });
  it('preserves server refusal when shift closure is blocked', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(JSON.stringify({ message: 'Unresolved alerts' }), { status: 409 }),
      ),
    );
    await expect(closeDispatchShift('session', '2026-09-20', 'op')).rejects.toMatchObject({
      status: 409,
    });
  });
});
