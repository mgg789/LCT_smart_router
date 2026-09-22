import '../support/env';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { AllExceptionsFilter } from '../../src/common/errors';
import { BigIntGuardInterceptor } from '../../src/common/serialization';
import type { PrismaClient } from '../../src/generated/prisma/client';
import { createTestClient, databaseUrl, unique } from '../support/database';

interface ConversationBody {
  readonly id: string;
  readonly mode: string;
  readonly role: string;
  readonly roleProfile: string;
  readonly updatedAt: number;
}

interface MessageBody {
  readonly id: string;
  readonly author: string;
  readonly authorAccountId: string | null;
  readonly text: string;
}

interface HandoffBody {
  readonly id: string;
  readonly state: string;
  readonly firstReplyAt: number | null;
}

interface DispatchChatBody {
  readonly handoff: HandoffBody;
  readonly conversation: ConversationBody;
  readonly messages: MessageBody[];
}

interface ErrorBody {
  readonly error: { readonly code: string; readonly message: string };
}

/**
 * `/dispatch/chats*` — the dispatcher side of DF-19 -- over real HTTP against a real
 * Postgres, the same harness `live.test.ts` uses. A handoff is seeded directly with
 * Prisma, exactly what `call_dispatch_helper` (`src/ai/tools/handoff.tool.ts`) does
 * atomically: an `AiHandoff` row plus the conversation's `mode` flip. That tool's own
 * behaviour is covered elsewhere; this file only exercises the three endpoints that read
 * and end a handover already in progress.
 */
