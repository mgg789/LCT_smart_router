import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Actor } from '../../auth';
import { AppConfigService } from '../../common/config';
import { SysError } from '../../common/errors';
import { canonicalHash } from '../../common/json';
import { Clock } from '../../common/time';
import type { AiOperation, AiOperationState } from '../../generated/prisma/client';
import { AuditService, OperationsService } from '../../operations';
import { AlertsService } from '../../orchestrator/alerts';
import { EngineersService } from '../../orchestrator/engineers/engineers.service';
import { LiveService } from '../../orchestrator/live/live.service';
import { PolicyService } from '../../orchestrator/policy';
import { RequestsService } from '../../orchestrator/requests/requests.service';
import { PrismaService, UnitOfWork } from '../../persistence';
import { SnapshotPublisher } from '../../routing/mount-data-eng';
import type { AiPreviewRow } from '../runtime/ai-event.types';
import { type AiRunEventInput, RunEventBus } from '../runtime/run-event.bus';
import { RunRegistry } from '../runtime/run-registry';
import { RoleProfileService } from '../tools/role-profile';
import { type AiActionSpec, buildAiActionCatalog } from './ai-action.catalog';

export interface PrepareOperationInput {
  readonly actor: Actor;
  readonly accountId: string;
  readonly conversationId: string;
  readonly runId: string;
  readonly action: string;
  readonly targetRef: string | null;
  readonly payload: unknown;
  readonly expectedVersion?: number | null;
}

export interface PreparedOperation {
  readonly operationId: string;
  readonly state: 'awaiting_confirmation';
  readonly preview: readonly AiPreviewRow[];
  readonly expiresAt: number;
}

export interface ConfirmOperationInput {
  readonly actor: Actor;
  /** The `AiOperation` id -- the card the model prepared and a human is now acting on. */
  readonly aiOperationId: string;
  /** The confirming human's own idempotency key for the underlying business write, kept
   *  distinct from the card's id (llm.types.ts's own note on why a provider tool-call id
   *  is never a business idempotency key applies here too). */
  readonly operationId: string;
}

export interface CancelOperationInput {
  readonly actor: Actor;
  readonly aiOperationId: string;
}

export interface OperationOutcomeView {
  readonly aiOperationId: string;
  readonly state: AiOperationState;
  readonly result?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

/**
 * The prepare/confirm/cancel/expire spine that turns a tool call into a business write.
 *
 * `prepare` runs entirely inside the tool call that produced it (context/35 section 8): it
 * validates, prechecks, renders a server-side preview, and stores a card -- it never
 * writes to the domain. `confirm` is the one place a card actually becomes a write, and it
 * runs as a *separate* HTTP request from a human, strictly after the run that prepared the
 * card already finished; the four re-checks below exist because everything the model saw
 * at prepare time can be stale by the time a human clicks the button.
 */
@Injectable()
export class AiOperationService {
  private readonly catalog: ReadonlyMap<string, AiActionSpec>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly config: AppConfigService,
    private readonly operations: OperationsService,
    private readonly audit: AuditService,
    private readonly roleProfiles: RoleProfileService,
    private readonly bus: RunEventBus,
    private readonly registry: RunRegistry,
    requests: RequestsService,
    live: LiveService,
    engineers: EngineersService,
    alerts: AlertsService,
    policy: PolicyService,
    publisher: SnapshotPublisher,
  ) {
    this.catalog = buildAiActionCatalog({
      requests,
      live,
      engineers,
      alerts,
      policy,
      publisher,
      prisma,
      timeZone: config.get('APP_TIME_ZONE'),
    });
  }

  /** Looked up by tools before they even attempt to prepare, so an action outside the
   *  actor's current profile never gets as far as a precheck. */
  async isActionAvailable(actor: Actor, action: string): Promise<boolean> {
    const spec = this.catalog.get(action);
    if (!spec) {
      return false;
    }
    const profile = await this.roleProfiles.forActor(actor);
    return spec.allowedProfiles.includes(profile);
  }

