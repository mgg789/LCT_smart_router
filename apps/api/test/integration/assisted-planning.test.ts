import '../support/env';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { after, before, describe, it, mock } from 'node:test';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { uploadDataPackageSchema } from '../../src/api/dto/data.dto';
import { AppModule } from '../../src/app.module';
import type { Actor } from '../../src/auth';
import { SysError } from '../../src/common/errors';
import type { PrismaClient } from '../../src/generated/prisma/client';
import { OperationsService } from '../../src/operations';
import { UploadImportService } from '../../src/orchestrator/imports';
import type { RouterTaskSnapshot } from '../../src/routing/mount-data-eng';
import {
  AppliedPlanService,
  AssistedPlanningService,
  ControlStateService,
  ResultAcceptanceService,
  RouterClient,
  routerResultSchema,
} from '../../src/routing/router-gateway';
import type {
  AssistedChange,
  AssistedProposalView,
} from '../../src/routing/router-gateway/assisted.types';
import type { DispatcherPreviewInput } from '../../src/routing/router-gateway/router-client.port';
import { createTestClient, unique } from '../support/database';
import { buildRouterResult } from '../support/router-result';

/** PostgreSQL supplies real locks, publication hashes and idempotency; the deterministic
 *  Router double lets each confirmation risk be isolated independently from search quality. */
