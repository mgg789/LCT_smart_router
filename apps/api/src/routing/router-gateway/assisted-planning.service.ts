import { Injectable } from '@nestjs/common';
import { type Actor, effectiveRoles } from '../../auth';
import { SysError } from '../../common/errors';
import { canonicalHash, canonicalJson } from '../../common/json';
import { Clock } from '../../common/time';
import type { ControlState, DispatchPlanProposal } from '../../generated/prisma/client';
import { assertExpectedVersion, OperationsService } from '../../operations';
import type { OperationRequest } from '../../operations/operation.types';
import { businessNow } from '../../orchestrator/live/business-clock';
import {
  APP_STATE_KEYS,
  lockControlState,
  lockRoutingCurrent,
  PrismaService,
  type Tx,
  UnitOfWork,
} from '../../persistence';
import {
  type DispatcherConstraints,
  dispatcherSnapshotFactsSchema,
  readDispatcherConstraints,
  withDispatcherConstraints,
} from '../dispatcher-constraints';
import {
  PUBLICATION_TRIGGERS,
  type RouterTaskSnapshot,
  SnapshotBuilder,
  SnapshotPublisher,
} from '../mount-data-eng';
import { AppliedPlanService } from './applied-plan.service';
import {
  ASSISTED_PROPOSAL_TTL_SEC,
  type AssistedBlocker,
  type AssistedChange,
  type AssistedProposalView,
  type AssistedVersions,
  assistedChangeSchema,
} from './assisted.types';
import {
  type AssistedImpact,
  assistedImpactSchema,
  assistedReviewFingerprint,
  compareAssistedImpact,
  criticalImpactCovered,
} from './assisted-impact';
import { type RouterResult, routerResultSchema } from './result.types';
import { ResultAcceptanceService } from './result-acceptance.service';
import { RouterClient } from './router-client.port';

interface CapturedState {
  control: ControlState;
  working: Awaited<ReturnType<AppliedPlanService['current']>>;
  generation: number;
  snapshot: RouterTaskSnapshot;
  taskFingerprint: string;
  constraints: DispatcherConstraints;
}

export interface AssistedPreviewInput extends AssistedVersions {
  operationId: string;
  change: AssistedChange;
}

export interface AssistedApplyInput {
  operationId: string;
  proposalId: string;
  expectedPreviewFingerprint: string;
  confirmCritical: boolean;
}

export interface AssistedApplyOutcome {
  proposalId: string;
  state: 'applied';
  planRevision: number;
  constraintsVersion: number;
  impact: AssistedImpact;
}

/**
 * Dispatcher intentions become hard input pins only after a checked proposal is applied.
 * Solver/network work is outside write transactions; every apply rechecks source versions,
 * business inputs, resource context and the exact review fingerprint under the control lock.
 */