  async prepare(input: PrepareOperationInput): Promise<PreparedOperation> {
    const spec = this.catalog.get(input.action);
    if (!spec) {
      throw new SysError('VALIDATION_FAILED', `Unknown AI action "${input.action}"`, {
        details: { action: input.action },
      });
    }
    const profile = await this.roleProfiles.forActor(input.actor);
    if (!spec.allowedProfiles.includes(profile)) {
      throw SysError.forbidden(`"${input.action}" is not offered in this AI profile`, {
        action: input.action,
        profile,
      });
    }
    const parsed = spec.zodSchema.safeParse(input.payload);
    if (!parsed.success) {
      throw new SysError('VALIDATION_FAILED', 'AI operation payload failed validation', {
        details: {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
      });
    }

    const now = this.clock.nowSeconds();
    const checkArgs = {
      actor: input.actor,
      accountId: input.accountId,
      targetRef: input.targetRef,
      payload: parsed.data,
      now,
    };
    // Ownership, lifecycle and capability, cheaply, before a button is ever offered for
    // something certain to fail.
    await spec.precheck(checkArgs);
    const preview = await spec.preview(checkArgs);

    const fingerprint = canonicalHash({
      action: input.action,
      targetRef: input.targetRef ?? null,
      payload: parsed.data,
    });
    const expiresAt = now + this.config.get('AI_OPERATION_TTL_SEC');
    const id = randomUUID();

    await this.uow.run(async (tx) => {
      await tx.aiOperation.create({
        data: {
          id,
          conversationId: input.conversationId,
          runId: input.runId,
          accountId: input.accountId,
          action: input.action,
          targetRef: input.targetRef,
          payload: parsed.data as object,
          payloadFingerprint: fingerprint,
          summary: preview as unknown as object,
          expectedVersion: input.expectedVersion ?? null,
          requiresConfirmation: true,
          state: 'awaiting_confirmation',
          createdAt: BigInt(now),
          expiresAt: BigInt(expiresAt),
        },
      });
      // The actor of record is the model that proposed the change, not the human it will
      // ask to confirm -- `ai_run` is the `ActorSource` reserved for exactly this
      // (schema.prisma's own comment on the enum), and nothing else writes it.
      await this.audit.record(tx, now, {
        actor: { ...input.actor, source: 'ai_run' },
        action: input.action,
        targetRef: input.targetRef ?? null,
        operationId: id,
        details: { state: 'awaiting_confirmation', aiOperationId: id },
      });
    });

    await this.emit(input.runId, {
      type: 'operation_prepared',
      operationId: id,
      action: input.action,
      targetRef: input.targetRef ?? null,
      state: 'awaiting_confirmation',
      preview,
      expiresAt,
    });

    return { operationId: id, state: 'awaiting_confirmation', preview, expiresAt };
  }

  /**
   * Applies a prepared card. In order: re-resolve the actor's profile, re-check the
   * action is still in it, re-check ownership, re-check the fingerprint and expiry, then
   * move `awaiting_confirmation -> running` with a single conditional write so a second
   * click finds nothing left to do. The business write itself goes through
   * `OperationsService.execute` with the confirming human's own `operationId` and
   * `actor.source` left as `ui` -- the journal reads "AI prepared, human applied".
   */
  async confirm(input: ConfirmOperationInput): Promise<OperationOutcomeView> {
    const op = await this.loadOwned(input.actor, input.aiOperationId);

    const profile = await this.roleProfiles.forActor(input.actor);
    const spec = this.catalog.get(op.action);
    if (!spec?.allowedProfiles.includes(profile)) {
      // A lane flip (e.g. dispatcher fix -> help) made after this card was prepared. The
      // card is refused regardless of what was true when the model received the
      // catalogue -- see the class doc comment.
      await this.finish(op, 'rejected', this.clock.nowSeconds(), {
        code: 'FORBIDDEN',
        message: `"${op.action}" is no longer available in this AI profile`,
      });
      throw SysError.forbidden(`"${op.action}" is no longer available in this AI profile`);
    }

    const recomputedFingerprint = canonicalHash({
      action: op.action,
      targetRef: op.targetRef,
      payload: op.payload,
    });
    if (recomputedFingerprint !== op.payloadFingerprint) {
      throw new SysError('VALIDATION_FAILED', 'The content changed, confirm the new version', {
        details: { aiOperationId: op.id },
      });
    }
    const nowSeconds = this.clock.nowSeconds();
    if (nowSeconds > Number(op.expiresAt)) {
      await this.finish(op, 'rejected', nowSeconds, {
        code: 'VALIDATION_FAILED',
        message: 'This confirmation has expired; ask again',
      });
      throw new SysError('VALIDATION_FAILED', 'This confirmation has expired; ask again', {
        details: { aiOperationId: op.id },
      });
    }

    const cas = await this.prisma.aiOperation.updateMany({
      where: { id: op.id, state: 'awaiting_confirmation', version: op.version },
      data: { state: 'running', confirmedAt: BigInt(nowSeconds), version: { increment: 1 } },
    });

    if (cas.count === 0) {
      // A second click, or two concurrent confirms: whichever got there first already
      // has an outcome (or is mid-flight), so this call returns it instead of writing
      // twice (context/36 section 12's replay rule, applied to this second spine).
      const current = await this.prisma.aiOperation.findUniqueOrThrow({ where: { id: op.id } });
      if (
        current.state === 'applied' ||
        current.state === 'rejected' ||
        current.state === 'outcome_unknown'
      ) {
        return this.toOutcomeView(current);
      }
      throw new SysError('VALIDATION_FAILED', 'This confirmation is already in progress', {
        details: { aiOperationId: op.id, state: current.state },
      });
    }

    const applyArgs = {
      actor: input.actor,
      accountId: op.accountId,
      targetRef: op.targetRef,
      payload: op.payload,
      now: nowSeconds,
    };

    try {
      const outcome = await this.operations.execute(
        {
          operationId: input.operationId,
          // The confirming human's own session -- deliberately not overridden, so the
          // journal shows "AI prepared, human applied" rather than the AI applying it.
          actor: input.actor,
          action: op.action,
          targetRef: op.targetRef,
          payload: op.payload,
          expectedVersion: op.expectedVersion,
          confirmation: op.id,
        },
        (context) => spec.apply({ ...applyArgs, context }),
      );
      await this.finish(
        op,
        'applied',
        this.clock.nowSeconds(),
        undefined,
        outcome.result,
        input.operationId,
      );
      return { aiOperationId: op.id, state: 'applied', result: outcome.result };
    } catch (error) {
      if (error instanceof SysError) {
        await this.finish(op, 'rejected', this.clock.nowSeconds(), {
          code: error.code,
          message: error.message,
        });
        return {
          aiOperationId: op.id,
          state: 'rejected',
          error: { code: error.code, message: error.message },
        };
      }
      // The write may or may not have landed; not knowing is the honest answer, not a
      // guess in either direction (ai-event.types.ts's own note on `outcome_unknown`).
      await this.finish(op, 'outcome_unknown', this.clock.nowSeconds());
      return { aiOperationId: op.id, state: 'outcome_unknown' };
    }
  }

  /** Withdraws a card before it is applied. Idempotent: cancelling an already-cancelled
   *  card returns the same state instead of refusing the retry. */
  async cancel(input: CancelOperationInput): Promise<OperationOutcomeView> {
    const op = await this.loadOwned(input.actor, input.aiOperationId);
    const now = this.clock.nowSeconds();
    const cas = await this.prisma.aiOperation.updateMany({
      where: {
        id: op.id,
        state: { in: ['prepared', 'awaiting_confirmation'] },
        version: op.version,
      },
      data: {
        state: 'cancelled_before_apply',
        completedAt: BigInt(now),
        version: { increment: 1 },
      },
    });
    if (cas.count === 0) {
      const current = await this.prisma.aiOperation.findUniqueOrThrow({ where: { id: op.id } });
      if (current.state === 'cancelled_before_apply') {
        return { aiOperationId: op.id, state: 'cancelled_before_apply' };
      }
      throw new SysError('VALIDATION_FAILED', 'This operation can no longer be cancelled', {
        details: { aiOperationId: op.id, state: current.state },
      });
    }
    await this.emit(op.runId, {
      type: 'operation_state',
      operationId: op.id,
      state: 'cancelled_before_apply',
    });
    return { aiOperationId: op.id, state: 'cancelled_before_apply' };
  }

  /** Sweeps every card a human never answered past its `expiresAt`. Not wired to an
   *  internal timer -- like `LiveService.advanceOnce`, it is meant to be driven by an
   *  external coordinator, so this returns the count it closed rather than looping. */
  async expire(): Promise<number> {
    const now = this.clock.nowSeconds();
    const stale = await this.prisma.aiOperation.findMany({
      where: {
        state: { in: ['prepared', 'awaiting_confirmation'] },
        expiresAt: { lt: BigInt(now) },
      },
      select: { id: true, runId: true, version: true },
    });
    let closed = 0;
    for (const row of stale) {
      const cas = await this.prisma.aiOperation.updateMany({
        where: {
          id: row.id,
          state: { in: ['prepared', 'awaiting_confirmation'] },
          version: row.version,
        },
        data: {
          state: 'cancelled_before_apply',
          completedAt: BigInt(now),
          version: { increment: 1 },
        },
      });
      if (cas.count === 1) {
        closed += 1;
        await this.emit(row.runId, {
          type: 'operation_state',
          operationId: row.id,
          state: 'cancelled_before_apply',
        });
      }
    }
    return closed;
  }

  /** The signed-in account's own card, or a truthful "not found" -- confirming someone
   *  else's prepared operation exists is itself a disclosure (context/42 DF-06). */
  private async loadOwned(actor: Actor, aiOperationId: string): Promise<AiOperation> {
    const op = await this.prisma.aiOperation.findUnique({ where: { id: aiOperationId } });
    if (!op || !actor.accountId || op.accountId !== actor.accountId) {
      throw SysError.notFound('Operation', { operationId: aiOperationId });
    }
    return op;
  }

  private async finish(
    op: AiOperation,
    state: 'applied' | 'rejected' | 'outcome_unknown',
    at: number,
    error?: { readonly code: string; readonly message: string },
    result?: unknown,
    resultOperationId?: string,
  ): Promise<void> {
    const response =
      state === 'applied' ? { ok: true, value: result } : { ok: false, error: error ?? null };
    await this.prisma.aiOperation.updateMany({
      where: { id: op.id },
      data: {
        state,
        completedAt: BigInt(at),
        result: response as object,
        ...(resultOperationId === undefined ? {} : { resultOperationId }),
      },
    });
    await this.emit(op.runId, {
      type: 'operation_state',
      operationId: op.id,
      state,
      ...(error ? { error } : {}),
    });
  }

  private toOutcomeView(op: AiOperation): OperationOutcomeView {
    const response = op.result as {
      ok: boolean;
      value?: unknown;
      error?: { code: string; message: string };
    } | null;
    if (!response) {
      return { aiOperationId: op.id, state: op.state };
    }
    return response.ok
      ? { aiOperationId: op.id, state: op.state, result: response.value }
      : { aiOperationId: op.id, state: op.state, error: response.error };
  }

  /** Emits a durable `operation_state`/`operation_prepared` event for `runId`, live if
   *  the run is still being driven by this process and persisted either way. */
  private async emit(runId: string | null, event: AiRunEventInput): Promise<void> {
    if (!runId) {
      return;
    }
    const handle = this.registry.get(runId);
    if (handle) {
      await this.bus.emit(handle, event);
      return;
    }
    await this.bus.emitForRun(runId, event);
  }
}
