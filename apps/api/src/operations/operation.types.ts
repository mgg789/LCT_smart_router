import type { Actor } from '../auth';
import type { Tx } from '../persistence';

/**
 * One business operation, in the shape context/36 section 12 describes.
 *
 * This is the working logical form of an operation, not an HTTP body: a controller
 * assembles it from the validated request and the actor the guard established.
 */
export interface OperationRequest {
  /**
   * Stable id of one business intention, supplied by the caller.
   *
   * A retry after a lost response repeats the id and gets the first outcome back instead
   * of performing the work twice. The provider's own tool-call id is not a sufficient
   * key for this (context/36 section 12).
   */
  readonly operationId: string;

  /** Verified author and role. Never taken from the payload. */
  readonly actor: Actor;

  /** Allowed action from the system catalogue, e.g. `request.submit`. */
  readonly action: string;

  /** The object the operation acts on, for the journal and for conflict reporting. */
  readonly targetRef?: string | null;

  /**
   * Validated arguments. Their canonical form is the fingerprint, so replaying the same
   * id with different arguments is detectable.
   */
  readonly payload: unknown;

  /**
   * Version of the data the actor based the decision on, when the action follows from
   * having read or confirmed something. Absent where the action does not depend on a
   * prior read.
   */
  readonly expectedVersion?: number | null;

  /** Reference to an explicit confirmation, where one is required. */
  readonly confirmation?: string | null;
}

/** What the handler receives: a transaction and a single reading of the clock. */
export interface OperationContext {
  readonly tx: Tx;
  readonly now: number;
  readonly actor: Actor;
  readonly operationId: string;
}

export type OperationHandler<T> = (context: OperationContext) => Promise<T>;

/**
 * A side effect owned by another process.
 *
 * The operation envelope reserves and later finalises the durable journal around this
 * handler, but deliberately invokes it without a database transaction.
 */
export type ExternalOperationHandler<T> = () => Promise<T>;

/**
 * Outcome of running an operation.
 *
 * `replayed` distinguishes "we did the work now" from "you asked again and here is what
 * happened the first time". Callers that emit follow-up effects need that difference: a
 * replay must not send a second email or publish a second snapshot.
 */
export interface OperationOutcome<T> {
  readonly result: T;
  readonly replayed: boolean;
}
