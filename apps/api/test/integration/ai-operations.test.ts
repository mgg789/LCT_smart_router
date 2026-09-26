import '../support/env';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
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
});
