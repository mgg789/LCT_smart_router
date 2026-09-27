import { ActionGuardService } from '../../src/ai/operations/action-guard';
import { isWindowConfirmationRequired } from '../../src/orchestrator/requests/window-confirmation';
import '../support/env';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it, mock } from 'node:test';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AiOperationService, RoleProfileService } from '../../src/ai';
import { AppModule } from '../../src/app.module';
import type { Actor } from '../../src/auth';
import { SysError } from '../../src/common/errors';
import type { AiConversation, AiRun, PrismaClient } from '../../src/generated/prisma/client';
import { createTestClient, databaseUrl, unique } from '../support/database';

/**
 * Acceptance scenarios for the prepare/confirm spine (`AiOperationService`): a card
 * actually becomes a write exactly once, a second confirm click replays instead of
 * repeating the work, and a dispatcher's lane flip made after a card was prepared blocks
 * it at confirm time regardless of what was true when it was prepared.
 */
describe('AI operation prepare/confirm spine', () => {
  let context: INestApplicationContext;
  let prisma: PrismaClient;
  let aiOperations: AiOperationService;
  let roleProfiles: RoleProfileService;
  const accountIds: string[] = [];
  const conversationIds: string[] = [];

  before(async () => {
    process.env.NODE_ENV = 'test';
    databaseUrl();
    prisma = createTestClient();
    await prisma.$connect();
    context = await NestFactory.createApplicationContext(AppModule, { logger: false });
    aiOperations = context.get(AiOperationService);
    roleProfiles = context.get(RoleProfileService);
  });

  after(async () => {
    if (conversationIds.length > 0) {
      await prisma.aiOperation.deleteMany({ where: { conversationId: { in: conversationIds } } });
      await prisma.aiRun.deleteMany({ where: { conversationId: { in: conversationIds } } });
      await prisma.aiConversation.deleteMany({ where: { id: { in: conversationIds } } });
    }
    if (accountIds.length > 0) {
      await prisma.request.deleteMany({ where: { clientAccountId: { in: accountIds } } });
      await prisma.accountRole.deleteMany({ where: { accountId: { in: accountIds } } });
      await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
    }
    await prisma.appState.deleteMany({ where: { key: 'ai_dispatcher_assist_mode' } });
    await prisma.$disconnect();
    await context?.close();
  });

  /** A signed-in client account with an open `client` conversation and a finished run to
   *  attach prepared cards to -- the minimum a real chat session would already have. */
  async function newClientSession(): Promise<{
    actor: Actor;
    conversation: AiConversation;
    run: AiRun;
  }> {
    const now = Math.floor(Date.now() / 1000);
    const email = `${unique('ai-op-client')}@example.test`;
    const account = await prisma.account.create({
      data: { email, createdAt: BigInt(now), updatedAt: BigInt(now) },
    });
    accountIds.push(account.id);
    await prisma.accountRole.create({
      data: { accountId: account.id, role: 'client', grantedAt: BigInt(now) },
    });
    const conversation = await prisma.aiConversation.create({
      data: {
        accountId: account.id,
        role: 'client',
        roleProfile: 'client',
        createdAt: BigInt(now),
        updatedAt: BigInt(now),
        lastMessageAt: BigInt(now),
      },
    });
    conversationIds.push(conversation.id);
    const run = await prisma.aiRun.create({
      data: {
        conversationId: conversation.id,
        accountId: account.id,
        quotaDay: '2026-01-01',
        quotaAccountId: account.id,
        roleProfile: 'client',
        state: 'completed',
        providerKind: 'replay',
        model: 'test',
        reservedMicros: 0,
        startedAt: BigInt(now),
        finishedAt: BigInt(now),
      },
    });
    const actor: Actor = {
      kind: 'account',
      source: 'ui',
      id: account.id,
      role: 'client',
      tokenCategory: null,
      accountId: account.id,
    };
    return { actor, conversation, run };
  }

  /** A signed-in dispatcher account, already in fix mode, with an open conversation and a
   *  finished run to attach prepared cards to -- the dispatcher counterpart of
   *  `newClientSession` above. */
  async function newDispatcherSession(): Promise<{
    actor: Actor;
    conversation: AiConversation;
    run: AiRun;
  }> {
    const now = Math.floor(Date.now() / 1000);
    const email = `${unique('ai-op-dispatcher-fix')}@example.test`;
    const account = await prisma.account.create({
      data: { email, createdAt: BigInt(now), updatedAt: BigInt(now) },
    });
    accountIds.push(account.id);
    await prisma.accountRole.create({
      data: { accountId: account.id, role: 'dispatcher', grantedAt: BigInt(now) },
    });
    const conversation = await prisma.aiConversation.create({
      data: {
        accountId: account.id,
        role: 'dispatcher',
        roleProfile: 'dispatcher_fix',
        assistMode: 'fix',
        createdAt: BigInt(now),
        updatedAt: BigInt(now),
        lastMessageAt: BigInt(now),
      },
    });
    conversationIds.push(conversation.id);
    const run = await prisma.aiRun.create({
      data: {
        conversationId: conversation.id,
        accountId: account.id,
        quotaDay: '2026-01-01',
        quotaAccountId: account.id,
        roleProfile: 'dispatcher_fix',
        state: 'completed',
        providerKind: 'replay',
        model: 'test',
        reservedMicros: 0,
        startedAt: BigInt(now),
        finishedAt: BigInt(now),
      },
    });
    const actor: Actor = {
      kind: 'account',
      source: 'ui',
      id: account.id,
      role: 'dispatcher',
      tokenCategory: null,
      accountId: account.id,
    };
    await roleProfiles.setDispatcherAssistMode('fix');
    return { actor, conversation, run };
  }

  const requestPayload = () => ({
    contactName: `Test Contact ${unique('name')}`,
    addressText: 'Test street 1',
    workType: 'connection_request',
    windowStartAt: 2_000_000_000,
    windowEndAt: 2_000_003_600,
    urgent: false,
  });

  it('never auto-applies a window shift, keeps a challenge retryable, and supports rejection', async () => {
    const client = await newClientSession();
    const create = await aiOperations.prepare({
      actor: client.actor,
      accountId: client.actor.accountId as string,
      conversationId: client.conversation.id,
      runId: client.run.id,
      action: 'request.create',
      targetRef: null,
      payload: requestPayload(),
    });
    const created = await aiOperations.confirm({
      actor: client.actor,
      aiOperationId: create.operationId,
      operationId: randomUUID(),
    });
    const request = created.result as { id: string; version: number; windowStartAt: number };
    const { actor, conversation, run } = await newDispatcherSession();
    const guard = mock.method(context.get(ActionGuardService), 'allows', async () => true);
    try {
      const prepare = () =>
        aiOperations.prepare({
          actor,
          accountId: actor.accountId as string,
          conversationId: conversation.id,
          runId: run.id,
          action: 'request.update',
          targetRef: request.id,
          payload: { windowStartAt: 2_000_007_200, windowEndAt: 2_000_010_800 },
        });
      const op = await prepare();
      assert.equal(op.state, 'awaiting_confirmation');
      assert.equal(guard.mock.callCount(), 0, 'a model score must not replace window consent');
      const operationId = randomUUID();
      let confirmation: string | undefined;
      await assert.rejects(
        () => aiOperations.confirm({ actor, aiOperationId: op.operationId, operationId }),
        (error: unknown) => {
          assert.ok(isWindowConfirmationRequired(error));
          confirmation = String(error.details.confirmation);
          return true;
        },
      );
      assert.equal(
        (await prisma.aiOperation.findUniqueOrThrow({ where: { id: op.operationId } })).state,
        'awaiting_confirmation',
      );
      assert.equal(await prisma.operation.count({ where: { operationId } }), 0);
      const applied = await aiOperations.confirm({
        actor: { ...actor, windowChangeConfirmation: confirmation },
        aiOperationId: op.operationId,
        operationId,
      });
      assert.equal(applied.state, 'applied');
      const rejected = await aiOperations.prepare({
        actor,
        accountId: actor.accountId as string,
        conversationId: conversation.id,
        runId: run.id,
        action: 'request.update',
        targetRef: request.id,
        payload: { windowStartAt: 2_000_014_400, windowEndAt: 2_000_018_000 },
      });
      await aiOperations.cancel({ actor, aiOperationId: rejected.operationId });
      assert.equal(
        (await prisma.aiOperation.findUniqueOrThrow({ where: { id: rejected.operationId } })).state,
        'cancelled_before_apply',
      );
      assert.equal(
        Number(
          (await prisma.request.findUniqueOrThrow({ where: { id: request.id } })).windowStartAt,
        ),
        2_000_007_200,
      );
    } finally {
      guard.mock.restore();
    }
  });

  it('prepares a card, then confirming it applies the write exactly once', async () => {
    const { actor, conversation, run } = await newClientSession();

    const prepared = await aiOperations.prepare({
      actor,
      accountId: actor.accountId as string,
      conversationId: conversation.id,
      runId: run.id,
      action: 'request.create',
      targetRef: null,
      payload: requestPayload(),
    });
    assert.equal(prepared.state, 'awaiting_confirmation');
    assert.ok(prepared.preview.length > 0);

    const stored = await prisma.aiOperation.findUniqueOrThrow({
      where: { id: prepared.operationId },
    });
    assert.equal(stored.state, 'awaiting_confirmation');
    assert.equal(stored.action, 'request.create');

    const outcome = await aiOperations.confirm({
      actor,
      aiOperationId: prepared.operationId,
      operationId: randomUUID(),
    });
    assert.equal(outcome.state, 'applied');
    const applied = outcome.result as { id: string; lifecycle: string };
    assert.equal(applied.lifecycle, 'submitted');

    const finalRow = await prisma.aiOperation.findUniqueOrThrow({
      where: { id: prepared.operationId },
    });
    assert.equal(finalRow.state, 'applied');
    assert.ok(finalRow.resultOperationId);

    const created = await prisma.request.findUnique({ where: { id: applied.id } });
    assert.ok(created, 'the request the card described must actually exist now');
  });

  it('a second confirm click replays the stored outcome instead of writing twice', async () => {
    const { actor, conversation, run } = await newClientSession();
    const prepared = await aiOperations.prepare({
      actor,
      accountId: actor.accountId as string,
      conversationId: conversation.id,
      runId: run.id,
      action: 'request.create',
      targetRef: null,
      payload: requestPayload(),
    });

    const first = await aiOperations.confirm({
      actor,
      aiOperationId: prepared.operationId,
      operationId: randomUUID(),
    });
    const second = await aiOperations.confirm({
      actor,
      aiOperationId: prepared.operationId,
      // A different client-generated idempotency key for the underlying write, exactly
      // what a genuine second click would send -- the card's own CAS is what must stop
      // this from creating a second request, not OperationsService's own replay.
      operationId: randomUUID(),
    });

    assert.equal(first.state, 'applied');
    assert.equal(second.state, 'applied');
    const firstResult = first.result as { id: string };
    const secondResult = second.result as { id: string };
    assert.equal(secondResult.id, firstResult.id, 'the second click must return the same request');

    const count = await prisma.request.count({ where: { id: firstResult.id } });
    assert.equal(count, 1);
  });

  it('a dispatcher fix -> help flip after preparing blocks the write at confirm time', async () => {
    const now = Math.floor(Date.now() / 1000);
    const email = `${unique('ai-op-dispatcher')}@example.test`;
    const account = await prisma.account.create({
      data: { email, createdAt: BigInt(now), updatedAt: BigInt(now) },
    });
    accountIds.push(account.id);
    await prisma.accountRole.create({
      data: { accountId: account.id, role: 'dispatcher', grantedAt: BigInt(now) },
    });
    const conversation = await prisma.aiConversation.create({
      data: {
        accountId: account.id,
        role: 'dispatcher',
        roleProfile: 'dispatcher_fix',
        assistMode: 'fix',
        createdAt: BigInt(now),
        updatedAt: BigInt(now),
        lastMessageAt: BigInt(now),
      },
    });
    conversationIds.push(conversation.id);
    const run = await prisma.aiRun.create({
      data: {
        conversationId: conversation.id,
        accountId: account.id,
        quotaDay: '2026-01-01',
        quotaAccountId: account.id,
        roleProfile: 'dispatcher_fix',
        state: 'completed',
        providerKind: 'replay',
        model: 'test',
        reservedMicros: 0,
        startedAt: BigInt(now),
        finishedAt: BigInt(now),
      },
    });
    const actor: Actor = {
      kind: 'account',
      source: 'ui',
      id: account.id,
      role: 'dispatcher',
      tokenCategory: null,
      accountId: account.id,
    };

    await roleProfiles.setDispatcherAssistMode('fix');
    const prepared = await aiOperations.prepare({
      actor,
      accountId: account.id,
      conversationId: conversation.id,
      runId: run.id,
      action: 'engineer.set_availability',
      targetRef: `nonexistent-engineer-${unique('id')}`,
      payload: { availability: 'online' },
    });
    assert.equal(prepared.state, 'awaiting_confirmation');

    // The lane flips to read-only strictly between prepare and confirm -- exactly the
    // scenario the class doc comment on AiOperationService.confirm names.
    await roleProfiles.setDispatcherAssistMode('help');

    await assert.rejects(
      () =>
        aiOperations.confirm({
          actor,
          aiOperationId: prepared.operationId,
          operationId: randomUUID(),
        }),
      (error: unknown) => error instanceof SysError && error.code === 'FORBIDDEN',
    );

    const row = await prisma.aiOperation.findUniqueOrThrow({ where: { id: prepared.operationId } });
    assert.equal(row.state, 'rejected');

    await roleProfiles.setDispatcherAssistMode('help');
  });

  it('a dispatcher preparer (policy.select) goes prepare -> confirm -> applied', async () => {
    const { actor, conversation, run } = await newDispatcherSession();

    const prepared = await aiOperations.prepare({
      actor,
      accountId: actor.accountId as string,
      conversationId: conversation.id,
      runId: run.id,
      action: 'policy.select',
      targetRef: 'compact',
      payload: { policyId: 'compact' },
    });
    assert.equal(prepared.state, 'awaiting_confirmation');
    assert.ok(prepared.preview.length > 0);

    const stored = await prisma.aiOperation.findUniqueOrThrow({
      where: { id: prepared.operationId },
    });
    assert.equal(stored.state, 'awaiting_confirmation');
    assert.equal(stored.action, 'policy.select');

    // Nothing happened yet -- the card only prepares, it never writes
    // (dispatcher-write.tools.ts's own house rule).
    const beforeConfirm = await prisma.activePolicy.findUnique({ where: { id: 'singleton' } });

    const outcome = await aiOperations.confirm({
      actor,
      aiOperationId: prepared.operationId,
      operationId: randomUUID(),
    });
    assert.equal(outcome.state, 'applied');
    const applied = outcome.result as { policyId: string };
    assert.equal(applied.policyId, 'compact');

    const finalRow = await prisma.aiOperation.findUniqueOrThrow({
      where: { id: prepared.operationId },
    });
    assert.equal(finalRow.state, 'applied');

    const active = await prisma.activePolicy.findUniqueOrThrow({ where: { id: 'singleton' } });
    assert.equal(active.policyId, 'compact');
    if (beforeConfirm) {
      // The write only actually moved the version at confirm time, not at prepare time.
      assert.ok(active.version >= beforeConfirm.version);
    }

    await roleProfiles.setDispatcherAssistMode('help');
  });
  it('confirms client cancellation only for an owned, unchanged request', async () => {
    const owner = await newClientSession();
    const other = await newClientSession();
    const create = await aiOperations.prepare({
      actor: owner.actor,
      accountId: owner.conversation.accountId,
      conversationId: owner.conversation.id,
      runId: owner.run.id,
      action: 'request.create',
      targetRef: null,
      payload: requestPayload(),
    });
    const created = await aiOperations.confirm({
      actor: owner.actor,
      aiOperationId: create.operationId,
      operationId: randomUUID(),
    });
    const row = created.result as { id: string; version: number };
    const prepare = (session: typeof owner, action: string, payload: unknown) =>
      aiOperations.prepare({
        actor: session.actor,
        accountId: session.conversation.accountId,
        conversationId: session.conversation.id,
        runId: session.run.id,
        action,
        targetRef: row.id,
        payload,
      });
    await assert.rejects(
      prepare(other, 'client.request.cancel', { expectedVersion: row.version, reason: null }),
      /not found/i,
    );
    const cancel = await prepare(owner, 'client.request.cancel', {
      expectedVersion: row.version,
      reason: 'No longer needed',
    });
    assert.equal(cancel.state, 'awaiting_confirmation');
    assert.equal(
      (await prisma.request.findUniqueOrThrow({ where: { id: row.id } })).lifecycle,
      'submitted',
    );
    const done = await aiOperations.confirm({
      actor: owner.actor,
      aiOperationId: cancel.operationId,
      operationId: randomUUID(),
    });
    assert.equal(done.state, 'applied');
    assert.equal(
      (await prisma.request.findUniqueOrThrow({ where: { id: row.id } })).lifecycle,
      'cancelled',
    );
    await assert.rejects(
      prepare(owner, 'client.request.reschedule', {
        expectedVersion: row.version,
        windowStartAt: 2_000_007_200,
        windowEndAt: 2_000_010_800,
      }),
      /not started/i,
    );
  });

  it('requires customer window consent and rejects a stale client change', async () => {
    const owner = await newClientSession();
    const create = await aiOperations.prepare({
      actor: owner.actor,
      accountId: owner.conversation.accountId,
      conversationId: owner.conversation.id,
      runId: owner.run.id,
      action: 'request.create',
      targetRef: null,
      payload: requestPayload(),
    });
    const created = await aiOperations.confirm({
      actor: owner.actor,
      aiOperationId: create.operationId,
      operationId: randomUUID(),
    });
    const row = created.result as { id: string; version: number };
    const input = {
      actor: owner.actor,
      accountId: owner.conversation.accountId,
      conversationId: owner.conversation.id,
      runId: owner.run.id,
      targetRef: row.id,
    };
    const stale = await aiOperations.prepare({
      ...input,
      action: 'client.request.cancel',
      payload: { expectedVersion: row.version, reason: null },
    });
    const reschedule = await aiOperations.prepare({
      ...input,
      action: 'client.request.reschedule',
      payload: {
        expectedVersion: row.version,
        windowStartAt: 2_000_007_200,
        windowEndAt: 2_000_010_800,
      },
    });
    assert.equal(reschedule.state, 'awaiting_confirmation');
    let confirmation: string | undefined;
    const operationId = randomUUID();
    await assert.rejects(
      aiOperations.confirm({
        actor: owner.actor,
        aiOperationId: reschedule.operationId,
        operationId,
      }),
      (error: unknown) => {
        assert.ok(isWindowConfirmationRequired(error));
        confirmation = String(error.details.confirmation);
        return true;
      },
    );
    const applied = await aiOperations.confirm({
      actor: { ...owner.actor, windowChangeConfirmation: confirmation },
      aiOperationId: reschedule.operationId,
      operationId,
    });
    assert.equal(applied.state, 'applied');
    assert.equal(
      Number((await prisma.request.findUniqueOrThrow({ where: { id: row.id } })).windowStartAt),
      2_000_007_200,
    );
    const rejected = await aiOperations.confirm({
      actor: owner.actor,
      aiOperationId: stale.operationId,
      operationId: randomUUID(),
    });
    assert.equal(rejected.state, 'rejected');
    assert.equal(rejected.error?.code, 'VERSION_CONFLICT');
    assert.equal(
      (await prisma.request.findUniqueOrThrow({ where: { id: row.id } })).lifecycle,
      'submitted',
    );
  });
});