describe('dispatch chats: the dispatcher side of a handover', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let baseUrl: string;
  let dispatcherToken: string;
  let dispatcherAccountId: string;
  const emails: string[] = [];
  const conversationIds: string[] = [];

  const now = () => Math.floor(Date.now() / 1000);

  const call = (method: string, path: string, token: string, body?: unknown) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const signInClient = async (email: string) => {
    const issued = await fetch(`${baseUrl}/api/v1/auth/login-code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const { devCode } = (await issued.json()) as { devCode: string };
    const verified = await fetch(`${baseUrl}/api/v1/auth/login-code/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, code: devCode, role: 'client' }),
    });
    assert.equal(verified.status, 201, await verified.clone().text());
    return ((await verified.json()) as { token: string }).token;
  };

  /** Opens a real `client` conversation (through the same endpoint the web client uses),
   *  then seeds the handover exactly as `call_dispatch_helper` would: one open `AiHandoff`
   *  plus the conversation's atomic flip to `dispatcher` mode -- never through the tool
   *  itself, which is covered by its own tests. */
  const seedHandedOverChat = async (clientAccountId: string, clientToken: string) => {
    const opened = await call('POST', '/api/v1/ai/conversations', clientToken, {});
    assert.equal(opened.status, 201, await opened.clone().text());
    const conversation = ((await opened.json()) as { conversation: ConversationBody }).conversation;
    conversationIds.push(conversation.id);

    const seededAt = now();
    await prisma.aiMessage.create({
      data: {
        conversationId: conversation.id,
        seq: 1,
        author: 'user',
        kind: 'text',
        text: 'Когда приедет инженер?',
        actions: [],
        createdAt: BigInt(seededAt),
      },
    });
    await prisma.aiHandoff.create({
      data: {
        conversationId: conversation.id,
        requestedByAccountId: clientAccountId,
        actorRole: 'client',
        requestIds: [],
        engineerIds: [],
        state: 'waiting',
        createdAt: BigInt(seededAt),
      },
    });
    await prisma.aiConversation.update({
      where: { id: conversation.id },
      data: { mode: 'dispatcher', updatedAt: BigInt(seededAt), version: { increment: 1 } },
    });
    return conversation.id;
  };

  before(async () => {
    databaseUrl();
    prisma = createTestClient();
    await prisma.$connect();
    app = await NestFactory.create(AppModule, { logger: false });
    app.setGlobalPrefix('api/v1', { exclude: ['health/live', 'health/ready', 'health/services'] });
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new BigIntGuardInterceptor(true));
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

    const login = await fetch(`${baseUrl}/api/v1/auth/dispatcher/password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: process.env.DISPATCHER_EMAIL,
        password: process.env.DISPATCHER_PASSWORD,
      }),
    });
    assert.equal(login.status, 201, await login.clone().text());
    dispatcherToken = ((await login.json()) as { token: string }).token;
    const session = await call('GET', '/api/v1/auth/session', dispatcherToken);
    dispatcherAccountId = ((await session.json()) as { accountId: string }).accountId;
  });

  after(async () => {
    if (conversationIds.length > 0) {
      await prisma.aiHandoff.deleteMany({ where: { conversationId: { in: conversationIds } } });
      await prisma.aiMessage.deleteMany({ where: { conversationId: { in: conversationIds } } });
      await prisma.aiRun.deleteMany({ where: { conversationId: { in: conversationIds } } });
      await prisma.aiConversation.deleteMany({ where: { id: { in: conversationIds } } });
    }
    if (emails.length > 0) {
      await prisma.account.deleteMany({ where: { email: { in: emails } } });
    }
    await app.close();
    await prisma.$disconnect();
  });

  it('lists a handed-over chat as waiting, flips to answered on the first reply, and ignores a second one', async () => {
    const email = `${unique('dispatch-chat-client')}@example.test`;
    emails.push(email);
    const clientToken = await signInClient(email);
    const clientAccount = await prisma.account.findUniqueOrThrow({ where: { email } });

    const conversationId = await seedHandedOverChat(clientAccount.id, clientToken);

    const firstList = await call('GET', '/api/v1/dispatch/chats', dispatcherToken);
    assert.equal(firstList.status, 200, await firstList.clone().text());
    const firstChats = ((await firstList.json()) as { chats: DispatchChatBody[] }).chats;
    const listed = firstChats.find((chat) => chat.conversation.id === conversationId);
    assert.ok(listed, 'the seeded handover must appear in the dispatcher queue');
    assert.equal(listed?.handoff.state, 'waiting');
    assert.equal(listed?.handoff.firstReplyAt, null);
    assert.equal(listed?.messages.length, 1);
    assert.equal(listed?.messages[0]?.author, 'user');

    const firstReply = await call(
      'POST',
      `/api/v1/dispatch/chats/${conversationId}/messages`,
      dispatcherToken,
      { operationId: randomUUID(), text: 'Уже уточняю, минуту' },
    );
    assert.equal(firstReply.status, 201, await firstReply.clone().text());
    const firstReplyBody = (await firstReply.json()) as { message: MessageBody };
    assert.equal(firstReplyBody.message.author, 'dispatcher');
    assert.equal(firstReplyBody.message.authorAccountId, dispatcherAccountId);

    const afterFirstReply = await prisma.aiHandoff.findFirstOrThrow({
      where: { conversationId },
    });
    assert.equal(afterFirstReply.state, 'answered');
    assert.ok(afterFirstReply.firstReplyAt !== null);
    const firstReplyAt = afterFirstReply.firstReplyAt;

    // A dispatcher reply is a human answering, never a model call: no run and no budget
    // reservation this conversation's own quota would have to pay for.
    assert.equal(await prisma.aiRun.count({ where: { conversationId } }), 0);

    const secondReply = await call(
      'POST',
      `/api/v1/dispatch/chats/${conversationId}/messages`,
      dispatcherToken,
      { operationId: randomUUID(), text: 'Ещё раз: инженер будет через 20 минут' },
    );
    assert.equal(secondReply.status, 201, await secondReply.clone().text());

    const afterSecondReply = await prisma.aiHandoff.findFirstOrThrow({
      where: { conversationId },
    });
    assert.equal(afterSecondReply.state, 'answered');
    assert.equal(
      afterSecondReply.firstReplyAt,
      firstReplyAt,
      'a later reply must not move firstReplyAt again',
    );

    const secondList = await call('GET', '/api/v1/dispatch/chats', dispatcherToken);
    const secondChats = ((await secondList.json()) as { chats: DispatchChatBody[] }).chats;
    const stillListed = secondChats.find((chat) => chat.conversation.id === conversationId);
    assert.ok(stillListed, 'an answered-but-not-finished handover stays on the page');
    assert.equal(stillListed?.handoff.state, 'answered');
    assert.equal(stillListed?.messages.length, 3);
  });

  it('finish restores ai mode, keeps history, drops the chat from the list, and refuses a later reply', async () => {
    const email = `${unique('dispatch-chat-finish')}@example.test`;
    emails.push(email);
    const clientToken = await signInClient(email);
    const clientAccount = await prisma.account.findUniqueOrThrow({ where: { email } });

    const conversationId = await seedHandedOverChat(clientAccount.id, clientToken);
    await call('POST', `/api/v1/dispatch/chats/${conversationId}/messages`, dispatcherToken, {
      operationId: randomUUID(),
      text: 'Разбираюсь',
    });

    const finished = await call(
      'POST',
      `/api/v1/dispatch/chats/${conversationId}/finish`,
      dispatcherToken,
      { operationId: randomUUID() },
    );
    assert.equal(finished.status, 201, await finished.clone().text());
    const finishedBody = (await finished.json()) as { conversation: ConversationBody };
    assert.equal(finishedBody.conversation.mode, 'ai');

    const handoffRow = await prisma.aiHandoff.findFirstOrThrow({ where: { conversationId } });
    assert.equal(handoffRow.state, 'closed');
    assert.ok(handoffRow.closedAt !== null);
    assert.equal(handoffRow.closedByAccountId, dispatcherAccountId);

    // History is not deleted by closing the chat (context/36 §9.3).
    const history = await call(
      'GET',
      `/api/v1/ai/conversations/${conversationId}/messages`,
      clientToken,
    );
    assert.equal(history.status, 200, await history.clone().text());
    const historyBody = (await history.json()) as { messages: MessageBody[] };
    assert.equal(historyBody.messages.length, 2);

    const afterFinishList = await call('GET', '/api/v1/dispatch/chats', dispatcherToken);
    const afterFinishChats = ((await afterFinishList.json()) as { chats: DispatchChatBody[] })
      .chats;
    assert.equal(
      afterFinishChats.some((chat) => chat.conversation.id === conversationId),
      false,
      'a finished handover must not still be on the dispatcher page',
    );

    // A late reply from a stale dispatcher tab must not silently reopen the handover.
    const lateReply = await call(
      'POST',
      `/api/v1/dispatch/chats/${conversationId}/messages`,
      dispatcherToken,
      { operationId: randomUUID(), text: 'Слишком поздно' },
    );
    assert.equal(lateReply.status, 409, await lateReply.clone().text());
    const lateReplyBody = (await lateReply.json()) as ErrorBody;
    assert.equal(lateReplyBody.error.code, 'AI_HANDOFF_NOT_ACTIVE');

    const stillClosed = await prisma.aiHandoff.findFirstOrThrow({ where: { conversationId } });
    assert.equal(stillClosed.state, 'closed', 'the closed handoff must stay closed');
    const stillAiMode = await prisma.aiConversation.findUniqueOrThrow({
      where: { id: conversationId },
    });
    assert.equal(stillAiMode.mode, 'ai', 'the late reply must not reopen dispatcher mode');
  });

  it('refuses a reply to a conversation that was never handed to a dispatcher', async () => {
    const email = `${unique('dispatch-chat-never')}@example.test`;
    emails.push(email);
    const clientToken = await signInClient(email);

    const opened = await call('POST', '/api/v1/ai/conversations', clientToken, {});
    assert.equal(opened.status, 201, await opened.clone().text());
    const conversation = ((await opened.json()) as { conversation: ConversationBody }).conversation;
    conversationIds.push(conversation.id);
    assert.equal(conversation.mode, 'ai');

    const reply = await call(
      'POST',
      `/api/v1/dispatch/chats/${conversation.id}/messages`,
      dispatcherToken,
      { operationId: randomUUID(), text: 'Здравствуйте' },
    );
    assert.equal(reply.status, 409, await reply.clone().text());
    const replyBody = (await reply.json()) as ErrorBody;
    assert.equal(replyBody.error.code, 'AI_HANDOFF_NOT_ACTIVE');

    const chats = await call('GET', '/api/v1/dispatch/chats', dispatcherToken);
    const chatsBody = ((await chats.json()) as { chats: DispatchChatBody[] }).chats;
    assert.equal(
      chatsBody.some((chat) => chat.conversation.id === conversation.id),
      false,
      'an ordinary ai-mode conversation must never appear in the dispatcher queue',
    );
  });
});
