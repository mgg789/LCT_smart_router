import { Injectable, Logger } from '@nestjs/common';
import { SysError, toErrorCode } from '../common/errors';
import { canonicalHash } from '../common/json';
import { Clock } from '../common/time';
import type { OperationState } from '../generated/prisma/client';
import { PrismaService, UnitOfWork } from '../persistence';
import { AuditService } from './audit.service';
import type {
  ExternalOperationHandler,
  OperationHandler,
  OperationOutcome,
  OperationRequest,
} from './operation.types';

interface StoredResponse {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: { code: string; message: string; details: Record<string, unknown> };
}

/**
 * The single entry point for every change the System Layer makes.
 *
 * Two rules from context/36 meet here, and they are easier to keep together than apart:
 *
 *   * **SL1** -- a business change, the record of who made it, and the follow-up actions
 *     it requires are saved consistently. Waiting on Router, AI or SMTP is deliberately
 *     outside that unit: a network call must never hold the transaction open, and a mail
 *     failure must not turn an already saved request into a non-existent one.
 *   * **SL7** -- repeating an operation returns the first outcome instead of doing the
 *     work twice, and the same id with different arguments is a caller bug rather than a
 *     second write.
 *
 * A refusal is stored too. Replaying a rejected operation gives back the same refusal,
 * which is what a caller that lost the response actually needs; and the journal can
 * explain later why nothing happened.
 */
@Injectable()
export class OperationsService {
  private readonly logger = new Logger(OperationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly audit: AuditService,
  ) {}

