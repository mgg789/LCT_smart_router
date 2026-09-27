import '../support/env';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { BudgetService } from '../../src/ai';
import { AppModule } from '../../src/app.module';
import { AppConfigService } from '../../src/common/config';
import { AllExceptionsFilter } from '../../src/common/errors';
import { BigIntGuardInterceptor } from '../../src/common/serialization';
import { FixedClock } from '../../src/common/time';
import type { PrismaClient } from '../../src/generated/prisma/client';
import type { PrismaService } from '../../src/persistence';
import { createTestClient, databaseUrl, unique } from '../support/database';

/**
 * Acceptance scenarios for the AI-gateway runtime and transport, run against the replay
 * provider (`test/support/env.ts` forces `LLM_PROVIDER=replay` and removes `LLM_TOKEN`,
 * so this suite can never reach a paid endpoint).
 */
describe('ai run', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let baseUrl: string;
  let clientToken: string;
  const emails: string[] = [];

  const call = async (method: string, path: string, token: string, body?: unknown) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const signIn = async (
    email: string,
    role: 'client' | 'dispatcher' = 'client',
  ): Promise<string> => {
    const codeResponse = await fetch(`${baseUrl}/api/v1/auth/login-code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const { devCode } = (await codeResponse.json()) as { devCode: string };
    const verify = await fetch(`${baseUrl}/api/v1/auth/login-code/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, code: devCode, role }),
    });
    assert.equal(verify.status, 201, await verify.clone().text());
    return ((await verify.json()) as { token: string }).token;
  };

  const openConversation = async (): Promise<string> => {
    const response = await call('POST', '/api/v1/ai/conversations', clientToken, {});
    assert.equal(response.status, 201, await response.clone().text());
    const body = (await response.json()) as { conversation: { id: string } };
    return body.conversation.id;
  };

  interface SseEvent {
    readonly event: string;
    readonly data: { readonly type: string; readonly seq: number; [key: string]: unknown };
  }

  /** Parses the whole SSE body at once: this transport always completes the HTTP
   *  response itself right after its terminal event (see `AiController.runEvents`), so
   *  there is no need to read it incrementally. */
  const parseSse = (body: string): SseEvent[] =>
    body
      .split('\n\n')
      .map((block) => block.trim())
      .filter((block) => block.length > 0)
      .map((block) => {
        const lines = block.split('\n');
        const eventLine = lines.find((line) => line.startsWith('event:'));
        const dataLine = lines.find((line) => line.startsWith('data:'));
        return {
          event: eventLine ? eventLine.slice('event:'.length).trim() : 'message',
          data: dataLine ? JSON.parse(dataLine.slice('data:'.length).trim()) : null,
        } as SseEvent;
      });

  const readEvents = async (runId: string, afterSeq: number): Promise<SseEvent[]> => {
    const response = await call(
      'GET',
      `/api/v1/ai/runs/${runId}/events?afterSeq=${afterSeq}`,
      clientToken,
    );
    assert.equal(response.status, 200, await response.clone().text());
    return parseSse(await response.text());
  };

  before(async () => {
    process.env.NODE_ENV = 'test';
    process.env.AUTH_DEV_EXPOSE_CODES = 'true';
    databaseUrl();
    prisma = createTestClient();
    await prisma.$connect();

    app = await NestFactory.create(AppModule, { logger: false });
    app.setGlobalPrefix('api/v1', {
      exclude: ['health/live', 'health/ready', 'health/services'],
    });
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new BigIntGuardInterceptor(true));
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

    const clientEmail = `${unique('ai-client')}@example.test`;
    emails.push(clientEmail);
    clientToken = await signIn(clientEmail);
  });

  after(async () => {
    if (emails.length > 0) {
      const accounts = await prisma.account.findMany({ where: { email: { in: emails } } });
      const accountIds = accounts.map((account) => account.id);
      if (accountIds.length > 0) {
        const conversations = await prisma.aiConversation.findMany({
          where: { accountId: { in: accountIds } },
        });
        const conversationIds = conversations.map((conversation) => conversation.id);
        const runs = await prisma.aiRun.findMany({
          where: { conversationId: { in: conversationIds } },
        });
        const runIds = runs.map((run) => run.id);
        await prisma.aiRunEvent.deleteMany({ where: { runId: { in: runIds } } });
        await prisma.aiRun.deleteMany({ where: { id: { in: runIds } } });
        await prisma.aiMessage.deleteMany({ where: { conversationId: { in: conversationIds } } });
        await prisma.aiConversation.deleteMany({ where: { id: { in: conversationIds } } });
        await prisma.aiBudget.deleteMany({ where: { accountId: { in: accountIds } } });
      }
      await prisma.account.deleteMany({ where: { email: { in: emails } } });
    }
    await prisma.$disconnect();
    await app?.close();
  });

  it('persists a run and its events, and afterSeq resumption returns exactly the missing tail', async () => {
    const conversationId = await openConversation();
    const sent = await call(
      'POST',
      `/api/v1/ai/conversations/${conversationId}/messages`,
      clientToken,
      {
        operationId: randomUUID(),
        // Matches test/fixtures/ai/d9a5306e9b03ecdc.json.
        text: 'Hello, can you help me?',
      },
    );
    assert.equal(sent.status, 201, await sent.clone().text());
    const sentBody = (await sent.json()) as { runId: string | null; handedOver: boolean };
    assert.equal(sentBody.handedOver, false);
    assert.ok(sentBody.runId);
    const runId = sentBody.runId as string;

    const events = await readEvents(runId, 0);
    assert.ok(events.length >= 4, `expected several events, got ${events.length}`);
    assert.equal(events[0]?.event, 'run_started');
    assert.equal(events.at(-1)?.event, 'run_finished');
    assert.equal(events.at(-1)?.data.state, 'completed');

    // seq is strictly increasing across the whole run, deltas included.
    const seqs = events.map((event) => event.data.seq);
    for (let i = 1; i < seqs.length; i += 1) {
      assert.ok(
        (seqs[i] as number) > (seqs[i - 1] as number),
        `seq did not increase at index ${i}`,
      );
    }

    // Every persisted type actually reached the database (deltas are the one exception).
    const stored = await prisma.aiRunEvent.findMany({ where: { runId }, orderBy: { seq: 'asc' } });
    assert.ok(stored.length > 0);
    assert.ok(
      stored.every((row) => row.type !== 'message_delta'),
      'message_delta must never be persisted',
    );
    assert.equal(stored[0]?.type, 'run_started');
    assert.equal(stored.at(-1)?.type, 'run_finished');

    // Resuming from just before the last stored seq returns exactly that one event.
    const lastStoredSeq = stored.at(-1)?.seq as number;
    const tail = await readEvents(runId, lastStoredSeq - 1);
    assert.equal(tail.length, 1);
    assert.equal(tail[0]?.event, 'run_finished');

    // Resuming from the very end returns nothing.
    const empty = await readEvents(runId, lastStoredSeq);
    assert.equal(empty.length, 0);

    const run = await prisma.aiRun.findUniqueOrThrow({ where: { id: runId } });
    assert.equal(run.state, 'completed');
    assert.equal(run.providerKind, 'replay');
  });

  it('keeps a one-shot plan explanation out of the dispatcher chat', async () => {
    const now = BigInt(Math.floor(Date.now() / 1000));
    const email = `${unique('ai-explain-dispatcher')}@example.test`;
    emails.push(email);
    const account = await prisma.account.create({
      data: { email, createdAt: now, updatedAt: now },
    });
    await prisma.accountRole.create({
      data: { accountId: account.id, role: 'dispatcher', grantedAt: now },
    });
    const token = await signIn(email, 'dispatcher');
    const open = await call('POST', '/api/v1/ai/conversations', token, {});
    assert.equal(open.status, 201, await open.clone().text());
    const chatId = ((await open.json()) as { conversation: { id: string } }).conversation.id;

    const explained = await call('POST', '/api/v1/ai/explain', token, { scope: 'plan' });
    assert.equal(explained.status, 201, await explained.clone().text());
    const { runId } = (await explained.json()) as { runId: string };
    const run = await prisma.aiRun.findUniqueOrThrow({ where: { id: runId } });
    const serviceConversation = await prisma.aiConversation.findUniqueOrThrow({
      where: { id: run.conversationId },
    });
    assert.notEqual(serviceConversation.id, chatId);
    assert.notEqual(serviceConversation.closedAt, null);
    assert.equal(await prisma.aiMessage.count({ where: { conversationId: chatId } }), 0);

    const stream = await call('GET', `/api/v1/ai/runs/${runId}/events?afterSeq=0`, token);
    assert.equal(stream.status, 200, await stream.clone().text());
    assert.match(await stream.text(), /run_finished/);
  });

  it('ends a run that cannot finish within its tool-step budget with a terminal error event, not a thrown request', async () => {
    const conversationId = await openConversation();
    const sent = await call(
      'POST',
      `/api/v1/ai/conversations/${conversationId}/messages`,
      clientToken,
      {
        operationId: randomUUID(),
        // Matches test/fixtures/ai/9739c6034c03110e.json: always returns a tool call, and
        // the default NoopToolDispatcher never satisfies one, so the loop exhausts
        // LLM_MAX_TOOL_STEPS.
        text: 'please keep calling a tool forever',
      },
    );
    assert.equal(sent.status, 201, await sent.clone().text());
    const runId = ((await sent.json()) as { runId: string }).runId;

    const events = await readEvents(runId, 0);
    const errorEvent = events.find((event) => event.event === 'error');
    assert.ok(errorEvent, 'expected a terminal error event instead of a thrown exception');
    const finished = events.at(-1);
    assert.equal(finished?.event, 'run_finished');
    assert.equal(finished?.data.state, 'failed');

    const run = await prisma.aiRun.findUniqueOrThrow({ where: { id: runId } });
    assert.equal(run.state, 'failed');
    assert.ok(run.errorCode);
  });

  it('allows exactly one of two concurrent budget reservations against a limit of one', async () => {
    const email = `${unique('ai-budget')}@example.test`;
    emails.push(email);
    const now = BigInt(Math.floor(Date.now() / 1000));
    const account = await prisma.account.create({
      data: { email, createdAt: now, updatedAt: now },
    });

    const clock = new FixedClock(Math.floor(Date.now() / 1000));
    const fakeConfig = {
      get: (key: string) => {
        switch (key) {
          case 'AI_DAILY_MESSAGE_LIMIT':
            return 1;
          case 'AI_DAILY_COST_LIMIT_MICROS':
            return 1_000_000;
          case 'AI_TOTAL_COST_LIMIT_MICROS':
            return 1_000_000;
          case 'AI_RUN_ESTIMATE_MICROS':
            return 1_000;
          case 'APP_TIME_ZONE':
            return 'Europe/Moscow';
          default:
            throw new Error(`unexpected config key in test: ${key}`);
        }
      },
    } as unknown as AppConfigService;
    const budgets = new BudgetService(prisma as unknown as PrismaService, clock, fakeConfig);

    const results = await Promise.allSettled([
      budgets.reserve(account.id),
      budgets.reserve(account.id),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    assert.equal(fulfilled.length, 1, 'exactly one concurrent reservation should succeed');
    assert.equal(rejected.length, 1);
    const rejection = rejected[0] as PromiseRejectedResult;
    assert.match(String(rejection.reason), /AI_QUOTA_EXHAUSTED|quota/i);

    await prisma.aiBudget.deleteMany({ where: { accountId: account.id } });
  });

  it('refuses the first run of a new day once the lifetime cost cap is already spent', async () => {
    // Regression. `ON CONFLICT ... DO UPDATE ... WHERE` guards only the update branch, so
    // a reservation for a (day, account) that has no row yet used to insert unconditionally
    // and skip every limit. Yesterday's spending exhausting the lifetime cap therefore
    // bought one free run each morning -- precisely the guard a small fixed budget rests on.
    const email = `${unique('ai-budget-carryover')}@example.test`;
    emails.push(email);
    const now = BigInt(Math.floor(Date.now() / 1000));
    const account = await prisma.account.create({
      data: { email, createdAt: now, updatedAt: now },
    });

    const clock = new FixedClock(Math.floor(Date.now() / 1000));
    const fakeConfig = {
      get: (key: string) => {
        switch (key) {
          case 'AI_DAILY_MESSAGE_LIMIT':
            return 100;
          case 'AI_DAILY_COST_LIMIT_MICROS':
            return 1_000_000;
          case 'AI_TOTAL_COST_LIMIT_MICROS':
            return 10_000;
          case 'AI_RUN_ESTIMATE_MICROS':
            return 1_000;
          case 'APP_TIME_ZONE':
            return 'Europe/Moscow';
          default:
            throw new Error(`unexpected config key in test: ${key}`);
        }
      },
    } as unknown as AppConfigService;
    const budgets = new BudgetService(prisma as unknown as PrismaService, clock, fakeConfig);

    // An earlier day that already consumed the whole lifetime allowance. Today has no row.
    await prisma.aiBudget.create({
      data: {
        quotaDay: '2020-01-01',
        accountId: account.id,
        reservedMicros: 0,
        settledMicros: 10_000,
        messageCount: 1,
        updatedAt: now,
      },
    });

    await assert.rejects(
      () => budgets.reserve(account.id),
      /AI_QUOTA_EXHAUSTED|quota/i,
      'a spent lifetime cap must also refuse the first reservation of a fresh day',
    );
    const todayRows = await prisma.aiBudget.count({
      where: { accountId: account.id, quotaDay: budgets.quotaDayFor(clock.nowSeconds()) },
    });
    assert.equal(todayRows, 0, 'a refused reservation must not leave a row behind');

    await prisma.aiBudget.deleteMany({ where: { accountId: account.id } });
  });
});