@Injectable()
export class AssistedPlanningService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly builder: SnapshotBuilder,
    private readonly publisher: SnapshotPublisher,
    private readonly plans: AppliedPlanService,
    private readonly router: RouterClient,
    private readonly acceptance: ResultAcceptanceService,
    private readonly operations: OperationsService,
  ) {}

  /** Current persistent pins and the latest still-relevant review card for this dispatcher. */
  async state(actor: Actor) {
    this.assertActor(actor);
    return this.uow.run(async (tx) => {
      await lockControlState(tx);
      const control = await tx.controlState.findUniqueOrThrow({ where: { id: 'singleton' } });
      const working = await this.plans.current(tx);
      const generation = await this.generation(tx);
      const proposalScope = {
        sourceGeneration: generation,
        sourceModeVersion: control.modeVersion,
        sourcePlanRevision: working?.revision ?? 0,
        sourceConstraintsVersion: control.constraintsVersion,
      };
      let proposal = await tx.dispatchPlanProposal.findFirst({
        where: {
          ...proposalScope,
          state: { in: ['prepared', 'blocked'] },
          OR: [{ source: 'automatic' }, { actorId: actor.id }],
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      if (!proposal)
        proposal = await tx.dispatchPlanProposal.findFirst({
          where: { ...proposalScope, source: 'automatic', state: 'cancelled' },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        });
      const current = await tx.routingCurrent.findUnique({
        where: { id: 'singleton' },
        include: { snapshot: true },
      });
      const rejected = current
        ? await tx.routerResult.findFirst({
            where: { inputHash: current.snapshot.inputHash, accepted: false },
            orderBy: { receivedAt: 'desc' },
          })
        : null;
      const parsed = rejected ? routerResultSchema.safeParse(rejected.payload) : null;
      const editable = current
        ? dispatcherSnapshotFactsSchema
            .parse(JSON.parse(current.snapshot.payload))
            .requests.map((row) => row.request_id)
        : [];
      return {
        mode: control.mode,
        modeVersion: control.modeVersion,
        planRevision: working?.revision ?? 0,
        constraintsVersion: control.constraintsVersion,
        constraints: readDispatcherConstraints(control.dispatcherConstraints),
        editableRequestIds: editable,
        pendingProposal: proposal ? this.view(proposal) : null,
        blockers: parsed?.success ? this.blockers(parsed.data) : [],
      };
    });
  }

  /** Prepare and persist a candidate without altering pins, requests, the plan or notifications. */
  async prepare(actor: Actor, input: AssistedPreviewInput): Promise<AssistedProposalView> {
    this.assertActor(actor);
    const request: OperationRequest = {
      operationId: input.operationId,
      actor,
      action: 'assisted.prepare',
      payload: input,
    };
    const replay = await this.replay<AssistedProposalView>(request);
    if (replay) return replay;
    const source = await this.uow.run(async (tx) => {
      const captured = await this.capture(tx, input);
      this.requireEditable(captured.control, input.change);
      const constraints = await this.changeConstraints(tx, captured, input.change);
      return { captured, constraints };
    });
    const contextVersion = await this.activeContext();
    const snapshot = withDispatcherConstraints(source.captured.snapshot, source.constraints);
    const candidate = await this.calculate(snapshot, input.operationId, contextVersion);
    const impact = this.impact(source.captured, candidate, snapshot);
    const now = this.clock.nowSeconds();
    const outcome = await this.operations.execute(request, async (context) => {
      const fresh = await this.capture(context.tx, input);
      this.assertSource(source.captured, fresh);
      const record = await context.tx.dispatchPlanProposal.create({
        data: {
          id: input.operationId,
          source: 'dispatcher',
          actorId: actor.id,
          state: candidate.main?.is_usable ? 'prepared' : 'blocked',
          payloadFingerprint: canonicalHash(input),
          reviewFingerprint: this.review(candidate, impact, fresh),
          sourceModeVersion: fresh.control.modeVersion,
          sourcePlanRevision: fresh.working?.revision ?? 0,
          sourceConstraintsVersion: fresh.control.constraintsVersion,
          sourceGeneration: fresh.generation,
          sourceTaskFingerprint: fresh.taskFingerprint,
          contextVersion,
          change: input.change,
          constraints: source.constraints,
          candidate: candidate as object,
          inputPayload: canonicalJson(snapshot),
          impact: impact as object,
          requiresConfirmation: impact.requiresConfirmation,
          createdAt: BigInt(now),
          expiresAt: BigInt(now + ASSISTED_PROPOSAL_TTL_SEC),
        },
      });
      return this.view(record);
    });
    return outcome.result;
  }

  /** Recompute against current time, then atomically publish pins and the approved candidate. */
  async apply(actor: Actor, input: AssistedApplyInput): Promise<AssistedApplyOutcome> {
    this.assertActor(actor);
    const request: OperationRequest = {
      operationId: input.operationId,
      actor,
      action: 'assisted.apply',
      targetRef: input.proposalId,
      payload: input,
    };
    const replay = await this.replay<AssistedApplyOutcome>(request);
    if (replay) return replay;
    try {
      return await this.applyPrepared(actor, input, request);
    } catch (error) {
      // A concurrent retry may observe the first attempt's new plan during preflight.
      // The committed operation receipt outranks that apparent stale-version error.
      const committed = await this.replay<AssistedApplyOutcome>(request);
      if (committed) return committed;
      throw error;
    }
  }

  private async applyPrepared(
    actor: Actor,
    input: AssistedApplyInput,
    request: OperationRequest,
  ): Promise<AssistedApplyOutcome> {
    const proposal = await this.prisma.dispatchPlanProposal.findUnique({
      where: { id: input.proposalId },
    });
    if (!proposal) throw SysError.notFound('Dispatcher proposal');
    this.assertProposal(actor, proposal, input);
    const approvedImpact = assistedImpactSchema.parse(proposal.impact);
    if (proposal.requiresConfirmation && !input.confirmCritical) {
      throw new SysError('CONFIRMATION_REQUIRED', 'Review the consequences before applying', {
        details: { proposal: this.view(proposal) },
      });
    }
    const change = assistedChangeSchema.parse(proposal.change);
    const source = await this.uow.run(async (tx) => {
      const captured = await this.capture(tx, this.versions(proposal));
      this.assertProposalSource(proposal, captured);
      this.requireEditable(captured.control, change);
      return captured;
    });
    const contextVersion = await this.activeContext();
    if (contextVersion !== proposal.contextVersion)
      throw new SysError(
        'VERSION_CONFLICT',
        'Routing resources changed; prepare the correction again',
      );
    const constraints = readDispatcherConstraints(proposal.constraints);
    const snapshot = withDispatcherConstraints(source.snapshot, constraints);
    const candidate = await this.calculate(snapshot, proposal.id, contextVersion);
    const impact = this.impact(source, candidate, snapshot);
    if (
      !candidate.main?.is_usable ||
      (impact.requiresConfirmation &&
        (!input.confirmCritical || !criticalImpactCovered(approvedImpact, impact)))
    ) {
      const updated = await this.uow.run(async (tx) => {
        const fresh = await this.capture(tx, this.versions(proposal));
        this.assertProposalSource(proposal, fresh);
        const stored = await tx.dispatchPlanProposal.findUniqueOrThrow({
          where: { id: proposal.id },
        });
        this.assertProposal(actor, stored, input);
        return tx.dispatchPlanProposal.update({
          where: { id: proposal.id },
          data: {
            state: candidate.main?.is_usable ? 'prepared' : 'blocked',
            candidate: candidate as object,
            inputPayload: canonicalJson(snapshot),
            impact: impact as object,
            requiresConfirmation: impact.requiresConfirmation,
            reviewFingerprint: this.review(candidate, impact, fresh),
            expiresAt: BigInt(this.clock.nowSeconds() + ASSISTED_PROPOSAL_TTL_SEC),
          },
        });
      });
      throw new SysError(
        candidate.main?.is_usable ? 'CONFIRMATION_REQUIRED' : 'RESULT_NOT_APPLICABLE',
        candidate.main?.is_usable
          ? 'The consequences changed; review the new proposal'
          : 'The requested pins are not feasible',
        { details: { proposal: this.view(updated) } },
      );
    }
    if ((await this.activeContext()) !== contextVersion)
      throw new SysError('VERSION_CONFLICT', 'Routing resources changed during review');
    const outcome = await this.operations.execute(request, async (context) => {
      const fresh = await this.capture(context.tx, this.versions(proposal));
      this.assertProposalSource(proposal, fresh);
      const stored = await context.tx.dispatchPlanProposal.findUniqueOrThrow({
        where: { id: proposal.id },
      });
      this.assertProposal(actor, stored, input);
      const changed = canonicalHash(fresh.constraints) !== canonicalHash(constraints);
      const updatedControl = await context.tx.controlState.update({
        where: { id: 'singleton' },
        data: {
          dispatcherConstraints: constraints,
          ...(changed ? { constraintsVersion: { increment: 1 } } : {}),
        },
      });
      const published = await this.publisher.publishIfChanged(
        context.tx,
        snapshot.planning_as_of,
        PUBLICATION_TRIGGERS.DISPATCHER_CONSTRAINTS_CHANGED,
        { force: true, businessTime: true, publicationId: proposal.id },
      );
      if (published.inputHash !== candidate.input_hash)
        throw new SysError('VERSION_CONFLICT', 'Inputs changed while publishing the reviewed plan');
      const applied = await this.acceptance.acceptPrepared(
        context.tx,
        candidate,
        contextVersion,
        input.confirmCritical ? approvedImpact : impact,
      );
      if (!applied.accepted || applied.planRevision === undefined) {
        throw new SysError(
          'RESULT_NOT_APPLICABLE',
          applied.detail ?? 'The reviewed plan cannot be applied',
        );
      }
      await context.tx.dispatchPlanProposal.update({
        where: { id: proposal.id },
        data: {
          state: 'applied',
          candidate: candidate as object,
          inputPayload: canonicalJson(snapshot),
          impact: impact as object,
          appliedAt: BigInt(context.now),
          appliedPlanRevision: applied.planRevision,
        },
      });
      await context.tx.auditLog.create({
        data: {
          at: BigInt(context.now),
          actorKind: actor.kind,
          actorId: actor.id,
          source: actor.source,
          operationId: input.operationId,
          action: 'plan.assisted',
          targetRef: proposal.id,
          details: {
            change,
            before: fresh.constraints,
            after: constraints,
            confirmedCritical: input.confirmCritical,
            reviewFingerprint: input.expectedPreviewFingerprint,
            sourcePlanRevision: proposal.sourcePlanRevision,
            planRevision: applied.planRevision,
            constraintsVersion: updatedControl.constraintsVersion,
            impact: impact as object,
          },
        },
      });
      return {
        proposalId: proposal.id,
        state: 'applied' as const,
        planRevision: applied.planRevision,
        constraintsVersion: updatedControl.constraintsVersion,
        impact,
      };
    });
    return outcome.result;
  }

  /** Cancel a review card only; no planning input or working assignment is changed. */
  async cancel(actor: Actor, input: { operationId: string; proposalId: string }) {
    this.assertActor(actor);
    const outcome = await this.operations.execute(
      {
        operationId: input.operationId,
        actor,
        action: 'assisted.cancel',
        targetRef: input.proposalId,
        payload: input,
      },
      async (context) => {
        await lockControlState(context.tx);
        const proposal = await context.tx.dispatchPlanProposal.findUnique({
          where: { id: input.proposalId },
        });
        if (!proposal) throw SysError.notFound('Dispatcher proposal');
        if (proposal.actorId && proposal.actorId !== actor.id)
          throw SysError.forbidden('This proposal belongs to another dispatcher');
        if (proposal.state === 'applied')
          throw new SysError('VERSION_CONFLICT', 'The proposal is already applied');
        await context.tx.dispatchPlanProposal.update({
          where: { id: proposal.id },
          data: { state: 'cancelled' },
        });
        return { proposalId: proposal.id, state: 'cancelled' as const };
      },
    );
    return outcome.result;
  }

  private async capture(tx: Tx, expected?: AssistedVersions): Promise<CapturedState> {
    await lockControlState(tx);
    await lockRoutingCurrent(tx);
    const control = await tx.controlState.findUniqueOrThrow({ where: { id: 'singleton' } });
    const working = await this.plans.current(tx);
    if (expected) {
      assertExpectedVersion('Control mode', expected.expectedModeVersion, control.modeVersion);
      assertExpectedVersion('Applied plan', expected.expectedPlanRevision, working?.revision ?? 0);
      assertExpectedVersion(
        'Dispatcher constraints',
        expected.expectedConstraintsVersion,
        control.constraintsVersion,
      );
    }
    const built = await this.builder.build(tx, await businessNow(tx, this.clock.nowSeconds()));
    return {
      control,
      working,
      generation: await this.generation(tx),
      snapshot: built.snapshot,
      taskFingerprint: built.taskFingerprint,
      constraints: readDispatcherConstraints(control.dispatcherConstraints),
    };
  }

  private assertActor(actor: Actor): void {
    if (!effectiveRoles(actor).includes('dispatcher'))
      throw SysError.forbidden('Dispatcher role is required');
  }

  private async generation(tx: Tx): Promise<number> {
    const row = await tx.appState.findUnique({ where: { key: APP_STATE_KEYS.GENERATION } });
    return typeof row?.value === 'number' ? row.value : 1;
  }

  private requireEditable(control: ControlState, change: AssistedChange): void {
    if (control.mode === 'manual')
      throw new SysError('MODE_MANUAL', 'Emergency MANUAL pauses automatic planning');
    if (change.kind !== 'replan' && control.mode !== 'assisted')
      throw new SysError('MODE_AUTO', 'Open dispatcher corrections and give a reason first');
  }

  private async changeConstraints(
    tx: Tx,
    source: CapturedState,
    change: AssistedChange,
  ): Promise<DispatcherConstraints> {
    const owners = new Map(
      source.constraints.assignments.map((row) => [row.requestId, row.engineerId]),
    );
    let orders = source.constraints.orders.map((row) => ({
      engineerId: row.engineerId,
      requestIds: [...row.requestIds],
    }));
    const remaining = new Set(source.snapshot.requests.map((row) => row.request_id));
    if (change.kind === 'assign' || change.kind === 'reorder') {
      const target = await tx.engineer.findUnique({ where: { id: change.engineerId } });
      if (!target || target.archivedAt !== null)
        throw SysError.validationFailed('The selected engineer is unavailable');
      const ids = change.kind === 'assign' ? [change.requestId] : change.requestIds;
      if (ids.some((id) => !remaining.has(id)))
        throw new SysError('WORK_ALREADY_STARTED', 'Only unstarted available work can be pinned');
      if (change.kind === 'reorder') {
        const route = source.working?.routes.find((row) => row.engineerId === change.engineerId);
        const editable =
          route?.stops.flatMap((stop) =>
            stop.requestId && remaining.has(stop.requestId) ? [stop.requestId] : [],
          ) ?? [];
        if (editable.length !== ids.length || ids.some((id) => !editable.includes(id)))
          throw SysError.validationFailed('Supply the complete editable queue of this engineer');
      }
      const selected = new Set(ids);
      orders = orders
        .map((row) => ({
          ...row,
          requestIds: row.requestIds.filter(
            (id) => !selected.has(id) || row.engineerId === change.engineerId,
          ),
        }))
        .filter((row) => row.requestIds.length >= 2);
      for (const requestId of ids) owners.set(requestId, change.engineerId);
      if (change.kind === 'reorder') {
        orders = orders.filter((row) => row.engineerId !== change.engineerId);
        orders.push({ engineerId: change.engineerId, requestIds: [...change.requestIds] });
      }
    } else if (change.kind === 'release') {
      const removed = new Set(change.requestIds);
      for (const requestId of removed) owners.delete(requestId);
      orders = orders
        .map((row) => ({ ...row, requestIds: row.requestIds.filter((id) => !removed.has(id)) }))
        .filter((row) => row.requestIds.length >= 2);
    } else if (change.kind === 'release_all') {
      owners.clear();
      orders = [];
    }
    return readDispatcherConstraints({
      assignments: [...owners].map(([requestId, engineerId]) => ({ requestId, engineerId })),
      orders,
    });
  }

  private assertSource(expected: CapturedState, actual: CapturedState): void {
    if (
      expected.generation !== actual.generation ||
      expected.taskFingerprint !== actual.taskFingerprint
    ) {
      throw new SysError(
        'VERSION_CONFLICT',
        'Planning facts changed; prepare the correction again',
      );
    }
  }

  private assertProposalSource(proposal: DispatchPlanProposal, source: CapturedState): void {
    if (
      proposal.sourceGeneration !== source.generation ||
      proposal.sourceTaskFingerprint !== source.taskFingerprint
    ) {
      throw new SysError('VERSION_CONFLICT', 'Planning facts changed after the preview');
    }
  }

  private assertProposal(
    actor: Actor,
    proposal: DispatchPlanProposal,
    input: AssistedApplyInput,
  ): void {
    if (proposal.actorId && proposal.actorId !== actor.id)
      throw SysError.forbidden('This proposal belongs to another dispatcher');
    if (proposal.state !== 'prepared')
      throw new SysError('RESULT_NOT_APPLICABLE', 'This proposal is not applicable', {
        details: { proposal: this.view(proposal) },
      });
    if (Number(proposal.expiresAt) <= this.clock.nowSeconds())
      throw new SysError('VERSION_CONFLICT', 'The preview expired; calculate it again');
    if (proposal.reviewFingerprint !== input.expectedPreviewFingerprint)
      throw new SysError('VERSION_CONFLICT', 'The review card changed; read it again');
  }

  private versions(proposal: DispatchPlanProposal): AssistedVersions {
    return {
      expectedModeVersion: proposal.sourceModeVersion,
      expectedPlanRevision: proposal.sourcePlanRevision,
      expectedConstraintsVersion: proposal.sourceConstraintsVersion,
    };
  }

  private review(candidate: RouterResult, impact: AssistedImpact, source: CapturedState): string {
    return assistedReviewFingerprint(
      candidate.input_hash ?? '',
      candidate.router_context_version ?? '',
      impact,
      source.control.modeVersion,
      source.working?.revision ?? 0,
      source.control.constraintsVersion,
    );
  }

  private impact(
    source: CapturedState,
    candidate: RouterResult,
    snapshot: RouterTaskSnapshot,
  ): AssistedImpact {
    if (!candidate.main)
      throw new SysError('ROUTER_UNAVAILABLE', 'Router did not return a candidate plan');
    return compareAssistedImpact(source.working, candidate.main, snapshot);
  }

  private async activeContext(): Promise<string> {
    try {
      const context = await this.router.getActiveContextVersion();
      if (context) return context;
    } catch (error) {
      if (error instanceof SysError && error.code === 'VERSION_CONFLICT') throw error;
    }
    throw new SysError(
      'ROUTER_UNAVAILABLE',
      'Router is unavailable; the working plan is unchanged',
    );
  }

  private async calculate(
    snapshot: RouterTaskSnapshot,
    proposalId: string,
    contextVersion: string,
  ): Promise<RouterResult> {
    const payload = canonicalJson(snapshot);
    const inputHash = canonicalHash(snapshot);
    let result: RouterResult;
    try {
      result = await this.router.previewDispatcherPlan({
        publication: {
          publication_id: proposalId,
          publication_seq: 0,
          payload_utf8: payload,
          payload_sha256: inputHash,
          published_at_epoch: snapshot.planning_as_of,
        },
        expected_context_version: contextVersion,
      });
    } catch (error) {
      if (error instanceof SysError && error.code === 'VERSION_CONFLICT') throw error;
      throw new SysError(
        'ROUTER_UNAVAILABLE',
        'Router could not evaluate the correction; the working plan is unchanged',
      );
    }
    if (
      result.status !== 'ready' ||
      !result.main ||
      result.input_hash !== inputHash ||
      result.input_publication_id !== proposalId ||
      result.router_context_version !== contextVersion
    ) {
      throw new SysError('RESULT_NOT_APPLICABLE', 'Router returned an invalid or stale proposal');
    }
    return result;
  }

  private blockers(result: RouterResult): AssistedBlocker[] {
    const blockers: AssistedBlocker[] = result.errors.map((row) => ({
      code: row.code,
      message: row.message,
      requestIds: row.entity_id ? [row.entity_id] : [],
      engineerIds: [],
    }));
    for (const row of result.main?.alerts ?? []) {
      if (row.severity === 'error')
        blockers.push({
          code: row.code,
          message: row.reasons[0]?.text ?? row.code,
          requestIds: row.request_ids,
          engineerIds: row.engineer_ids,
        });
    }
    return blockers;
  }

  private view(proposal: DispatchPlanProposal): AssistedProposalView {
    const candidate = routerResultSchema.parse(proposal.candidate);
    return {
      proposalId: proposal.id,
      previewFingerprint: proposal.reviewFingerprint,
      source: proposal.source === 'automatic' ? 'automatic' : 'dispatcher',
      state: proposal.state,
      createdAt: Number(proposal.createdAt),
      expiresAt: Number(proposal.expiresAt),
      canApply:
        proposal.state === 'prepared' &&
        Number(proposal.expiresAt) > this.clock.nowSeconds() &&
        Boolean(candidate.main?.is_usable),
      requiresConfirmation: proposal.requiresConfirmation,
      versions: this.versions(proposal),
      change: assistedChangeSchema.parse(proposal.change),
      constraints: readDispatcherConstraints(proposal.constraints),
      impact: assistedImpactSchema.parse(proposal.impact),
      blockers: this.blockers(candidate),
    };
  }

  private async replay<T>(request: OperationRequest): Promise<T | null> {
    if (!(await this.prisma.operation.findUnique({ where: { operationId: request.operationId } })))
      return null;
    return (
      await this.operations.execute<T>(request, async () => {
        throw new Error('Operation receipt disappeared');
      })
    ).result;
  }
}
