import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AiHandoffState, DispatchChatView } from '../api/ai';
import { ChatsPage } from './ChatsPage';

/** Every chat this endpoint lists is already in `dispatcher` mode (the server only ever
 *  returns those) -- the state under test here is the handoff's own `state`, not
 *  `conversation.mode`, which stays `dispatcher` for both fixtures below. */
function chat(state: AiHandoffState): DispatchChatView {
  return {
    handoff: {
      id: 'h-1',
      conversationId: 'c-1',
      requestedByAccountId: 'acc-1',
      actorRole: 'client',
      requestIds: [],
      engineerIds: [],
      state,
      createdAt: 1_000,
      firstReplyAt: state === 'waiting' ? null : 1_500,
    },
    conversation: {
      id: 'c-1',
      role: 'client',
      roleProfile: 'client',
      mode: 'dispatcher',
      assistMode: 'help',
      contextRef: null,
      title: 'Клиент',
      createdAt: 1_000,
      updatedAt: 1_000,
      lastMessageAt: 1_000,
      closedAt: null,
      version: 1,
    },
    messages: [
      {
        id: 'm-1',
        conversationId: 'c-1',
        seq: 1,
        author: 'user',
        kind: 'text',
        text: 'Когда приедет инженер?',
        actions: [],
        runId: null,
        operationId: null,
        authorAccountId: null,
        createdAt: 1_000,
      },
    ],
    unreadCount: 1,
  };
}

const noop = async () => {};

describe('ChatsPage', () => {
  it('shows waiting, never a false "диспетчер подключён", before a human has replied', () => {
    const html = renderToStaticMarkup(
      createElement(ChatsPage, {
        token: 'tok',
        chats: [chat('waiting')],
        loading: false,
        error: null,
        writesDisabled: false,
        onSendMessage: noop,
        onFinish: noop,
        onRefresh: () => {},
      }),
    );
    expect(html).toContain('Ожидает ответа');
    expect(html).toContain('Ожидаем первого ответа диспетчера');
    expect(html).not.toContain('диспетчер подключён');
    expect(html).not.toContain('Диалог ведёт диспетчер');
  });

  it('shows answered only once the handoff actually recorded a dispatcher reply', () => {
    const html = renderToStaticMarkup(
      createElement(ChatsPage, {
        token: 'tok',
        chats: [chat('answered')],
        loading: false,
        error: null,
        writesDisabled: false,
        onSendMessage: noop,
        onFinish: noop,
        onRefresh: () => {},
      }),
    );
    expect(html).toContain('Ответ отправлен');
    expect(html).toContain('Диалог ведёт диспетчер');
  });
});
