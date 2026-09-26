import { SysError } from '../../common/errors';

/**
 * The MCP protocol core: JSON-RPC 2.0 framing over a single stateless HTTP endpoint
 * ("streamable HTTP" transport, no server-initiated streams).
 *
 * The protocol layer knows nothing about routing: tool listing and execution are delegated
 * to [[McpProtocolHost]]. Every reply is JSON (never an SSE stream), which every
 * HTTP-transport client accepts.
 */

/** Versions this server speaks; the newest one is offered when a client asks for unknown. */
export const MCP_SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const MCP_LATEST_PROTOCOL_VERSION = MCP_SUPPORTED_PROTOCOL_VERSIONS[0];

export const MCP_SERVER_INFO = {
  name: 'lct-smart-router',
  title: 'LCT Smart Router — дашборд диспетчера',
  version: '1.0.0',
} as const;

/** JSON Schema object every tool must declare for `tools/list`. */
export interface McpToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Record<string, unknown>;
    readonly required?: readonly string[];
    readonly additionalProperties?: false;
  };
}

/** What the protocol core needs from the feature side. */
export interface McpProtocolHost {
  listTools(): readonly McpToolDefinition[];
  callTool(name: string, args: unknown): Promise<unknown>;
}

export type JsonRpcId = string | number | null;

export interface JsonRpcSuccess {
  readonly jsonrpc: '2.0';
  readonly id: JsonRpcId;
  readonly result: unknown;
}

export interface JsonRpcFailure {
  readonly jsonrpc: '2.0';
  readonly id: JsonRpcId;
  readonly error: { readonly code: number; readonly message: string; readonly data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

export type ProtocolOutcome =
  | { readonly kind: 'reply'; readonly status: number; readonly body: JsonRpcResponse }
  /** A notification: per JSON-RPC the caller gets no body back, only an acceptance. */
  | { readonly kind: 'accepted' };

export const JSON_RPC_ERRORS = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

function success(id: JsonRpcId, result: unknown): ProtocolOutcome {
  return { kind: 'reply', status: 200, body: { jsonrpc: '2.0', id, result } };
}

function failure(id: JsonRpcId, code: number, message: string, data?: unknown): ProtocolOutcome {
  return {
    kind: 'reply',
    status: 200,
    body: { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } },
  };
}

function notificationAccepted(): ProtocolOutcome {
  return { kind: 'accepted' };
}

function isMessage(value: unknown): value is { method: unknown; id?: unknown } {
  return typeof value === 'object' && value !== null && 'method' in value;
}

function idOf(message: { id?: unknown }): JsonRpcId | null {
  // A JSON-RPC message without `id` is a notification; `null` ids are requests that get an
  // error reply so the caller learns their request was malformed.
  if ('id' in message && message.id !== undefined) {
    if (typeof message.id === 'string' || typeof message.id === 'number') return message.id;
    if (message.id === null) return null;
  }
  return null;
}

function toolResultPayload(data: unknown): unknown {
  const text = JSON.stringify(data, null, 2);
  return {
    content: [{ type: 'text' as const, text }],
    // Structured content duplicates the same JSON for clients that read it directly.
    ...(data !== null && typeof data === 'object' ? { structuredContent: data } : {}),
  };
}

/** Handles one JSON-RPC message against the tool host. */
export async function handleMcpMessage(
  message: unknown,
  host: McpProtocolHost,
): Promise<ProtocolOutcome> {
  if (!isMessage(message) || typeof message.method !== 'string') {
    return failure(null, JSON_RPC_ERRORS.invalidRequest, 'Not a JSON-RPC 2.0 message');
  }
  const id = idOf(message);
  const isNotification = id === null;
  const method = message.method;
  const params = (message as { params?: unknown }).params;

  try {
    if (method === 'initialize') {
      if (isNotification) return notificationAccepted();
      const requested =
        typeof (params as { protocolVersion?: unknown })?.protocolVersion === 'string'
          ? (params as { protocolVersion: string }).protocolVersion
          : null;
      const protocolVersion =
        requested !== null &&
        (MCP_SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
          ? requested
          : MCP_LATEST_PROTOCOL_VERSION;
      return success(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: MCP_SERVER_INFO,
        instructions:
          'Ты подключён к дашборду диспетчера LCT Smart Router как его агент. ' +
          'Начни с get_dispatcher_context и get_situation, принципы планирования — в ' +
          'get_routing_principles. Все изменения делаются только инструментами: каждый вызов ' +
          'идемпотентен и попадает в журнал операций.',
      });
    }

    if (method === 'ping') {
      return isNotification ? notificationAccepted() : success(id, {});
    }

    if (method === 'tools/list') {
      return isNotification ? notificationAccepted() : success(id, { tools: host.listTools() });
    }

    if (method === 'tools/call') {
      if (isNotification) return notificationAccepted();
      const name =
        typeof (params as { name?: unknown })?.name === 'string'
          ? (params as { name: string }).name
          : null;
      if (name === null) {
        return failure(id, JSON_RPC_ERRORS.invalidParams, 'tools/call requires a tool name');
      }
      const args = (params as { arguments?: unknown }).arguments;
      try {
        const data = await host.callTool(name, args ?? {});
        return success(id, toolResultPayload(data));
      } catch (error) {
        // A tool that refused the job is a tool-level result, not a protocol failure: the
        // agent reads the reason and decides what to do next.
        const messageText =
          error instanceof SysError
            ? error.message
            : error instanceof Error
              ? error.message
              : 'Инструмент не смог выполнить вызов';
        const data = error instanceof SysError ? error.details : undefined;
        return success(id, {
          content: [{ type: 'text', text: messageText }],
          isError: true,
          ...(data !== undefined && Object.keys(data).length > 0 ? { data } : {}),
        });
      }
    }

    // Unknown notifications are ignored by design; unknown requests must be answered.
    if (isNotification) return notificationAccepted();
    return failure(id, JSON_RPC_ERRORS.methodNotFound, `Unknown method: ${method}`);
  } catch (error) {
    if (isNotification) return notificationAccepted();
    return failure(
      id,
      JSON_RPC_ERRORS.internalError,
      error instanceof Error ? error.message : 'Internal error',
    );
  }
}

/**
 * Handles one HTTP body: a single message or a JSON-RPC batch array. Returns either the
 * batch acceptance (notifications only) or every reply collected in order.
 */
export async function handleMcpPayload(
  payload: unknown,
  host: McpProtocolHost,
): Promise<
  | { readonly kind: 'accepted' }
  | { readonly kind: 'replies'; readonly status: number; readonly body: unknown }
> {
  if (Array.isArray(payload)) {
    const replies: JsonRpcResponse[] = [];
    for (const message of payload) {
      const outcome = await handleMcpMessage(message, host);
      if (outcome.kind === 'reply') replies.push(outcome.body);
    }
    if (replies.length === 0) return { kind: 'accepted' };
    return { kind: 'replies', status: 200, body: replies };
  }
  const outcome = await handleMcpMessage(payload, host);
  if (outcome.kind === 'accepted') return { kind: 'accepted' };
  return { kind: 'replies', status: outcome.status, body: outcome.body };
}

/** Wraps a body that never parsed as JSON, so the caller answers with one parse error. */
export function parseErrorReply(): { readonly status: number; readonly body: JsonRpcResponse } {
  return {
    status: 400,
    body: {
      jsonrpc: '2.0',
      id: null,
      error: { code: JSON_RPC_ERRORS.parseError, message: 'Invalid JSON body' },
    },
  };
}
