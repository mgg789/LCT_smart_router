import { describe, expect, it } from 'vitest';
import type { AiHandoff, DispatchChatView } from '@/entities/chat';
import type { Contact } from './contacts';
import { chatForContact, chatStatus, lastSeq, threadMessages } from './threads';

function chat(
  handoff: Partial<AiHandoff>,
  lastMessageAt = 0,
  seqs: number[] = [],
): DispatchChatView {
  return {
    handoff: {
      id: 'h1',
      conversationId: 'c1',
      requestedByAccountId: 'acc-1',
      actorRole: 'client',
      initiatedBy: 'user',
      requestIds: [],
      engineerIds: [],
      state: 'waiting',
      startSeq: 0,
      endSeq: null,
      createdAt: 0,
      firstReplyAt: null,
      closedAt: null,
      ...handoff,
    },
    conversation: {
      id: handoff.conversationId ?? 'c1',
      role: 'client',
      mode: 'dispatcher',
      assistMode: 'help',
      roleProfile: 'client',
      contextRef: null,
      title: null,
      createdAt: 0,
      updatedAt: 0,
      lastMessageAt,
      closedAt: null,
      version: 1,
    },
    messages: seqs.map((seq) => ({
      id: `m${seq}`,
      seq,
      author: 'client',
      kind: 'text',
      text: `реплика ${seq}`,
      actions: [],
      runId: null,
      operationId: null,
      authorAccountId: null,
      createdAt: seq,
    })),
    unreadCount: 0,
  };
}

const engineer: Contact = {
  id: 'eng-1',
  kind: 'engineers',
  name: 'Мария Орлова',
  status: 'В сети',
  online: true,
  target: { kind: 'engineer', engineerId: 'eng-1' },
  matchIds: ['eng-1'],
};

const client: Contact = {
  id: 'client:Иванов',
  kind: 'clients',
  name: 'Иванов',
  status: 'Заявка',
  online: false,
  target: { kind: 'request', requestId: 'req-1' },
  matchIds: ['req-1', 'req-2'],
};

describe('chatForContact', () => {
  it('finds nothing when nobody has written to this person', () => {
    expect(chatForContact([], engineer)).toBeNull();
  });

  it('matches an engineer by the id the handover names', () => {
    const mine = chat({ engineerIds: ['eng-1'] });
    expect(chatForContact([chat({ engineerIds: ['eng-9'] }), mine], engineer)).toBe(mine);
  });

  it('matches a client by any request they left, not only the row’s own', () => {
    // The row shows the nearest request; the chat was opened about another one.
    const mine = chat({ requestIds: ['req-2'] });
    expect(chatForContact([mine], client)).toBe(mine);
  });

  it('does not confuse an engineer chat with a client one on the same ids', () => {
    expect(chatForContact([chat({ requestIds: ['eng-1'] })], engineer)).toBeNull();
  });

  it('prefers the live episode over a finished one, however recent', () => {
    const closed = chat({ engineerIds: ['eng-1'], state: 'closed', closedAt: 900 }, 900);
    const live = chat({ engineerIds: ['eng-1'], state: 'waiting' }, 100);
    expect(chatForContact([closed, live], engineer)).toBe(live);
  });

  it('falls back to the last finished episode when none is live', () => {
    const older = chat({ engineerIds: ['eng-1'], state: 'closed', closedAt: 100 });
    const newer = chat({ engineerIds: ['eng-1'], state: 'closed', closedAt: 900 });
    expect(chatForContact([older, newer], engineer)).toBe(newer);
  });

  it('takes the dialogue that spoke last when a person holds two live ones', () => {
    const quiet = chat({ engineerIds: ['eng-1'], conversationId: 'c1' }, 100);
    const recent = chat({ engineerIds: ['eng-1'], conversationId: 'c2' }, 500);
    expect(chatForContact([quiet, recent], engineer)).toBe(recent);
  });
});

describe('chatStatus', () => {
  it('says nothing when there is no chat yet', () => {
    expect(chatStatus(null)).toBeNull();
  });

  it('reads waiting from the handover state, not from the conversation mode', () => {
    // `mode` is `dispatcher` in the fixture, which by itself proves nothing.
    expect(chatStatus(chat({ state: 'waiting' }))).toBe('Ждёт ответа');
    expect(chatStatus(chat({ state: 'answered' }))).toBe('Вы ответили');
    expect(chatStatus(chat({ state: 'closed' }))).toBe('Передача завершена');
  });
});

describe('threadMessages', () => {
  it('orders a thread by the server’s own cursor', () => {
    expect(threadMessages(chat({}, 0, [3, 1, 2])).map((message) => message.seq)).toEqual([1, 2, 3]);
  });

  it('has no messages and no cursor before a chat exists', () => {
    expect(threadMessages(null)).toEqual([]);
    expect(lastSeq(null)).toBeNull();
  });

  it('reports the newest seq as the cursor to acknowledge', () => {
    expect(lastSeq(chat({}, 0, [1, 5, 3]))).toBe(5);
  });
});
