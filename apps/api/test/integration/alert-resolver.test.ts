import '../support/env';

import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { RoleProfileService } from '../../src/ai';
import { AlertResolverService } from '../../src/ai/alerts';
import { AiOperationService } from '../../src/ai/operations';
import { ReplayProvider } from '../../src/ai/provider';
import { BudgetService, ConversationService } from '../../src/ai/runtime';
import { AppModule } from '../../src/app.module';
import type { Actor } from '../../src/auth';
import { AppConfigService } from '../../src/common/config';
import { Clock } from '../../src/common/time';
import type { PrismaClient } from '../../src/generated/prisma/client';
import { Prisma } from '../../src/generated/prisma/client';
import { PrismaService } from '../../src/persistence';
import { createTestClient, databaseUrl, unique } from '../support/database';

/**
 * A full `suggest -> prepared operation` pass, offline: a `ReplayProvider` constructed
 * directly with a forced scenario (bypassing `LLM_PROVIDER`/`AI_REPLAY_SCENARIO` env
 * selection, which only takes effect once per `NestFactory.createApplicationContext` and
 * is awkward to vary per test) returns the `propose_alert_resolution` tool call recorded
 * in `test/fixtures/ai/alert-resolver-keep-manual.json`. Every other dependency --
 * `PrismaService`, `ConversationService`, `BudgetService`, `AiOperationService` -- comes
 * from the real application context, so this still exercises the real schema validation,
 * precondition checks and `AiOperationService.prepare()` call against a real Postgres row,
 * with no network call to a real model (AGENTS.md section 4.7).
 */
describe('alert resolver: suggest -> prepared operation', () => {
  let context: INestApplicationContext;
  let prisma: PrismaClient;
  let resolver: AlertResolverService;
  let roleProfiles: RoleProfileService;
  const accountIds: string[] = [];
  const alertIds: string[] = [];
  const conversationIds: string[] = [];

  before(async () => {
    databaseUrl();
    prisma = createTestClient();
    await prisma.$connect();
    context = await NestFactory.createApplicationContext(AppModule, { logger: false });
    roleProfiles = context.get(RoleProfileService);
    const replay = new ReplayProvider(
      resolve(process.cwd(), 'test/fixtures/ai'),
      'alert-resolver-keep-manual',
      context.get(Clock),
    );
    resolver = new AlertResolverService(
      context.get(PrismaService),
      context.get(Clock),
      context.get(AppConfigService),
      context.get(ConversationService),
      context.get(BudgetService),
      context.get(AiOperationService),
      replay,
      null,
    );
  });

  after(async () => {
    await prisma.aiOperation.deleteMany({ where: { conversationId: { in: conversationIds } } });
    await prisma.aiRun.deleteMany({ where: { conversationId: { in: conversationIds } } });
    await prisma.aiConversation.deleteMany({ where: { id: { in: conversationIds } } });
    await prisma.alert.deleteMany({ where: { id: { in: alertIds } } });
    await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
    await roleProfiles.setDispatcherAssistMode('help');
    await prisma.$disconnect();
    await context?.close();
  });

  it('a valid keep_manual proposal is prepared as an alert.resolve operation', async () => {
    const now = Math.floor(Date.now() / 1000);
    const email = `${unique('alert-resolver')}@example.test`;
    const account = await prisma.account.create({
      data: { email, createdAt: BigInt(now), updatedAt: BigInt(now) },
    });
    accountIds.push(account.id);
    await prisma.accountRole.create({
      data: { accountId: account.id, role: 'dispatcher', grantedAt: BigInt(now) },
    });
    // `alert.resolve` is only offered to the `dispatcher_fix` lane (ai-action.catalog.ts).
    await roleProfiles.setDispatcherAssistMode('fix');

    const alert = await prisma.alert.create({
      data: {
        kind: 'alert',
        dedupKey: unique('alert-resolver-dedup'),
        code: 'plan_degraded',
        severity: 'warning',
        engineerIds: [],
        requestIds: [],
        reasons: { text: 'manual plan is worse by the active policy criterion' },
        restoreOption: Prisma.DbNull,
        isBlocking: true,
        createdAt: BigInt(now),
      },
    });
    alertIds.push(alert.id);

    const actor: Actor = {
      kind: 'account',
      source: 'ui',
      id: account.id,
      role: 'dispatcher',
      tokenCategory: null,
      accountId: account.id,
    };

    const outcome = await resolver.suggest(actor, alert.id);
    assert.equal(outcome.refused, false, outcome.refused ? outcome.why : undefined);
    if (outcome.refused) {
      return;
    }
    assert.equal(outcome.proposal.action, 'keep_manual');
    assert.ok(outcome.aiOperationId);

    const op = await prisma.aiOperation.findUniqueOrThrow({ where: { id: outcome.aiOperationId } });
    conversationIds.push(op.conversationId);
    assert.equal(op.action, 'alert.resolve');
    assert.equal(op.targetRef, alert.id);
    assert.equal(op.state, 'awaiting_confirmation');
    const payload = op.payload as { action: string; reason: string };
    assert.equal(payload.action, 'keep_manual');
    assert.ok(payload.reason.length >= 10);
  });

  it('a notice (no resolution action) is refused, never called against the model', async () => {
    const now = Math.floor(Date.now() / 1000);
    const alert = await prisma.alert.create({
      data: {
        kind: 'notice',
        dedupKey: unique('alert-resolver-notice'),
        code: 'plan_rebuilt',
        severity: 'info',
        engineerIds: [],
        requestIds: [],
        reasons: {},
        isBlocking: false,
        createdAt: BigInt(now),
      },
    });
    alertIds.push(alert.id);

    const actor: Actor = {
      kind: 'account',
      source: 'ui',
      id: 'nonexistent-account-for-refusal-test',
      role: 'dispatcher',
      tokenCategory: null,
      accountId: 'nonexistent-account-for-refusal-test',
    };
    const outcome = await resolver.suggest(actor, alert.id);
    assert.equal(outcome.refused, true);
    if (outcome.refused) {
      assert.match(outcome.why, /notice/i);
    }
  });
});
