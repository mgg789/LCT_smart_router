import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AiHandoffState, DispatchChatView } from '../api/ai';
import { ChatsView, chatName, originLabel } from './ChatsView';

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
  const roleProfile = overrides.roleProfile ?? 'engineer';
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
const noopOpenEngineer = async (): Promise<DispatchChatView> => chat('waiting');

describe('chatName', () => {
  /** The switch above the list already says which side is being read; repeating it on
   *  every row cost the width the name needed. */
  it('drops the role the title is prefixed with, whatever dash joins it', () => {
    const named = (title: string | null): DispatchChatView => ({
      ...chat('waiting'),
      conversation: { ...chat('waiting').conversation, title },
    });
    expect(chatName(named('Инженер · Алексей Волков'))).toBe('Алексей Волков');
    expect(chatName(named('Клиент — Мария Смирнова'))).toBe('Мария Смирнова');
    expect(chatName(named('Клиент: Пётр'))).toBe('Пётр');
  });

  it('keeps a name that merely begins with those letters', () => {
    const named = (title: string): DispatchChatView => ({
      ...chat('waiting'),
      conversation: { ...chat('waiting').conversation, title },
    });
    expect(chatName(named('Клиентова Анна'))).toBe('Клиентова Анна');
  });

  /** An escalated chat names nobody: no title, no engineer id, no request id. Borrowing
   *  the role as a name would be the very thing this strips everywhere else. */
  it('says so when the handover carries no name at all', () => {
    expect(
      chatName({
        ...chat('waiting'),
        conversation: { ...chat('waiting').conversation, title: null },
      }),
    ).toBe('Без имени');
  });
});

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
        engineers: [],
        onOpenEngineer: noopOpenEngineer,
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
        engineers: [],
        onOpenEngineer: noopOpenEngineer,
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
        engineers: [],
        onOpenEngineer: noopOpenEngineer,
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
    const empty = (
      initiatedBy: 'user' | 'dispatcher',
      roleProfile: 'client' | 'engineer' = 'engineer',
    ): DispatchChatView => ({
      ...chat('waiting', { initiatedBy, roleProfile }),
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
        engineers: [],
        onOpenEngineer: noopOpenEngineer,
      }),
    );
    expect(mine).toContain('Вы написали первым');
    expect(mine).not.toContain('попросил диспетчера');

    expect(originLabel(empty('user', 'client'))).toBe('Клиент попросил диспетчера');
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
        engineers: [],
        onOpenEngineer: noopOpenEngineer,
      }),
    );
    // One row per episode: the same conversation handed over twice is two rows.
    expect(html.match(/aria-current=/g) ?? []).toHaveLength(2);
    // And the live episode is the one opened, not the finished one that shares its
    // conversation id — a closed chat has no «Завершить чат».
    expect(html).toContain('Ожидает ответа');
    expect(html).toContain('>Завершить чат<');
  });

  it('opens on the engineer roster and keeps uncontacted engineers searchable', () => {
    const html = renderToStaticMarkup(
      createElement(ChatsView, {
        token: 'tok',
        chats: [],
        loading: true,
        error: null,
        writesDisabled: false,
        engineers: [
          { id: 'eng-1', displayName: 'Анна Волкова', canChat: true },
          { id: 'eng-2', displayName: 'Борис Петров', canChat: true },
          { id: 'eng-3', displayName: 'Вера Смирнова', canChat: false },
        ],
        onOpenEngineer: noopOpenEngineer,
        onSendMessage: noop,
        onFinish: noop,
        onMarkRead: () => {},
      }),
    );

    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('Анна Волкова');
    expect(html).toContain('Борис Петров');
    expect(html).toContain('Вера Смирнова');
    expect(html).toContain('Написать инженеру');
    expect(html).toContain('Нет аккаунта для чата');
    expect(html).toContain('Выберите диалог слева.');
    expect(html).toContain('transform:translate(-50%, -50%)');
  });
});