describe('assisted dispatcher planning', () => {
  let app: INestApplicationContext;
  let db: PrismaClient;
  let service: AssistedPlanningService;
  let engineers: string[] = [];
  let requests: string[] = [];
  const operationIds: string[] = [];
  const proposalIds: string[] = [];
  const region = unique('assisted').replaceAll('-', '_');
  const now = Date.parse('2026-09-24T06:00:00Z') / 1000;
  const actor: Actor = {
    kind: 'account',
    id: 'assisted-test-dispatcher',
    accountId: 'assisted-test-dispatcher',
    source: 'ui',
    role: 'dispatcher',
    tokenCategory: null,
  };
  let dropId: string | null = null;
  let unavailable = false;

  const nextOperation = () => {
    const id = randomUUID();
    operationIds.push(id);
    return id;
  };
  const current = async () => {
    const control = await db.controlState.findUniqueOrThrow({ where: { id: 'singleton' } });
    const plan = await app.get(AppliedPlanService).current(db);
    return {
      control,
      plan,
      expectedModeVersion: control.modeVersion,
      expectedPlanRevision: plan?.revision ?? 0,
      expectedConstraintsVersion: control.constraintsVersion,
    };
  };
  const enter = async () => {
    const state = await current();
    await app.get(OperationsService).execute(
      {
        actor,
        action: 'control.assisted',
        operationId: nextOperation(),
        payload: state.expectedPlanRevision,
      },
      (context) =>
        app.get(ControlStateService).enterAssisted(context, 'Dispatcher correction test', state),
    );
  };
  const prepare = async (change: AssistedChange) => {
    const state = await current();
    const operationId = nextOperation();
    proposalIds.push(operationId);
    return service.prepare(actor, {
      operationId,
      change,
      expectedModeVersion: state.expectedModeVersion,
      expectedPlanRevision: state.expectedPlanRevision,
      expectedConstraintsVersion: state.expectedConstraintsVersion,
    });
  };
  const apply = (
    proposal: AssistedProposalView,
    confirmed = proposal.requiresConfirmation,
    operationId = nextOperation(),
  ) =>
    service.apply(actor, {
      operationId,
      proposalId: proposal.proposalId,
      expectedPreviewFingerprint: proposal.previewFingerprint,
      confirmCritical: confirmed,
    });

  const resultFor = (input: DispatcherPreviewInput, ignorePins = false) => {
    const snapshot: RouterTaskSnapshot = JSON.parse(input.publication.payload_utf8);
    const byId = new Map(snapshot.requests.map((row) => [row.request_id, row]));
    const owners = new Map(
      snapshot.requests.map((row) => [
        row.request_id,
        (!ignorePins && row.pinned_engineer_id) ||
          must(engineers[requests.indexOf(row.request_id) < 3 ? 0 : 1]),
      ]),
    );
    const blocked = snapshot.requests.some(
      (row) =>
        row.pinned_engineer_id &&
        snapshot.engineers.find((engineer) => engineer.engineer_id === row.pinned_engineer_id)
          ?.availability !== 'online',
    );
    const assigned = [];
    for (const engineerId of engineers) {
      const order =
        snapshot.pinned_orders?.find((row) => row.engineer_id === engineerId)?.request_ids ?? [];
      const ids = snapshot.requests
        .filter((row) => owners.get(row.request_id) === engineerId && row.request_id !== dropId)
        .map((row) => row.request_id);
      ids.sort((a, b) => {
        if (order.includes(a) && order.includes(b)) return order.indexOf(a) - order.indexOf(b);
        return requests.indexOf(a) - requests.indexOf(b);
      });
      let clock = snapshot.planning_as_of + 600;
      for (const requestId of ids) {
        const request = byId.get(requestId);
        assert.ok(request);
        const startAt = Math.max(
          clock,
          now + 600 + Math.max(0, requests.indexOf(requestId)) * 2400,
        );
        assigned.push({
          requestId,
          engineerId,
          lat: request.location.lat,
          lon: request.location.lon,
          startAt,
          durationSec: request.service_duration_sec,
        });
        clock = startAt + request.service_duration_sec;
      }
    }
    const result = routerResultSchema.parse(
      buildRouterResult({
        resultId: unique('assisted-result'),
        inputPublicationId: input.publication.publication_id,
        inputHash: input.publication.payload_sha256,
        contextVersion: input.expected_context_version,
        planningAsOf: snapshot.planning_as_of,
        isUsable: !blocked,
        assigned: blocked ? [] : assigned,
        unassigned: snapshot.requests
          .filter((row) => blocked || row.request_id === dropId)
          .map((row) => ({
            requestId: row.request_id,
            code: blocked ? 'DISPATCHER_CONSTRAINT_CONFLICT' : 'NO_FEASIBLE_ASSIGNMENT_FOUND',
            text: 'Test witness',
          })),
      }),
    );
    if (blocked && result.main)
      result.main.alerts.push({
        alert_id: 'pins',
        code: 'DISPATCHER_CONSTRAINT_CONFLICT',
        severity: 'error',
        request_ids: snapshot.requests
          .filter((row) => row.pinned_engineer_id)
          .map((row) => row.request_id),
        engineer_ids: [],
        reasons: [],
      });
    return result;
  };

  const automatic = async (ignorePins = false) => {
    const publication = await db.routingCurrent.findUniqueOrThrow({
      where: { id: 'singleton' },
      include: { snapshot: true },
    });
    return resultFor(
      {
        publication: {
          publication_id: publication.snapshotId,
          publication_seq: 0,
          payload_utf8: publication.snapshot.payload,
          payload_sha256: publication.snapshot.inputHash,
          published_at_epoch: Number(publication.snapshot.planningAsOf),
        },
        expected_context_version: 'assisted-test',
      },
      ignorePins,
    );
  };

  before(async () => {
    assert.ok(process.env.TEST_DATABASE_URL, 'Use an isolated PostgreSQL database');
    mock.timers.enable({ apis: ['Date'], now: now * 1000 });
    db = createTestClient();
    app = await NestFactory.createApplicationContext(AppModule, {
      logger: false,
      abortOnError: false,
    });
    service = app.get(AssistedPlanningService);
    const router = app.get(RouterClient);
    mock.method(router, 'getActiveContextVersion', async () => 'assisted-test');
    mock.method(router, 'previewDispatcherPlan', async (input: DispatcherPreviewInput) => {
      if (unavailable) throw new Error('Router unavailable');
      return resultFor(input);
    });
    const input = uploadDataPackageSchema.parse({
      ...JSON.parse(
        readFileSync(resolve(process.cwd(), '../../data/demo/manual-control.json'), 'utf8'),
      ),
      region,
      operationId: nextOperation(),
    });
    await app
      .get(OperationsService)
      .execute(
        { actor, action: 'data.upload', operationId: input.operationId, payload: input },
        (context) => app.get(UploadImportService).importPackage(context, input, 3 * 3600),
      );
    engineers = (
      await db.engineer.findMany({ where: { region }, orderBy: { inputOrder: 'asc' } })
    ).map((row) => row.id);
    requests = (
      await db.request.findMany({ where: { region }, orderBy: { arrivalOrder: 'asc' } })
    ).map((row) => row.id);
    assert.equal(engineers.length, 2);
    assert.equal(requests.length, 4);
    assert.equal(
      (await app.get(ResultAcceptanceService).accept(await automatic(), 'assisted-test')).accepted,
      true,
    );
  });

  after(async () => {
    await app?.close();
    if (db) {
      await db.dispatchPlanProposal.deleteMany({
        where: { OR: [{ actorId: actor.id }, { id: { in: proposalIds } }] },
      });
      await db.controlState.update({
        where: { id: 'singleton' },
        data: {
          mode: 'auto',
          frozenPlanId: null,
          dispatcherConstraints: { assignments: [], orders: [] },
          constraintsVersion: { increment: 1 },
        },
      });
      await db.appliedPlanCurrent.deleteMany({
        where: { plan: { routes: { some: { engineerId: { in: engineers } } } } },
      });
      await db.appliedPlan.deleteMany({
        where: { routes: { some: { engineerId: { in: engineers } } } },
      });
      await db.request.deleteMany({ where: { region } });
      await db.engineer.deleteMany({ where: { region } });
      await db.depot.deleteMany({ where: { region } });
      await db.alert.deleteMany({
        where: {
          OR: [{ requestIds: { hasSome: requests } }, { engineerIds: { hasSome: engineers } }],
        },
      });
      await db.auditLog.deleteMany({ where: { operationId: { in: operationIds } } });
      await db.operation.deleteMany({ where: { operationId: { in: operationIds } } });
      await db.$disconnect();
    }
    mock.timers.reset();
    mock.restoreAll();
  });

  it('requires a reason and keeps automatic result acceptance on in assisted mode', async () => {
    const state = await current();
    await assert.rejects(
      app
        .get(OperationsService)
        .execute(
          { actor, action: 'control.assisted', operationId: nextOperation(), payload: {} },
          (context) => app.get(ControlStateService).enterAssisted(context, ' ', state),
        ),
      (error) => error instanceof SysError && error.code === 'VALIDATION_FAILED',
    );
    await enter();
    assert.equal((await current()).control.mode, 'assisted');
    assert.equal(
      (await app.get(ResultAcceptanceService).accept(await automatic(), 'assisted-test')).accepted,
      true,
    );
  });

  it('preview and cancellation do not alter assignments or pins', async () => {
    const initial = await current();
    const proposal = await prepare({
      kind: 'assign',
      requestId: must(requests[0]),
      engineerId: must(engineers[1]),
    });
    assert.equal(proposal.canApply, true);
    assert.equal(proposal.requiresConfirmation, false);
    assert.equal((await current()).plan?.revision, initial.plan?.revision);
    await service.cancel(actor, { operationId: nextOperation(), proposalId: proposal.proposalId });
    assert.equal((await current()).control.constraintsVersion, initial.control.constraintsVersion);
    await assert.rejects(
      apply(proposal),
      (error) => error instanceof SysError && error.code === 'RESULT_NOT_APPLICABLE',
    );
  });

  it('applies ordinary pins atomically and replays an identical apply without another plan', async () => {
    const proposal = await prepare({
      kind: 'assign',
      requestId: must(requests[0]),
      engineerId: must(engineers[1]),
    });
    const operationId = nextOperation();
    const [outcome, replay] = await Promise.all([
      apply(proposal, false, operationId),
      apply(proposal, false, operationId),
    ]);
    assert.deepEqual(replay, outcome);
    assert.equal((await current()).plan?.revision, outcome.planRevision);
    const publication = await db.routingCurrent.findUniqueOrThrow({
      where: { id: 'singleton' },
      include: { snapshot: true },
    });
    const snapshot: RouterTaskSnapshot = JSON.parse(publication.snapshot.payload);
    assert.equal(
      snapshot.requests.find((row) => row.request_id === requests[0])?.pinned_engineer_id,
      engineers[1],
    );
    const state = await current();
    await app
      .get(OperationsService)
      .execute(
        { actor, action: 'control.auto', operationId: nextOperation(), payload: {} },
        (context) => app.get(ControlStateService).returnToAuto(context, state),
      );
    assert.equal((await current()).control.constraintsVersion, outcome.constraintsVersion);
    assert.equal((await service.state(actor)).constraints.assignments.length, 1);
  });

  it('refuses an automatic result that violates an existing pin', async () => {
    const initial = await current();
    const outcome = await app
      .get(ResultAcceptanceService)
      .accept(await automatic(true), 'assisted-test');
    assert.equal(outcome.accepted, false);
    assert.equal(outcome.reason, 'RESULT_NOT_APPLICABLE');
    assert.equal((await current()).plan?.revision, initial.plan?.revision);
  });

  it('holds a damaging automatic replan for review while preserving the current plan', async () => {
    const initial = await current();
    dropId = must(requests[3]);
    const outcome = await app
      .get(ResultAcceptanceService)
      .accept(await automatic(), 'assisted-test');
    assert.equal(outcome.accepted, false);
    assert.equal(outcome.reason, 'CONFIRMATION_REQUIRED');
    assert.ok(outcome.proposalId);
    proposalIds.push(outcome.proposalId);
    const card = (await service.state(actor)).pendingProposal;
    assert.ok(card);
    assert.equal(card.source, 'automatic');
    assert.equal(card.requiresConfirmation, true);
    assert.equal((await current()).plan?.revision, initial.plan?.revision);
    await assert.rejects(
      apply(card, false),
      (error) => error instanceof SysError && error.code === 'CONFIRMATION_REQUIRED',
    );
    await service.cancel(actor, { operationId: nextOperation(), proposalId: card.proposalId });
    assert.equal((await current()).plan?.revision, initial.plan?.revision);
    const second = await app
      .get(ResultAcceptanceService)
      .accept(await automatic(), 'assisted-test');
    assert.ok(second.proposalId);
    proposalIds.push(second.proposalId);
    const review = (await service.state(actor)).pendingProposal;
    assert.ok(review);
    assert.equal(review.state, 'prepared');
    await apply(review, true);
    assert.equal(
      (await current()).plan?.assignments.find((row) => row.requestId === requests[3])?.status,
      'unassigned',
    );
    dropId = null;
    assert.equal(
      (await app.get(ResultAcceptanceService).accept(await automatic(), 'assisted-test')).accepted,
      true,
    );
    await enter();
  });

  it('will not reuse an old acknowledgement when recalculation reveals a new serious harm', async () => {
    dropId = null;
    const proposal = await prepare({
      kind: 'assign',
      requestId: must(requests[1]),
      engineerId: must(engineers[1]),
    });
    assert.equal(proposal.requiresConfirmation, false);
    dropId = must(requests[3]);
    let updated: AssistedProposalView | undefined;
    await assert.rejects(apply(proposal, false), (error) => {
      if (!(error instanceof SysError) || error.code !== 'CONFIRMATION_REQUIRED') return false;
      updated = error.details.proposal as AssistedProposalView;
      return true;
    });
    assert.ok(updated);
    assert.notEqual(updated.previewFingerprint, proposal.previewFingerprint);
    await assert.rejects(
      apply(proposal, true),
      (error) => error instanceof SysError && error.code === 'VERSION_CONFLICT',
    );
    const outcome = await apply(updated, true);
    assert.equal(outcome.impact.lost.length, 1);
    assert.equal(
      (await current()).plan?.assignments.find((row) => row.requestId === requests[3])?.status,
      'unassigned',
    );
    dropId = null;
  });

  it('shows automatic proposals after the working-set generation advances independently of snapshot generation', async () => {
    const previous = await db.appState.findUniqueOrThrow({ where: { key: 'generation' } });
    assert.equal(typeof previous.value, 'number');
    await db.appState.update({
      where: { key: 'generation' },
      data: { value: Number(previous.value) + 10 },
    });
    dropId = must(requests[2]);
    try {
      const outcome = await app
        .get(ResultAcceptanceService)
        .accept(await automatic(), 'assisted-test');
      assert.equal(outcome.reason, 'CONFIRMATION_REQUIRED');
      assert.ok(outcome.proposalId);
      proposalIds.push(outcome.proposalId);
      const card = (await service.state(actor)).pendingProposal;
      assert.equal(card?.proposalId, outcome.proposalId);
      assert.ok(card);
      await apply(card, true);
    } finally {
      dropId = null;
      await db.appState.update({
        where: { key: 'generation' },
        data: { value: Number(previous.value) },
      });
    }
  });

  it('rejects changes to already started work and rejects facts changed after preview', async () => {
    const requestId = must(requests[3]);
    const proposal = await prepare({ kind: 'assign', requestId, engineerId: must(engineers[1]) });
    await db.request.update({
      where: { id: requestId },
      data: { lifecycle: 'in_progress', startedAt: BigInt(now) },
    });
    try {
      await assert.rejects(
        apply(proposal, true),
        (error) => error instanceof SysError && error.code === 'VERSION_CONFLICT',
      );
      await assert.rejects(
        prepare({ kind: 'assign', requestId, engineerId: must(engineers[1]) }),
        (error) => error instanceof SysError && error.code === 'WORK_ALREADY_STARTED',
      );
    } finally {
      await db.request.update({
        where: { id: requestId },
        data: { lifecycle: 'submitted', startedAt: null },
      });
    }
  });

  it('refuses foreign, expired, and stale proposals', async () => {
    const proposal = await prepare({ kind: 'release', requestIds: [must(requests[1])] });
    await assert.rejects(
      service.apply(
        { ...actor, id: 'another-dispatcher' },
        {
          operationId: nextOperation(),
          proposalId: proposal.proposalId,
          expectedPreviewFingerprint: proposal.previewFingerprint,
          confirmCritical: true,
        },
      ),
      (error) => error instanceof SysError && error.code === 'FORBIDDEN',
    );
    mock.timers.setTime((proposal.expiresAt + 1) * 1000);
    await assert.rejects(
      apply(proposal, true),
      (error) => error instanceof SysError && error.code === 'VERSION_CONFLICT',
    );
    mock.timers.setTime(now * 1000);
    assert.equal(
      (await app.get(ResultAcceptanceService).accept(await automatic(), 'assisted-test')).accepted,
      true,
    );
    await assert.rejects(
      apply(proposal, true),
      (error) => error instanceof SysError && error.code === 'VERSION_CONFLICT',
    );
  });

  it('does not apply an infeasible pin even if confirmation is supplied', async () => {
    await db.engineerDay.updateMany({
      where: { engineerId: must(engineers[0]) },
      data: { availability: 'offline', expectedOnlineAt: null },
    });
    const initial = await current();
    const proposal = await prepare({
      kind: 'assign',
      requestId: must(requests[2]),
      engineerId: must(engineers[0]),
    });
    assert.equal(proposal.state, 'blocked');
    assert.equal(proposal.canApply, false);
    await assert.rejects(
      apply(proposal, true),
      (error) => error instanceof SysError && error.code === 'RESULT_NOT_APPLICABLE',
    );
    assert.equal((await current()).plan?.revision, initial.plan?.revision);
    await db.engineerDay.updateMany({
      where: { engineerId: must(engineers[0]) },
      data: { availability: 'online' },
    });
  });

  it('keeps the working plan when Router is unavailable', async () => {
    const initial = await current();
    unavailable = true;
    await assert.rejects(
      prepare({ kind: 'release_all' }),
      (error) => error instanceof SysError && error.code === 'ROUTER_UNAVAILABLE',
    );
    assert.equal((await current()).plan?.revision, initial.plan?.revision);
    unavailable = false;
  });
});

function must<T>(value: T | null | undefined): T {
  assert.ok(value !== null && value !== undefined);
  return value;
}
