import '../support/env';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ToolRegistry } from '../../src/ai/tools/tool.registry';
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
  readonly seq: number;
  readonly author: string;
  readonly authorAccountId: string | null;
  readonly text: string;
}

interface HandoffBody {
  readonly id: string;
  readonly state: string;
  readonly initiatedBy: string;
  readonly firstReplyAt: number | null;
  readonly endSeq: number | null;
}

interface DispatchChatBody {
  readonly handoff: HandoffBody;
  readonly conversation: ConversationBody;
  readonly messages: MessageBody[];
  readonly unreadCount: number;
}

interface SendMessageBody {
  readonly runId: string | null;
  readonly messageSeq: number;
  readonly handedOver: boolean;
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
  const requestIds: string[] = [];
  const engineerIds: string[] = [];

  // Unique per row so parallel test files (and parallel `it`s in this one) never collide
  // on the non-unique `arrivalOrder`/`inputOrder` columns.
  let sequenceCounter = 0;
  const nextSequence = () => {
    sequenceCounter += 1;
    return 700_000 + sequenceCounter;
  };

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

  /** Signs a role in the login-code way, but for any role -- `signInClient` above only
   *  ever asks for `client`. An `engineer` login only succeeds once the role is already
   *  granted (`AuthService.verifyLoginCode`'s own comment on why), which every caller here
   *  satisfies by creating the `Engineer` row (and its account role) first. */
  const signInAs = async (email: string, role: 'client' | 'engineer'): Promise<string> => {
    const issued = await fetch(`${baseUrl}/api/v1/auth/login-code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const { devCode } = (await issued.json()) as { devCode: string };
    const verified = await fetch(`${baseUrl}/api/v1/auth/login-code/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, code: devCode, role }),
    });
    assert.equal(verified.status, 201, await verified.clone().text());
    return ((await verified.json()) as { token: string }).token;
  };

  /** A request reachable through the dashboard's "chat with this client" button: seeded
   *  directly with Prisma (never through `/dispatch/requests`, whose own validation is
   *  covered by `requests.test.ts`) since target resolution only ever reads `clientAccountId`
   *  and never checks lifecycle. Omitting `clientAccountId` produces the unreachable case. */
  const createRequestRow = async (clientAccountId?: string) => {
    const at = now();
    const request = await prisma.request.create({
      data: {
        arrivalOrder: nextSequence(),
        addressText: 'Москва, ул. Тестовая, д. 10',
        needsGeocoding: false,
        lat: 55.75,
        lon: 37.61,
        normProfileCode: 'local',
        normativeTravelDurationSec: 600,
        technicalDurationSec: 600,
        documentationDurationSec: 300,
        serviceDurationSec: 900,
        windowStartAt: BigInt(at + 300),
        windowEndAt: BigInt(at + 3_600),
        requiredSkill: 'connection',
        origin: 'manual',
        contactName: 'Тестовый клиент',
        createdAt: BigInt(at),
        updatedAt: BigInt(at),
        ...(clientAccountId ? { clientAccountId } : {}),
      },
    });
    requestIds.push(request.id);
    return request;
  };

  /** An engineer reachable through "chat with this engineer": a bare profile row, exactly
   *  what a request or an engineer imported without a login looks like when `accountId` is
   *  omitted (context/37 section 3.1). */
  const createEngineerRow = async (accountId?: string) => {
    const at = BigInt(now());
    const engineer = await prisma.engineer.create({
      data: {
        displayName: 'Тестовый инженер',
        inputOrder: nextSequence(),
        skills: ['connection'],
        transportType: 'car',
        origin: 'manual',
        createdAt: at,
        updatedAt: at,
        ...(accountId ? { accountId } : {}),
      },
    });
    engineerIds.push(engineer.id);
    return engineer;
  };

  /** An engineer with a real login, for the `engineer`-target half of the dashboard's chat
   *  button: the account and its role must exist before `signInAs` can issue a token
   *  (`AuthService.verifyLoginCode`'s own comment on why). */
  const createEngineerWithAccount = async () => {
    const email = `${unique('dispatch-chat-engineer')}@example.test`;
    emails.push(email);
    const at = BigInt(now());
    const account = await prisma.account.create({
      data: { email, createdAt: at, updatedAt: at },
    });
    await prisma.accountRole.create({
      data: { accountId: account.id, role: 'engineer', grantedAt: at },
    });
    const engineer = await createEngineerRow(account.id);
    const token = await signInAs(email, 'engineer');
    return { email, accountId: account.id, engineer, token };
  };

  const openChat = (target: unknown, text?: string) =>
    call('POST', '/api/v1/dispatch/chats', dispatcherToken, {
      operationId: randomUUID(),
      target,
      ...(text === undefined ? {} : { text }),
    });

  const sendDispatcherReply = (conversationId: string, text: string, operationId = randomUUID()) =>
    call('POST', `/api/v1/dispatch/chats/${conversationId}/messages`, dispatcherToken, {
      operationId,
      text,
    });

  const finishChat = (conversationId: string, operationId = randomUUID()) =>
    call('POST', `/api/v1/dispatch/chats/${conversationId}/finish`, dispatcherToken, {
      operationId,
    });

  const readChat = (conversationId: string, seq: number, operationId = randomUUID()) =>
    call('POST', `/api/v1/dispatch/chats/${conversationId}/read`, dispatcherToken, {
      operationId,
      seq,
    });

  const listChats = () => call('GET', '/api/v1/dispatch/chats', dispatcherToken);

  const sendClientMessage = (token: string, conversationId: string, text: string) =>
    call('POST', `/api/v1/ai/conversations/${conversationId}/messages`, token, {
      operationId: randomUUID(),
      text,
    });

  const findChat = (chats: DispatchChatBody[], conversationId: string) =>
    chats.find((chat) => chat.conversation.id === conversationId);

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
    if (engineerIds.length > 0) {
      await prisma.engineer.deleteMany({ where: { id: { in: engineerIds } } });
    }
    if (requestIds.length > 0) {
      await prisma.request.deleteMany({ where: { id: { in: requestIds } } });
    }
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

  it('finish restores ai mode, keeps history, keeps the closed chat listed, and refuses a later reply', async () => {
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

    // History is not deleted by closing the chat (context/36 §9.3): the seeded question
    // and the dispatcher's reply stay. Closing writes no system note.
    const history = await call(
      'GET',
      `/api/v1/ai/conversations/${conversationId}/messages`,
      clientToken,
    );
    assert.equal(history.status, 200, await history.clone().text());
    const historyBody = (await history.json()) as { messages: MessageBody[] };
    assert.equal(historyBody.messages.length, 2);

    // A finished chat keeps hanging in the list -- ending a handover is not deleting it
    // (context/36 §9.3), and this is what lets the dispatcher re-read what was agreed.
    const afterFinishList = await call('GET', '/api/v1/dispatch/chats', dispatcherToken);
    const afterFinishChats = ((await afterFinishList.json()) as { chats: DispatchChatBody[] })
      .chats;
    const closedChat = afterFinishChats.find((chat) => chat.conversation.id === conversationId);
    assert.ok(closedChat, 'a finished handover stays on the dispatcher page');
    assert.equal(closedChat?.handoff.state, 'closed');
    assert.equal(closedChat?.unreadCount, 0, 'a finished chat never badges');

    // Sending after the assistant took the chat back joins the same dialogue again.
    const lateReply = await call(
      'POST',
      `/api/v1/dispatch/chats/${conversationId}/messages`,
      dispatcherToken,
      { operationId: randomUUID(), text: 'Снова на связи' },
    );
    assert.equal(lateReply.status, 201, await lateReply.clone().text());
    const rejoined = await prisma.aiConversation.findUniqueOrThrow({
      where: { id: conversationId },
    });
    assert.equal(rejoined.mode, 'dispatcher', 'a sent message is what rejoins the chat');
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

  it("opens a chat with a request's client when the dispatcher sends text, and a second press does not duplicate it", async () => {
    const email = `${unique('dispatch-chat-open-req')}@example.test`;
    emails.push(email);
    // Only the account matters here, not a token to act as it.
    await signInClient(email);
    const clientAccount = await prisma.account.findUniqueOrThrow({ where: { email } });
    const request = await createRequestRow(clientAccount.id);

    const opened = await openChat(
      { kind: 'request', requestId: request.id },
      'Добрый день, уточняю по заявке',
    );
    assert.equal(opened.status, 201, await opened.clone().text());
    const chat = ((await opened.json()) as { chat: DispatchChatBody }).chat;
    conversationIds.push(chat.conversation.id);

    assert.equal(chat.handoff.initiatedBy, 'dispatcher');
    assert.equal(chat.conversation.mode, 'dispatcher');
    assert.equal(chat.messages.length, 1, 'only the opening text — looking does not write a system line');
    assert.equal(chat.messages[0]?.author, 'dispatcher');
    assert.equal(chat.messages[0]?.text, 'Добрый день, уточняю по заявке');

    // The dialogue is the client's own conversation -- not a second, parallel thread.
    const storedConversation = await prisma.aiConversation.findUniqueOrThrow({
      where: { id: chat.conversation.id },
    });
    assert.equal(storedConversation.accountId, clientAccount.id);
    assert.equal(storedConversation.role, 'client');

    // Pressing the button again is not an error and must not open a second handover or
    // repeat the joined message.
    const openedAgain = await openChat({ kind: 'request', requestId: request.id });
    assert.equal(openedAgain.status, 201, await openedAgain.clone().text());
    const chatAgain = ((await openedAgain.json()) as { chat: DispatchChatBody }).chat;
    assert.equal(
      chatAgain.handoff.id,
      chat.handoff.id,
      'the running handover is returned, not a new one',
    );
    assert.equal(chatAgain.messages.length, 1, 'no duplicate opening text on a second press');

    const openHandoverCount = await prisma.aiHandoff.count({
      where: { conversationId: chat.conversation.id, state: { not: 'closed' } },
    });
    assert.equal(openHandoverCount, 1);
  });

  it('opens a chat with an engineer, addressed by engineerId', async () => {
    const { accountId, engineer } = await createEngineerWithAccount();

    const looked = await openChat({ kind: 'engineer', engineerId: engineer.id });
    assert.equal(looked.status, 201, await looked.clone().text());
    const lookedBody = (await looked.json()) as { chat: DispatchChatBody | null };
    assert.equal(lookedBody.chat, null, 'opening the row without a message does not join the chat');

    const opened = await openChat(
      { kind: 'engineer', engineerId: engineer.id },
      'Добрый день',
    );
    assert.equal(opened.status, 201, await opened.clone().text());
    const chat = ((await opened.json()) as { chat: DispatchChatBody }).chat;
    conversationIds.push(chat.conversation.id);

    assert.equal(chat.handoff.initiatedBy, 'dispatcher');
    assert.equal(chat.conversation.mode, 'dispatcher');
    assert.equal(chat.messages.length, 1);
    assert.equal(chat.messages[0]?.author, 'dispatcher');
    assert.equal(chat.messages[0]?.text, 'Добрый день');

    const storedConversation = await prisma.aiConversation.findUniqueOrThrow({
      where: { id: chat.conversation.id },
    });
    assert.equal(storedConversation.accountId, accountId);
    assert.equal(storedConversation.role, 'engineer');
  });

  it("a client's message while handed over starts no run, spends no budget, and flips the chat back to waiting", async () => {
    const email = `${unique('dispatch-chat-no-run')}@example.test`;
    emails.push(email);
    const clientToken = await signInClient(email);
    const clientAccount = await prisma.account.findUniqueOrThrow({ where: { email } });
    const request = await createRequestRow(clientAccount.id);

    const opened = await openChat({ kind: 'request', requestId: request.id }, 'Здравствуйте');
    const chat = ((await opened.json()) as { chat: DispatchChatBody }).chat;
    conversationIds.push(chat.conversation.id);
    assert.equal(
      chat.handoff.state,
      'answered',
      'nobody is waiting on the dispatcher in a chat they just opened themselves',
    );

    const sent = await sendClientMessage(clientToken, chat.conversation.id, 'А когда именно?');
    assert.equal(sent.status, 201, await sent.clone().text());
    const sentBody = (await sent.json()) as SendMessageBody;
    assert.equal(sentBody.runId, null);
    assert.equal(sentBody.handedOver, true);

    assert.equal(
      await prisma.aiRun.count({ where: { conversationId: chat.conversation.id } }),
      0,
      'a message into a handed-over dialogue must never reserve budget for a model call',
    );

    const handoffRow = await prisma.aiHandoff.findUniqueOrThrow({ where: { id: chat.handoff.id } });
    assert.equal(handoffRow.state, 'waiting');
  });

  it("the dispatcher's reply is attributed to them, moves the chat to answered, stamps firstReplyAt once, and clears the unread badge", async () => {
    const email = `${unique('dispatch-chat-reply')}@example.test`;
    emails.push(email);
    const clientToken = await signInClient(email);
    const clientAccount = await prisma.account.findUniqueOrThrow({ where: { email } });
    const request = await createRequestRow(clientAccount.id);

    const opened = await openChat({ kind: 'request', requestId: request.id }, 'Здравствуйте');
    const chat = ((await opened.json()) as { chat: DispatchChatBody }).chat;
    conversationIds.push(chat.conversation.id);

    await sendClientMessage(clientToken, chat.conversation.id, 'Есть новости?');
    const listAfterClient = await listChats();
    const listedAfterClient = findChat(
      ((await listAfterClient.json()) as { chats: DispatchChatBody[] }).chats,
      chat.conversation.id,
    );
    assert.equal(listedAfterClient?.unreadCount, 1);

    const firstReply = await sendDispatcherReply(chat.conversation.id, 'Да, инженер выехал');
    assert.equal(firstReply.status, 201, await firstReply.clone().text());
    const firstReplyBody = (await firstReply.json()) as {
      message: MessageBody;
      chat: DispatchChatBody;
    };
    assert.equal(firstReplyBody.message.author, 'dispatcher');
    assert.equal(firstReplyBody.message.authorAccountId, dispatcherAccountId);
    assert.equal(firstReplyBody.chat.handoff.state, 'answered');
    assert.equal(firstReplyBody.chat.unreadCount, 0, 'replying is itself the acknowledgement');
    const firstReplyAt = firstReplyBody.chat.handoff.firstReplyAt;
    assert.ok(firstReplyAt !== null);

    const secondReply = await sendDispatcherReply(chat.conversation.id, 'Будет через 15 минут');
    assert.equal(secondReply.status, 201, await secondReply.clone().text());
    const secondReplyBody = (await secondReply.json()) as { chat: DispatchChatBody };
    assert.equal(
      secondReplyBody.chat.handoff.firstReplyAt,
      firstReplyAt,
      'a later reply must not move firstReplyAt again',
    );
  });

  it('finish returns the conversation to ai mode and closes the handover; the chat stays listed as closed with no badge, and a later message starts a new run', async () => {
    const email = `${unique('dispatch-chat-finish2')}@example.test`;
    emails.push(email);
    const clientToken = await signInClient(email);
    const clientAccount = await prisma.account.findUniqueOrThrow({ where: { email } });
    const request = await createRequestRow(clientAccount.id);

    const opened = await openChat({ kind: 'request', requestId: request.id }, 'Слушаю вас');
    const chat = ((await opened.json()) as { chat: DispatchChatBody }).chat;
    conversationIds.push(chat.conversation.id);

    const finished = await finishChat(chat.conversation.id);
    assert.equal(finished.status, 201, await finished.clone().text());
    const finishedBody = (await finished.json()) as {
      conversation: ConversationBody;
      chat: DispatchChatBody;
    };
    assert.equal(finishedBody.conversation.mode, 'ai');
    assert.equal(finishedBody.chat.handoff.state, 'closed');
    assert.ok(finishedBody.chat.handoff.endSeq !== null);

    const afterFinishList = await listChats();
    const listedClosed = findChat(
      ((await afterFinishList.json()) as { chats: DispatchChatBody[] }).chats,
      chat.conversation.id,
    );
    assert.ok(
      listedClosed,
      'a finished chat stays on the dispatcher page -- this is the point of the feature',
    );
    assert.equal(listedClosed?.handoff.state, 'closed');
    assert.equal(listedClosed?.unreadCount, 0);

    const sentAgain = await sendClientMessage(
      clientToken,
      chat.conversation.id,
      'Ещё вопрос ассистенту',
    );
    assert.equal(sentAgain.status, 201, await sentAgain.clone().text());
    const sentAgainBody = (await sentAgain.json()) as SendMessageBody;
    assert.equal(sentAgainBody.handedOver, false);
    assert.ok(sentAgainBody.runId, 'the assistant takes the dialogue back and answers again');
  });

  it('a second message after finish opens a new handover on the same dialogue, and the list keeps one row', async () => {
    const email = `${unique('dispatch-chat-reescalate')}@example.test`;
    emails.push(email);
    // Only the account matters here, not a token to act as it.
    await signInClient(email);
    const clientAccount = await prisma.account.findUniqueOrThrow({ where: { email } });
    const request = await createRequestRow(clientAccount.id);

    const firstOpen = await openChat({ kind: 'request', requestId: request.id }, 'Первый раз');
    const firstChat = ((await firstOpen.json()) as { chat: DispatchChatBody }).chat;
    conversationIds.push(firstChat.conversation.id);
    await finishChat(firstChat.conversation.id);

    const secondOpen = await openChat(
      { kind: 'request', requestId: request.id },
      'Снова нужна помощь',
    );
    assert.equal(secondOpen.status, 201, await secondOpen.clone().text());
    const secondChat = ((await secondOpen.json()) as { chat: DispatchChatBody }).chat;
    assert.notEqual(secondChat.handoff.id, firstChat.handoff.id);
    assert.equal(
      secondChat.conversation.id,
      firstChat.conversation.id,
      'the same dialogue, not a new one',
    );
    assert.equal(secondChat.handoff.state, 'answered');

    const list = await listChats();
    const chats = ((await list.json()) as { chats: DispatchChatBody[] }).chats;
    const rowsForThisConversation = chats.filter(
      (row) => row.conversation.id === firstChat.conversation.id,
    );
    assert.equal(rowsForThisConversation.length, 1, 'one person is one chat');
    assert.equal(rowsForThisConversation[0]?.handoff.id, secondChat.handoff.id);
  });

  it('refuses to finish a conversation that was never handed to a dispatcher', async () => {
    const email = `${unique('dispatch-chat-finish-never')}@example.test`;
    emails.push(email);
    const clientToken = await signInClient(email);
    const opened = await call('POST', '/api/v1/ai/conversations', clientToken, {});
    const conversation = ((await opened.json()) as { conversation: ConversationBody }).conversation;
    conversationIds.push(conversation.id);

    const finish = await finishChat(conversation.id);
    assert.equal(finish.status, 409, await finish.clone().text());
    const body = (await finish.json()) as ErrorBody;
    assert.equal(body.error.code, 'AI_HANDOFF_NOT_ACTIVE');
  });

  it('refuses to open a chat with an unreachable target -- a request with no client account, or an engineer with no login -- as a conflict, not a 404', async () => {
    const requestWithNoClient = await createRequestRow();
    const engineerWithNoAccount = await createEngineerRow();

    const byRequest = await openChat({ kind: 'request', requestId: requestWithNoClient.id });
    assert.equal(byRequest.status, 409, await byRequest.clone().text());
    assert.equal(((await byRequest.json()) as ErrorBody).error.code, 'CHAT_TARGET_UNREACHABLE');

    const byEngineer = await openChat({ kind: 'engineer', engineerId: engineerWithNoAccount.id });
    assert.equal(byEngineer.status, 409, await byEngineer.clone().text());
    assert.equal(((await byEngineer.json()) as ErrorBody).error.code, 'CHAT_TARGET_UNREACHABLE');
  });

  it("a client's token is refused on every dispatcher chat endpoint", async () => {
    const email = `${unique('dispatch-chat-client-token')}@example.test`;
    emails.push(email);
    const clientToken = await signInClient(email);
    const request = await createRequestRow();

    const list = await call('GET', '/api/v1/dispatch/chats', clientToken);
    assert.equal(list.status, 403);

    const open = await call('POST', '/api/v1/dispatch/chats', clientToken, {
      operationId: randomUUID(),
      target: { kind: 'request', requestId: request.id },
    });
    assert.equal(open.status, 403);

    const reply = await call(
      'POST',
      `/api/v1/dispatch/chats/${randomUUID()}/messages`,
      clientToken,
      { operationId: randomUUID(), text: 'x' },
    );
    assert.equal(reply.status, 403);

    const finish = await call(
      'POST',
      `/api/v1/dispatch/chats/${randomUUID()}/finish`,
      clientToken,
      { operationId: randomUUID() },
    );
    assert.equal(finish.status, 403);

    const read = await call('POST', `/api/v1/dispatch/chats/${randomUUID()}/read`, clientToken, {
      operationId: randomUUID(),
      seq: 1,
    });
    assert.equal(read.status, 403);
  });

  it('replaying the same operationId on a reply returns the first outcome and writes no second message', async () => {
    const email = `${unique('dispatch-chat-idem')}@example.test`;
    emails.push(email);
    await signInClient(email);
    const clientAccount = await prisma.account.findUniqueOrThrow({ where: { email } });
    const request = await createRequestRow(clientAccount.id);

    const opened = await openChat({ kind: 'request', requestId: request.id }, 'Здравствуйте');
    const chat = ((await opened.json()) as { chat: DispatchChatBody }).chat;
    conversationIds.push(chat.conversation.id);

    const operationId = randomUUID();
    const first = await sendDispatcherReply(
      chat.conversation.id,
      'Одна и та же реплика',
      operationId,
    );
    assert.equal(first.status, 201, await first.clone().text());
    const firstBody = (await first.json()) as { message: MessageBody };
    // A dispatcher reply's own `operationId` column stays null -- that field exists to
    // link a *client's* message to the run it started, not for this idempotency ledger --
    // so duplication is checked by count, not by looking the retried write up by it.
    const countAfterFirst = await prisma.aiMessage.count({
      where: { conversationId: chat.conversation.id },
    });

    const replay = await sendDispatcherReply(
      chat.conversation.id,
      'Одна и та же реплика',
      operationId,
    );
    assert.equal(replay.status, 201, await replay.clone().text());
    const replayBody = (await replay.json()) as { message: MessageBody };
    assert.equal(
      replayBody.message.id,
      firstBody.message.id,
      'the replay returns the same message, not a freshly written one',
    );

    const countAfterReplay = await prisma.aiMessage.count({
      where: { conversationId: chat.conversation.id },
    });
    assert.equal(
      countAfterReplay,
      countAfterFirst,
      'the retried request must not write a second message',
    );
  });

  it('a live chat shows the whole history, and messages after finish stay on the same row', async () => {
    const email = `${unique('dispatch-chat-window')}@example.test`;
    emails.push(email);
    const clientToken = await signInClient(email);
    const clientAccount = await prisma.account.findUniqueOrThrow({ where: { email } });
    const request = await createRequestRow(clientAccount.id);

    const opened = await call('POST', '/api/v1/ai/conversations', clientToken, {});
    const conversation = ((await opened.json()) as { conversation: ConversationBody }).conversation;
    conversationIds.push(conversation.id);

    await prisma.aiMessage.create({
      data: {
        conversationId: conversation.id,
        seq: 1,
        author: 'user',
        kind: 'text',
        text: 'Разговор с ассистентом до передачи',
        actions: [],
        createdAt: BigInt(now()),
      },
    });

    const openedChat = await openChat(
      { kind: 'request', requestId: request.id },
      'Подключаюсь к диалогу',
    );
    const chat = ((await openedChat.json()) as { chat: DispatchChatBody }).chat;
    assert.equal(
      chat.conversation.id,
      conversation.id,
      "the chat opens the client's own existing dialogue",
    );
    // Live: the whole history is visible, including the message written before the handover.
    // No system "joined" line is written, so that is the prior message plus the opening text.
    assert.equal(chat.messages.length, 2);
    assert.equal(chat.messages[0]?.seq, 1);

    const finished = await finishChat(conversation.id);
    const finishedBody = (await finished.json()) as { chat: DispatchChatBody };
    const endSeq = finishedBody.chat.handoff.endSeq;
    assert.ok(endSeq !== null);
    assert.equal(finishedBody.chat.messages.length, 2);

    // The same chat continues after the assistant takes it back.
    await prisma.aiMessage.create({
      data: {
        conversationId: conversation.id,
        seq: (endSeq ?? 0) + 1,
        author: 'user',
        kind: 'text',
        text: 'После завершения чата',
        actions: [],
        createdAt: BigInt(now()),
      },
    });

    const list = await listChats();
    const closedRow = findChat(
      ((await list.json()) as { chats: DispatchChatBody[] }).chats,
      conversation.id,
    );
    assert.ok(closedRow);
    assert.equal(closedRow?.handoff.id, chat.handoff.id);
    assert.equal(closedRow?.messages.length, 3, 'later messages stay on the same chat');
  });

  it("unreadCount counts only the counterpart's messages above the read cursor, and read only ever moves the cursor forward", async () => {
    const email = `${unique('dispatch-chat-unread')}@example.test`;
    emails.push(email);
    const clientToken = await signInClient(email);
    const clientAccount = await prisma.account.findUniqueOrThrow({ where: { email } });
    const request = await createRequestRow(clientAccount.id);

    const opened = await openChat({ kind: 'request', requestId: request.id }, 'Здравствуйте');
    const chat = ((await opened.json()) as { chat: DispatchChatBody }).chat;
    conversationIds.push(chat.conversation.id);

    await sendClientMessage(clientToken, chat.conversation.id, 'Вопрос первый');
    await sendClientMessage(clientToken, chat.conversation.id, 'Вопрос второй');

    const afterTwo = await listChats();
    const rowAfterTwo = findChat(
      ((await afterTwo.json()) as { chats: DispatchChatBody[] }).chats,
      chat.conversation.id,
    );
    assert.equal(
      rowAfterTwo?.unreadCount,
      2,
      "only the client's two messages count, not the earlier system 'joined' message",
    );
    const clientMessages = (rowAfterTwo?.messages ?? []).filter(
      (message) => message.author === 'user',
    );
    const [firstClientMessage, secondClientMessage] = clientMessages;
    assert.ok(firstClientMessage && secondClientMessage);

    const partial = await readChat(chat.conversation.id, firstClientMessage.seq);
    const partialBody = (await partial.json()) as { chat: DispatchChatBody | null };
    assert.equal(partialBody.chat?.unreadCount, 1, 'only the still-unacknowledged message remains');

    // A stale tab replaying an older cursor must not resurrect a badge the newer read
    // already cleared.
    const backwards = await readChat(chat.conversation.id, 0);
    const backwardsBody = (await backwards.json()) as { chat: DispatchChatBody | null };
    assert.equal(backwardsBody.chat?.unreadCount, 1, 'the cursor never moves backwards');

    const full = await readChat(chat.conversation.id, secondClientMessage.seq);
    const fullBody = (await full.json()) as { chat: DispatchChatBody | null };
    assert.equal(fullBody.chat?.unreadCount, 0);
  });
  it('offers client handoff when the dispatcher chat screen is available', () => {
    assert.ok(app.get(ToolRegistry).find('client', 'call_dispatch_helper'));
  });
});
