import type { ErrorCode } from './error-codes';

/** Single error envelope every failing endpoint returns. */
export interface ErrorResponseBody {
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
    readonly details: Readonly<Record<string, unknown>>;
    readonly requestId: string | null;
  };
}
