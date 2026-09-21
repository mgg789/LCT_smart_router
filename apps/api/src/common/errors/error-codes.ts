import { HttpStatus } from '@nestjs/common';

/**
 * Catalogue of system error codes.
 *
 * The code, not the HTTP status, is the contract: several distinct refusals share 409,
 * and a caller must be able to tell "someone else edited this" from "the work already
 * started" without parsing prose. Every refusal the concept documents as a distinguishable
 * outcome gets its own code here rather than collapsing into a generic conflict.
 */
export const ERROR_CODES = {
  /** Request body or query failed schema validation. */
  VALIDATION_FAILED: HttpStatus.UNPROCESSABLE_ENTITY,

  /** No session or API token was presented, or it is no longer valid. */
  UNAUTHENTICATED: HttpStatus.UNAUTHORIZED,

  /** The actor is known but the action does not belong to its role or token category. */
  FORBIDDEN: HttpStatus.FORBIDDEN,

  /** The addressed object does not exist, or is not visible to this actor. */
  NOT_FOUND: HttpStatus.NOT_FOUND,

  /**
   * `expectedVersion` did not match the stored row: someone changed it after the actor
   * read it. The current version travels in `details` so the caller can refresh and retry
   * deliberately. Never resolved by overwriting (context/36 section 8).
   */
  VERSION_CONFLICT: HttpStatus.CONFLICT,

  /** Same `operationId` replayed with a different payload — a client bug, not a retry. */
  OPERATION_ID_REUSED: HttpStatus.CONFLICT,

  /**
   * The engineer already recorded a start for this work, so ordinary condition changes
   * and reassignment are closed regardless of the entry path (context/42 DF-05).
   */
  WORK_ALREADY_STARTED: HttpStatus.CONFLICT,

  /** Emergency manual mode is on: the Router to sys bus is disconnected. */
  MODE_MANUAL: HttpStatus.CONFLICT,

  /** Automatic mode is on: the working plan is owned by the accepted Router result. */
  MODE_AUTO: HttpStatus.CONFLICT,

  /** The result belongs to a snapshot that is no longer the published one. */
  SNAPSHOT_STALE: HttpStatus.CONFLICT,

  /**
   * A finished result that must not become the working plan: unusable main, a stale
   * router context, or a conflict with an explicit execution fact (context/33 section 7).
   */
  RESULT_NOT_APPLICABLE: HttpStatus.CONFLICT,

  /** A destructive action was requested without its explicit human confirmation. */
  CONFIRMATION_REQUIRED: HttpStatus.CONFLICT,

  /** A dispatcher tried to close a day while decision-required alerts remain open. */
  SHIFT_CLOSE_BLOCKED: HttpStatus.CONFLICT,

  /**
   * An optional integration (Router, AI, SMTP) is not wired in this deployment. Reported
   * honestly instead of being faked as success.
   */
  SERVICE_NOT_CONFIGURED: HttpStatus.SERVICE_UNAVAILABLE,

  /** Unexpected failure; details are logged, not returned. */
  INTERNAL_ERROR: HttpStatus.INTERNAL_SERVER_ERROR,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export function httpStatusForErrorCode(code: ErrorCode): number {
  return ERROR_CODES[code];
}

/**
 * Narrows a stored or received string back to a known code.
 *
 * Used when reading a refusal recorded earlier: an unrecognised value must not be passed
 * through as if the catalogue contained it.
 */
export function toErrorCode(value: string): ErrorCode {
  return value in ERROR_CODES ? (value as ErrorCode) : 'INTERNAL_ERROR';
}
