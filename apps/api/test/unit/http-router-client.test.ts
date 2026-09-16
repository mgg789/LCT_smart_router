import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { HttpRouterClient } from '../../src/routing/router-gateway/http-router-client';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('HttpRouterClient', () => {
  it('reads and validates Router result and active context', async () => {
    const calls: string[] = [];
    globalThis.fetch = async (input) => {
      calls.push(String(input));
      if (String(input).endsWith('/v1/context')) {
        return Response.json({ router_context_version: 'ctx-7', status: 'ready' });
      }
      return Response.json({
        schema_version: '1.0',
        status: 'pending',
        result_id: null,
        input_publication_id: null,
        input_hash: null,
        planning_as_of: null,
        computed_at: null,
        router_context_version: 'ctx-7',
        main: null,
        baseline: null,
        errors: [],
      });
    };

    const client = new HttpRouterClient({
      baseUrl: 'http://router:8100/',
      requestTimeoutMs: 1_000,
    });

    assert.equal((await client.getResult()).status, 'pending');
    assert.equal(await client.getActiveContextVersion(), 'ctx-7');
    assert.deepEqual(calls, ['http://router:8100/v1/result', 'http://router:8100/v1/context']);
    assert.equal(client.isConfigured(), true);
  });

  it('rejects malformed responses before they reach acceptance', async () => {
    globalThis.fetch = async () => Response.json({ status: 'ready' });
    const client = new HttpRouterClient({
      baseUrl: 'http://router:8100',
      requestTimeoutMs: 1_000,
    });

    await assert.rejects(() => client.getResult(), /response is invalid/);
  });

  it('reports non-success status and request timeout', async (context) => {
    await context.test('non-success response', async () => {
      globalThis.fetch = async () => new Response('broken', { status: 503 });
      const client = new HttpRouterClient({
        baseUrl: 'http://router:8100',
        requestTimeoutMs: 1_000,
      });
      await assert.rejects(() => client.getResult(), /HTTP 503/);
    });

    await context.test('timeout', async () => {
      globalThis.fetch = async (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        });
      const client = new HttpRouterClient({
        baseUrl: 'http://router:8100',
        requestTimeoutMs: 10,
      });
      await assert.rejects(() => client.getResult(), /timed out after 10 ms/);
    });
  });
});
