import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  handleMcpMessage,
  handleMcpPayload,
  JSON_RPC_ERRORS,
  MCP_LATEST_PROTOCOL_VERSION,
  type McpProtocolHost,
  type McpToolDefinition,
} from '../../src/orchestrator/mcp/mcp-protocol';

/** A host with one echo tool, so the protocol layer is exercised without the app. */
function host(): McpProtocolHost & { calls: Array<{ name: string; args: unknown }> } {
  const definition: McpToolDefinition = {
    name: 'echo',
    title: 'Echo',
    description: 'Returns its arguments',
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    },
  };
  const calls: Array<{ name: string; args: unknown }> = [];
  return {
    calls,
    listTools: () => [definition],
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (name !== 'echo') {
        throw new Error(`Unknown tool: ${name}`);
      }
      return { echoed: args };
    },
  };
}

describe('mcp protocol', () => {
  it('negotiates a supported protocol version and describes the server', async () => {
    const reply = await handleMcpMessage(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
      host(),
    );
    assert.equal(reply.kind, 'reply');
    if (reply.kind !== 'reply' || !('result' in reply.body)) throw new Error('expected success');
    const result = reply.body.result as { protocolVersion: string; serverInfo: { name: string } };
    assert.equal(result.protocolVersion, '2025-03-26');
    assert.equal(result.serverInfo.name, 'lct-smart-router');
  });

  it('answers an unknown requested version with the newest supported one', async () => {
    const reply = await handleMcpMessage(
      { jsonrpc: '2.0', id: 'a', method: 'initialize', params: { protocolVersion: '1999-01-01' } },
      host(),
    );
    if (reply.kind !== 'reply' || !('result' in reply.body)) throw new Error('expected success');
    const result = reply.body.result as { protocolVersion: string };
    assert.equal(result.protocolVersion, MCP_LATEST_PROTOCOL_VERSION);
  });

  it('lists tools with JSON-Schema declarations', async () => {
    const reply = await handleMcpMessage(
      { jsonrpc: '2.0', id: 7, method: 'tools/list' },
      host(),
    );
    if (reply.kind !== 'reply' || !('result' in reply.body)) throw new Error('expected success');
    const result = reply.body.result as { tools: McpToolDefinition[] };
    assert.deepEqual(
      result.tools.map((tool) => tool.name),
      ['echo'],
    );
    assert.equal(result.tools[0]?.inputSchema.type, 'object');
  });

  it('wraps a tool result into text content plus structured content', async () => {
    const echo = host();
    const reply = await handleMcpMessage(
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { value: 'x' } } },
      echo,
    );
    if (reply.kind !== 'reply' || !('result' in reply.body)) throw new Error('expected success');
    const result = reply.body.result as {
      content: Array<{ type: string; text: string }>;
      structuredContent?: unknown;
    };
    assert.deepEqual(echo.calls, [{ name: 'echo', args: { value: 'x' } }]);
    assert.equal(result.content[0]?.type, 'text');
    assert.deepEqual(JSON.parse(result.content[0]?.text ?? ''), { echoed: { value: 'x' } });
    assert.deepEqual(result.structuredContent, { echoed: { value: 'x' } });
  });

  it('reports a refused tool as an isError result, not a protocol error', async () => {
    const reply = await handleMcpMessage(
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'missing', arguments: {} } },
      host(),
    );
    if (reply.kind !== 'reply' || !('result' in reply.body)) throw new Error('expected success');
    const result = reply.body.result as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? '', /Unknown tool/);
  });

  it('answers an unknown method with -32601', async () => {
    const reply = await handleMcpMessage({ jsonrpc: '2.0', id: 4, method: 'prompts/list' }, host());
    assert.equal(reply.kind, 'reply');
    if (reply.kind !== 'reply') throw new Error('expected reply');
    assert.ok('error' in reply.body, 'an unknown method must be a JSON-RPC failure');
    if ('error' in reply.body) {
      assert.equal(reply.body.error.code, JSON_RPC_ERRORS.methodNotFound);
    }
  });

  it('accepts notifications without a reply body, including the initialized handshake', async () => {
    const echo = host();
    const outcome = await handleMcpMessage(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      echo,
    );
    assert.equal(outcome.kind, 'accepted');
    assert.deepEqual(echo.calls, []);
  });

  it('collects replies for a batch and stays silent for a notifications-only batch', async () => {
    const echo = host();
    const batch = await handleMcpPayload(
      [
        { jsonrpc: '2.0', id: 1, method: 'ping' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      ],
      echo,
    );
    assert.equal(batch.kind, 'replies');
    if (batch.kind !== 'replies') throw new Error('expected replies');
    assert.equal(Array.isArray(batch.body), true);

    const notificationsOnly = await handleMcpPayload(
      [{ jsonrpc: '2.0', method: 'notifications/initialized' }],
      echo,
    );
    assert.equal(notificationsOnly.kind, 'accepted');
  });

  it('refuses a body that is not JSON-RPC at all', async () => {
    const reply = await handleMcpMessage({ hello: 'world' }, host());
    if (reply.kind !== 'reply') throw new Error('expected reply');
    const body = reply.body as { error?: { code: number } };
    assert.equal(body.error?.code, JSON_RPC_ERRORS.invalidRequest);
  });
});
