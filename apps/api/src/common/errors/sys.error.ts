import { type ErrorCode, httpStatusForErrorCode } from './error-codes';

export interface SysErrorOptions {
  /** Machine-readable facts the caller needs to recover, e.g. the current version. */
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

/**
 * Refusal raised by the system layer.
 *
 * Domain and service code throws this instead of a Nest `HttpException` so that business
 * rules stay unaware of HTTP; the exception filter is the single place that maps a code
 * to a status.
 */
export class SysError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: ErrorCode, message: string, options: SysErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SysError';
    this.code = code;
    this.status = httpStatusForErrorCode(code);
    this.details = options.details ?? {};
  }

  static notFound(what: string, details?: Record<string, unknown>): SysError {
    return new SysError('NOT_FOUND', `${what} not found`, { details });
  }

  static validationFailed(message: string, details?: Record<string, unknown>): SysError {
    return new SysError('VALIDATION_FAILED', message, { details });
  }

  static forbidden(message: string, details?: Record<string, unknown>): SysError {
    return new SysError('FORBIDDEN', message, { details });
  }

  static versionConflict(what: string, expectedVersion: number, currentVersion: number): SysError {
    return new SysError(
      'VERSION_CONFLICT',
      `${what} changed since it was read; refresh and confirm again`,
      { details: { expectedVersion, currentVersion } },
    );
  }

  static notConfigured(service: string): SysError {
    return new SysError(
      'SERVICE_NOT_CONFIGURED',
      `${service} is not configured in this deployment`,
      {
        details: { service },
      },
    );
  }
}
