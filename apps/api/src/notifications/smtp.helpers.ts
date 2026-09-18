import { classifyTransportError } from './smtp.transport';

export { classifyTransportError };

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Login codes must not remain in the stored payload after a decisive submit.
 */
export function redactPayload(payload: Record<string, unknown>): Record<string, unknown> {
  if (!('code' in payload)) {
    return payload;
  }
  const { code: _code, ...rest } = payload;
  return { ...rest, code: '[redacted]' };
}
