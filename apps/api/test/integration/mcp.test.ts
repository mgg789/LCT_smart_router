import '../support/env';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { AllExceptionsFilter } from '../../src/common/errors';
import { BigIntGuardInterceptor } from '../../src/common/serialization';
import type { PrismaClient } from '../../src/generated/prisma/client';
import { createTestClient, databaseUrl } from '../support/database';

// A fixed loopback port, sequential test runs (--test-concurrency=1).
const BASE = 'http://127.0.0.1:4101';
const MCP_PATH = '/api/v1/mcp';
const PIN = 'integration-mcp-pin-1234';

interface RpcError {
  error?: { code: number; message: string };
}

/**
 * Acceptance for the dashboard MCP server, against the real application and database:
 * the pin is a stored master key, the switch lives in `app_state`, and the transport is
 * the same JSON-RPC endpoint an external agent talks to.
 */
describe('dashboard mcp server', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let dispatcherToken: string;

  const target = (path: string): string => new URL(path, BASE).toString();

  const rpc = async (body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
    fetch(target(MCP_PATH), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  const dispatch = async (path: string, method: string, body?: unknown): Promise<Response> =>
    fetch(target(path), {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${dispatcherToken}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const callTool = async (
    name: string,
    args: Record<string, unknown> = {},
    headers: Record<string, string>,
  ): Promise<
    {
      result?: { content?: Array<{ text?: string; type?: string }>; structuredContent?: unknown };
    } & RpcError
  > => {
    const response = await rpc(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
      headers,
    );
    return (await response.json()) as never;
  };

  const pinHeader = (): Record<string, string> => ({ 'x-mcp-pin': PIN });
  const bearer = (): Record<string, string> => ({ authorization: `Bearer ${PIN}` });

  before(async () => {
    process.env.NODE_ENV = 'test';
    process.env.AUTH_DEV_EXPOSE_CODES = 'true';
    databaseUrl();
    prisma = createTestClient();
    await prisma.$connect();

    app = await NestFactory.create(AppModule, { logger: false });
    app.setGlobalPrefix('api/v1', {
      exclude: ['health/live', 'health/ready', 'health/services'],
    });
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new BigIntGuardInterceptor(true));
    await app.listen(4101, '127.0.0.1');

    const login = await fetch(target('/api/v1/auth/dispatcher/password'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: process.env.DISPATCHER_EMAIL,
        password: process.env.DISPATCHER_PASSWORD,
      }),
    });
    dispatcherToken = ((await login.json()) as { token: string }).token;
  });

  after(async () => {
    await prisma.appState.deleteMany({ where: { key: 'dispatcher.mcp' } });
    await prisma.apiToken.deleteMany({ where: { name: 'MCP dashboard pin' } });
    await prisma.$disconnect();
    await app?.close();
  });

  it('starts disabled and refuses the transport without any credential', async () => {
    const view = (await (await dispatch('/api/v1/dispatch/mcp', 'GET')).json()) as {
      enabled: boolean;
      pinSet: boolean;
    };
    assert.equal(view.enabled, false);
    assert.equal(view.pinSet, false);

    const anonymous = await rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18' },
    });
    assert.equal(anonymous.status, 401);
  });

  it('refuses to switch on without a pin', async () => {
    const response = await dispatch('/api/v1/dispatch/mcp', 'PUT', {
      operationId: crypto.randomUUID(),
      enabled: true,
    });
    assert.equal(response.status, 422);
    assert.equal(
      ((await response.json()) as { error: { code: string } }).error.code,
      'VALIDATION_FAILED',
    );
  });

  it('activates with a pin and serves the handshake over both credential styles', async () => {
    const saved = await dispatch('/api/v1/dispatch/mcp', 'PUT', {
      operationId: crypto.randomUUID(),
      enabled: true,
      pin: PIN,
    });
    assert.equal(saved.status, 200);
    const view = (await saved.json()) as { enabled: boolean; pinSet: boolean; pinLast4: string };
    assert.equal(view.enabled, true);
    assert.equal(view.pinSet, true);
    assert.equal(view.pinLast4, PIN.slice(-4));

    for (const headers of [pinHeader(), bearer()]) {
      const response = await rpc(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-06-18' },
        },
        headers,
      );
      assert.equal(response.status, 200);
      const body = (await response.json()) as {
        result: { protocolVersion: string; serverInfo: { name: string } };
      };
      assert.equal(body.result.protocolVersion, '2025-06-18');
      assert.equal(body.result.serverInfo.name, 'lct-smart-router');
    }
  });

  it('lists the tool catalogue over the transport', async () => {
    const response = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, pinHeader());
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      result: { tools: Array<{ name: string; inputSchema: { type: string } }> };
    };
    const names = body.result.tools.map((tool) => tool.name);
    for (const expected of [
      'get_dispatcher_context',
      'get_situation',
      'get_plan_explanations',
      'list_requests',
      'list_alerts',
      'resolve_alert',
      'ai_resolve_alert',
      'list_engineers',
      'select_policy',
      'update_dispatcher_settings',
    ]) {
      assert.ok(names.includes(expected), `missing tool ${expected}`);
    }
    for (const tool of body.result.tools) {
      assert.equal(tool.inputSchema.type, 'object');
    }
  });

  it('answers a read tool with structured dashboard data', async () => {
    const reply = await callTool('get_policies', {}, pinHeader());
    const payload = reply.result?.structuredContent as {
      policies: Array<{ policyId: string }>;
      active: { policyId: string };
    };
    assert.ok(Array.isArray(payload.policies));
    assert.ok(payload.policies.some((policy) => policy.policyId === 'compact'));
    assert.equal(reply.result?.content?.[0]?.type, 'text');
  });

  it('marks the dashboard indicator active right after a tool call', async () => {
    const view = (await (await dispatch('/api/v1/dispatch/mcp', 'GET')).json()) as {
      activeNow: boolean;
      lastToolName: string | null;
    };
    assert.equal(view.activeNow, true);
    assert.equal(view.lastToolName, 'get_policies');
  });

  it('refuses an unknown tool and bad arguments as tool-level results', async () => {
    const unknown = await callTool('no_such_tool', {}, pinHeader());
    assert.equal((unknown as { result?: { isError?: boolean } }).result?.isError, true);

    const invalid = await callTool('get_request', {}, pinHeader());
    assert.equal((invalid as { result?: { isError?: boolean } }).result?.isError, true);
  });

  it('answers 405 on GET and DELETE: no streams, no session', async () => {
    assert.equal((await fetch(target(MCP_PATH), { headers: pinHeader() })).status, 405);
    assert.equal(
      (await fetch(target(MCP_PATH), { method: 'DELETE', headers: pinHeader() })).status,
      405,
    );
  });

  it('stops promising a pin whose key row disappeared, as a data reset deletes every key', async () => {
    await prisma.apiToken.deleteMany({ where: { name: 'MCP dashboard pin' } });

    const view = (await (await dispatch('/api/v1/dispatch/mcp', 'GET')).json()) as {
      enabled: boolean;
      pinSet: boolean;
    };
    assert.equal(view.enabled, false);
    assert.equal(view.pinSet, false);
    assert.equal(
      (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, pinHeader())).status,
      401,
    );

    // Recovery needs no server-side switch: saving a pin arms the server again.
    const saved = await dispatch('/api/v1/dispatch/mcp', 'PUT', {
      operationId: crypto.randomUUID(),
      enabled: true,
      pin: PIN,
    });
    assert.equal(saved.status, 200);
    assert.equal(((await saved.json()) as { pinSet: boolean }).pinSet, true);
  });

  it('stops accepting the pin everywhere after the server is switched off', async () => {
    const off = await dispatch('/api/v1/dispatch/mcp', 'PUT', {
      operationId: crypto.randomUUID(),
      enabled: false,
    });
    assert.equal(off.status, 200);
    const view = (await off.json()) as { enabled: boolean; pinSet: boolean };

    assert.equal(view.enabled, false);
    assert.equal(view.pinSet, false);

    assert.equal(
      (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, pinHeader())).status,
      401,
    );
    // The pin was a real master key: revoking it closes the bearer path too.
    const bearerResponse = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, bearer());
    assert.equal(bearerResponse.status, 401);
  });
});
