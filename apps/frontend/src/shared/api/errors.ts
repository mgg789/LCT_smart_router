/**
 * The System Layer answers every failure with one envelope (docs/frontend-api.md §3):
 * `{ error: { code, message, details, requestId } }`. The **code** is the contract —
 * the HTTP status is a consequence of it — so callers branch on `code`, never on the
 * number.
 */
export interface ApiErrorEnvelope {
  code: string;
  message: string;
  details?: unknown;
  requestId?: string;
}

/** Code used when the request never reached the API (offline, DNS, aborted socket). */
export const NETWORK_ERROR_CODE = 'NETWORK_ERROR';

/** Code used when the API answered with something that is not the error envelope. */
export const MALFORMED_RESPONSE_CODE = 'MALFORMED_RESPONSE';

/**
 * Code used when a gateway answered for the API instead of the API itself —
 * 502/503/504 without the envelope. In dev that is the Vite proxy reporting that
 * the System Layer is not listening; in Docker it is nginx saying the same.
 */
export const UPSTREAM_UNAVAILABLE_CODE = 'UPSTREAM_UNAVAILABLE';

const GATEWAY_STATUSES = new Set([502, 503, 504]);

/** Picks the code for a failure that carried no error envelope. */
export function codeForEnvelopeless(status: number): string {
  return GATEWAY_STATUSES.has(status) ? UPSTREAM_UNAVAILABLE_CODE : MALFORMED_RESPONSE_CODE;
}

export class ApiError extends Error {
  readonly code: string;
  /** HTTP status, or 0 when the request never got an answer. */
  readonly status: number;
  readonly details?: unknown;
  readonly requestId?: string;

  constructor(status: number, envelope: ApiErrorEnvelope) {
    super(envelope.message);
    this.name = 'ApiError';
    this.code = envelope.code;
    this.status = status;
    this.details = envelope.details;
    this.requestId = envelope.requestId;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/** Narrows an unknown body to the error envelope without trusting its shape. */
export function parseErrorEnvelope(body: unknown): ApiErrorEnvelope | null {
  if (typeof body !== 'object' || body === null || !('error' in body)) return null;
  const candidate = (body as { error: unknown }).error;
  if (typeof candidate !== 'object' || candidate === null) return null;
  const { code, message, details, requestId } = candidate as Record<string, unknown>;
  if (typeof code !== 'string') return null;
  return {
    code,
    message: typeof message === 'string' ? message : code,
    details,
    requestId: typeof requestId === 'string' ? requestId : undefined,
  };
}