  async execute<T>(
    request: OperationRequest,
    handler: OperationHandler<T>,
  ): Promise<OperationOutcome<T>> {
    const fingerprint = this.fingerprint(request);

    const existing = await this.prisma.operation.findUnique({
      where: { operationId: request.operationId },
    });
    if (existing) {
      return {
        result: this.replay<T>(existing.payloadFingerprint, fingerprint, existing.response),
        replayed: true,
      };
    }

    const now = this.clock.nowSeconds();

    try {
      const result = await this.uow.run(async (tx) => {
        const value = await handler({
          tx,
          now,
          actor: request.actor,
          operationId: request.operationId,
        });

        // Inside the same transaction as the change itself: if this row is missing, a
        // retry would repeat work that already happened.
        await tx.operation.create({
          data: {
            operationId: request.operationId,
            actorKind: request.actor.kind,
            actorId: request.actor.id,
            source: request.actor.source,
            action: request.action,
            targetRef: request.targetRef ?? null,
            payloadFingerprint: fingerprint,
            state: 'applied',
            response: { ok: true, value } as object,
            createdAt: BigInt(now),
            completedAt: BigInt(now),
          },
        });

        await this.audit.record(tx, now, {
          actor: request.actor,
          action: request.action,
          targetRef: request.targetRef ?? null,
          operationId: request.operationId,
          details: { state: 'applied' },
        });

        return value;
      });

      return { result, replayed: false };
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Two identical requests raced. The other one won; return its outcome rather
        // than reporting a failure for work that did happen.
        const stored = await this.prisma.operation.findUnique({
          where: { operationId: request.operationId },
        });
        if (stored) {
          return {
            result: this.replay<T>(stored.payloadFingerprint, fingerprint, stored.response),
            replayed: true,
          };
        }
      }

      if (error instanceof SysError) {
        // The handler's transaction is gone, so the refusal is recorded in its own.
        await this.recordRefusal(request, fingerprint, now, error);
      }
      throw error;
    }
  }

  /**
   * Journals an idempotent mutation owned by another process without holding a database
   * transaction across the network call.
   *
   * The initial `outcome_unknown` row is a durable reservation. A retry with the same
   * operation id may safely invoke the remote handler again; the remote boundary must use
   * that id as its own durable idempotency key. A successful response or a domain refusal
   * then completes the same row and adds the corresponding audit fact.
   */
  async executeExternal<T>(
    request: OperationRequest,
    handler: ExternalOperationHandler<T>,
  ): Promise<OperationOutcome<T>> {
    const fingerprint = this.fingerprint(request);
    const existing = await this.prisma.operation.findUnique({
      where: { operationId: request.operationId },
    });
    if (existing) {
      this.assertFingerprint(existing.payloadFingerprint, fingerprint);
      if (existing.response !== null) {
        return {
          result: this.replay<T>(existing.payloadFingerprint, fingerprint, existing.response),
          replayed: true,
        };
      }
    } else {
      await this.reserveExternal(request, fingerprint);
      const reserved = await this.prisma.operation.findUniqueOrThrow({
        where: { operationId: request.operationId },
      });
      this.assertFingerprint(reserved.payloadFingerprint, fingerprint);
      if (reserved.response !== null) {
        return {
          result: this.replay<T>(reserved.payloadFingerprint, fingerprint, reserved.response),
          replayed: true,
        };
      }
    }

    try {
      const value = await handler();
      const completedAt = this.clock.nowSeconds();
      const applied = await this.uow.run(async (tx) => {
        const updated = await tx.operation.updateMany({
          where: { operationId: request.operationId, state: 'outcome_unknown' },
          data: {
            state: 'applied',
            response: { ok: true, value } as object,
            completedAt: BigInt(completedAt),
          },
        });
        if (updated.count === 1) {
          await this.audit.record(tx, completedAt, {
            actor: request.actor,
            action: request.action,
            targetRef: request.targetRef ?? null,
            operationId: request.operationId,
            details: { state: 'applied' },
          });
        }
        return updated.count === 1;
      });
      if (applied) {
        return { result: value, replayed: false };
      }

      const completed = await this.prisma.operation.findUniqueOrThrow({
        where: { operationId: request.operationId },
      });
      return {
        result: this.replay<T>(completed.payloadFingerprint, fingerprint, completed.response),
        replayed: true,
      };
    } catch (error) {
      if (error instanceof SysError) {
        await this.completeExternalRefusal(request, fingerprint, error);
      }
      throw error;
    }
  }

  /**
   * Fingerprint of the arguments, so that the same id carrying different arguments is
   * detectable. The action and target are part of it: reusing an id for a different
   * action is the same mistake.
   */
  private fingerprint(request: OperationRequest): string {
    return canonicalHash({
      action: request.action,
      targetRef: request.targetRef ?? null,
      expectedVersion: request.expectedVersion ?? null,
      confirmation: request.confirmation ?? null,
      payload: request.payload,
    });
  }

  private assertFingerprint(storedFingerprint: string, fingerprint: string): void {
    if (storedFingerprint !== fingerprint) {
      throw new SysError(
        'OPERATION_ID_REUSED',
        'This operation id was already used with different arguments',
        { details: {} },
      );
    }
  }

  private replay<T>(storedFingerprint: string, fingerprint: string, response: unknown): T {
    this.assertFingerprint(storedFingerprint, fingerprint);

    const stored = response as StoredResponse | null;
    if (!stored) {
      // The row exists but carries no outcome: the previous attempt's result is genuinely
      // unknown, and inventing one either way would be worse than saying so.
      throw new SysError('INTERNAL_ERROR', 'The outcome of the previous attempt is unknown');
    }
    if (stored.ok) {
      return stored.value as T;
    }
    const error = stored.error;
    throw new SysError(
      toErrorCode(error?.code ?? 'INTERNAL_ERROR'),
      error?.message ?? 'The operation was refused',
      { details: error?.details ?? {} },
    );
  }

  private async reserveExternal(request: OperationRequest, fingerprint: string): Promise<void> {
    const now = this.clock.nowSeconds();
    try {
      await this.uow.run(async (tx) => {
        await tx.operation.create({
          data: {
            operationId: request.operationId,
            actorKind: request.actor.kind,
            actorId: request.actor.id,
            source: request.actor.source,
            action: request.action,
            targetRef: request.targetRef ?? null,
            payloadFingerprint: fingerprint,
            state: 'outcome_unknown',
            response: undefined,
            createdAt: BigInt(now),
            completedAt: null,
          },
        });
        await this.audit.record(tx, now, {
          actor: request.actor,
          action: request.action,
          targetRef: request.targetRef ?? null,
          operationId: request.operationId,
          details: { state: 'outcome_unknown' },
        });
      });
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
    }
  }

  private async completeExternalRefusal(
    request: OperationRequest,
    fingerprint: string,
    error: SysError,
  ): Promise<void> {
    const completedAt = this.clock.nowSeconds();
    const state: OperationState = error.status === 409 ? 'conflict' : 'rejected';
    const response: StoredResponse = {
      ok: false,
      error: { code: error.code, message: error.message, details: error.details },
    };
    try {
      await this.uow.run(async (tx) => {
        const updated = await tx.operation.updateMany({
          where: {
            operationId: request.operationId,
            payloadFingerprint: fingerprint,
            state: 'outcome_unknown',
          },
          data: {
            state,
            response: response as object,
            completedAt: BigInt(completedAt),
          },
        });
        if (updated.count === 1) {
          await this.audit.record(tx, completedAt, {
            actor: request.actor,
            action: request.action,
            targetRef: request.targetRef ?? null,
            operationId: request.operationId,
            details: { state, code: error.code },
          });
        }
      });
    } catch (recordError) {
      this.logger.warn(
        `Could not complete refusal of external ${request.action}: ${
          recordError instanceof Error ? recordError.message : String(recordError)
        }`,
      );
    }
  }

  private async recordRefusal(
    request: OperationRequest,
    fingerprint: string,
    now: number,
    error: SysError,
  ): Promise<void> {
    const state: OperationState = error.status === 409 ? 'conflict' : 'rejected';
    const response: StoredResponse = {
      ok: false,
      error: { code: error.code, message: error.message, details: error.details },
    };

    try {
      await this.uow.run(async (tx) => {
        await tx.operation.create({
          data: {
            operationId: request.operationId,
            actorKind: request.actor.kind,
            actorId: request.actor.id,
            source: request.actor.source,
            action: request.action,
            targetRef: request.targetRef ?? null,
            payloadFingerprint: fingerprint,
            state,
            response: response as object,
            createdAt: BigInt(now),
            completedAt: BigInt(now),
          },
        });
        await this.audit.record(tx, now, {
          actor: request.actor,
          action: request.action,
          targetRef: request.targetRef ?? null,
          operationId: request.operationId,
          details: { state, code: error.code },
        });
      });
    } catch (recordError) {
      // Failing to journal a refusal must not replace the refusal the caller needs to
      // see, so this is logged and swallowed.
      this.logger.warn(
        `Could not record refusal of ${request.action}: ${
          recordError instanceof Error ? recordError.message : String(recordError)
        }`,
      );
    }
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'P2002'
  );
}
