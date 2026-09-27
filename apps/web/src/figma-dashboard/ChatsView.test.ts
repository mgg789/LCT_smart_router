import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AiHandoffState, DispatchChatView } from '../api/ai';
import { ChatsView } from './ChatsView';

/** Every chat this endpoint lists is already in `dispatcher` mode (the server only ever
 *  returns those) -- the state under test here is the handoff's own `state`, not
 *  `conversation.mode`, which stays `dispatcher` for every fixture below. */
function chat(
  state: AiHandoffState,
  overrides: {
    readonly handoffId?: string;
    readonly conversationId?: string;
    readonly initiatedBy?: 'user' | 'dispatcher';
    readonly roleProfile?: 'client' | 'engineer';
    readonly startSeq?: number;
    readonly closedAt?: number | null;
  } = {},
): DispatchChatView {
  const conversationId = overrides.conversationId ?? 'c-1';
  const roleProfile = overrides.roleProfile ?? 'client';
  return {
    handoff: {
      id: overrides.handoffId ?? 'h-1',
      conversationId,
      requestedByAccountId: 'acc-1',
      actorRole: roleProfile,
      initiatedBy: overrides.initiatedBy ?? 'user',
      requestIds: [],
      engineerIds: [],
      state,
      startSeq: overrides.startSeq ?? 0,
      endSeq: state === 'closed' ? 2 : null,
      createdAt: 1_000,
      firstReplyAt: state === 'waiting' ? null : 1_500,
      closedAt: state === 'closed' ? (overrides.closedAt ?? 2_000) : null,
    },
    conversation: {
      id: conversationId,
      role: roleProfile,
      roleProfile,
      mode: 'dispatcher',
      assistMode: 'help',
      contextRef: null,
      title: roleProfile === 'engineer' ? 'Инженер' : 'Клиент',
      createdAt: 1_000,
      updatedAt: 1_000,
      lastMessageAt: 1_000,
      closedAt: null,
      version: 1,
    },
    messages: [
      {
        id: 'm-1',
        conversationId,
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

describe('ChatsView', () => {
  it('shows waiting, never a false "диспетчер подключён", before a human has replied', () => {
    const html = renderToStaticMarkup(
      createElement(ChatsView, {
        token: 'tok',
        chats: [chat('waiting')],
        loading: false,
        error: null,
        writesDisabled: false,
        onSendMessage: noop,
        onFinish: noop,
        onMarkRead: () => {},
      }),
    );
    expect(html).toContain('Ожидает ответа');
    expect(html).not.toContain('диспетчер подключён');
    expect(html).not.toContain('Диалог ведёт диспетчер');
  });

  it('shows answered only once the handoff actually recorded a dispatcher reply', () => {
    const html = renderToStaticMarkup(
      createElement(ChatsView, {
        token: 'tok',
        chats: [chat('answered')],
        loading: false,
        error: null,
        writesDisabled: false,
        onSendMessage: noop,
        onFinish: noop,
        onMarkRead: () => {},
      }),
    );
    expect(html).toContain('Диалог ведёт диспетчер');
    expect(html).not.toContain('Ожидает ответа');
  });

  it('renders a finished chat read-only, with no composer and no «Завершить чат»', () => {
    const html = renderToStaticMarkup(
      createElement(ChatsView, {
        token: 'tok',
        chats: [chat('closed', { closedAt: 3_600 })],
        loading: false,
        error: null,
        writesDisabled: false,
        onSendMessage: noop,
        onFinish: noop,
        onMarkRead: () => {},
      }),
    );
    expect(html).toContain('Чат завершён');
    // The frame always draws a composer, so a finished chat is proved read-only by the
    // controls being disabled — not by them being gone.
    expect(html).not.toContain('>Завершить чат<');
    expect(html).toMatch(/<input[^>]*placeholder="Чат завершён"[^>]*disabled/);
  });

  /** The frame previews the newest line. A chat with none yet has nothing to preview, and
   *  falls back to how it started — which differs per side and must not be confused. */
  it('previews an empty chat by its own origin, not the other side’s copy', () => {
    const empty = (initiatedBy: 'user' | 'dispatcher'): DispatchChatView => ({
      ...chat('waiting', { initiatedBy }),
      messages: [],
    });

    const mine = renderToStaticMarkup(
      createElement(ChatsView, {
        token: 'tok',
        chats: [empty('dispatcher')],
        loading: false,
        error: null,
        writesDisabled: false,
        onSendMessage: noop,
        onFinish: noop,
        onMarkRead: () => {},
      }),
    );
    expect(mine).toContain('Вы написали первым');
    expect(mine).not.toContain('попросил диспетчера');

    const theirs = renderToStaticMarkup(
      createElement(ChatsView, {
        token: 'tok',
        chats: [empty('user')],
        loading: false,
        error: null,
        writesDisabled: false,
        onSendMessage: noop,
        onFinish: noop,
        onMarkRead: () => {},
      }),
    );
    expect(theirs).toContain('Клиент попросил диспетчера');
    expect(theirs).not.toContain('Вы написали первым');
  });

  it('renders two handover episodes of the same conversation as two distinct rows', () => {
    const html = renderToStaticMarkup(
      createElement(ChatsView, {
        token: 'tok',
        chats: [
          chat('closed', { handoffId: 'h-1', conversationId: 'c-1', closedAt: 1_800 }),
          chat('waiting', { handoffId: 'h-2', conversationId: 'c-1' }),
        ],
        loading: false,
        error: null,
        writesDisabled: false,
        onSendMessage: noop,
        onFinish: noop,
        onMarkRead: () => {},
      }),
    );
    // One row per episode: the same conversation handed over twice is two rows.
    expect(html.match(/aria-current=/g) ?? []).toHaveLength(2);
    // And the live episode is the one opened, not the finished one that shares its
    // conversation id — a closed chat has no «Завершить чат».
    expect(html).toContain('Ожидает ответа');
    expect(html).toContain('>Завершить чат<');
  });
});
