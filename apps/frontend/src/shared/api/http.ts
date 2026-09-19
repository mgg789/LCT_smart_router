import { API_BASE, API_PREFIX } from '../config/env';
import {
  ApiError,
  codeForEnvelopeless,
  MALFORMED_RESPONSE_CODE,
  NETWORK_ERROR_CODE,
  parseErrorEnvelope,
} from './errors';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface ApiRequestOptions {
  method?: HttpMethod;
  /** Serialised as JSON; omit for requests without a body. */
  body?: unknown;
  /** Bearer session token; omitted for the public auth routes. */
  token?: string | null;
  signal?: AbortSignal;
}

/**
 * Single entry point for `/api/v1/...` calls.
 *
 * Always throws {@link ApiError} on failure — including transport failures — so
 * callers have one error type to branch on. Times are left untouched: the API
 * speaks integer Unix seconds and conversion belongs to the render edge.
 */
export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const { method = 'GET', body, token, signal } = options;

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${API_PREFIX}${path}`, {
      method,
      headers,
      signal,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (cause) {
    throw new ApiError(0, {
      code: NETWORK_ERROR_CODE,
      message: cause instanceof Error ? cause.message : 'Request failed before reaching the API',
    });
  }

  if (response.status === 204) return undefined as T;

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const envelope = parseErrorEnvelope(payload);
    throw new ApiError(
      response.status,
      envelope ?? {
        code: codeForEnvelopeless(response.status),
        message: response.statusText || `HTTP ${response.status}`,
      },
    );
  }

  if (payload === null) {
    throw new ApiError(response.status, {
      code: MALFORMED_RESPONSE_CODE,
      message: 'API answered 2xx without a JSON body',
    });
  }

  return payload as T;
}
