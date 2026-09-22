import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type ChatEvent, ChatEventBus } from '../../src/ai/runtime/chat-event.bus';
import { FixedClock } from '../../src/common/time';
import type { AiConversation, AiHandoff, AiMessage } from '../../src/generated/prisma/client';

/** Minimal rows carrying only the fields the bus and its readers actually look at:
 *  `conversationId` for `forConversation`, and (via `publishMessage`/`publishState`'s own
 *  input) `handoffId` for `inbox`. Everything else is inert payload the bus never reads. */
function fakeMessage(overrides: Partial<AiMessage> = {}): AiMessage {
  return {
    id: 'msg-1',
    conversationId: 'conv-1',
    seq: 1,
    author: 'user',
    kind: 'text',
    text: 'hi',
    actions: [],
    runId: null,
    operationId: null,
    authorAccountId: null,
    createdAt: 1_000n,
    ...overrides,
  } as unknown as AiMessage;
}

function fakeConversation(overrides: Partial<AiConversation> = {}): AiConversation {
  return {
    id: 'conv-1',
    accountId: 'acc-1',
    role: 'client',
    roleProfile: 'client',
    mode: 'dispatcher',
    assistMode: 'help',
    contextRef: null,
    title: null,
    createdAt: 1_000n,
    updatedAt: 1_000n,
    lastMessageAt: 1_000n,
    closedAt: null,
    version: 1,
    ...overrides,
  } as unknown as AiConversation;
}

function fakeHandoff(overrides: Partial<AiHandoff> = {}): AiHandoff {
  return {
    id: 'handoff-1',
    conversationId: 'conv-1',
    requestedByAccountId: 'acc-dispatcher',
    actorRole: 'client',
    initiatedBy: 'dispatcher',
    requestIds: [],
    engineerIds: [],
    state: 'answered',
    dispatcherLastReadSeq: 0,
    startSeq: 0,
    endSeq: null,
    createdAt: 1_000n,
    firstReplyAt: null,
    closedAt: null,
    closedByAccountId: null,
    version: 1,
    ...overrides,
  } as unknown as AiHandoff;
}

describe('ChatEventBus', () => {
  it('inbox() delivers only events that carry a handoffId', () => {
    const bus = new ChatEventBus(new FixedClock(1_000));
    const seen: ChatEvent[] = [];
    bus.inbox().subscribe((event) => seen.push(event));

    // An ordinary assistant conversation -- never escalated -- must not reach the
    // dispatcher's inbox, however many messages it writes.
    bus.publishMessage({ conversationId: 'conv-ai', handoffId: null, message: fakeMessage() });
    bus.publishMessage({
      conversationId: 'conv-handed',
      handoffId: 'handoff-1',
      message: fakeMessage({ conversationId: 'conv-handed' }),
    });
    bus.publishState({ conversation: fakeConversation(), handoff: null });
    bus.publishState({
      conversation: fakeConversation(),
      handoff: fakeHandoff({ state: 'closed' }),
    });

    assert.equal(seen.length, 2, 'only the two events carrying a handoffId reach the inbox');
    assert.ok(seen.every((event) => event.handoffId !== null));
  });

  it('a state event announcing the end of a handover still carries its handoffId', () => {
    // The row that just closed is what put the chat in the dispatcher's list in the first
    // place; the inbox must keep seeing it even though `conversation.mode` already reverted
    // to `ai` (the bus's own doc comment on why).
    const bus = new ChatEventBus(new FixedClock(1_000));
    const seen: ChatEvent[] = [];
    bus.inbox().subscribe((event) => seen.push(event));

    const closedHandoff = fakeHandoff({ state: 'closed' });
    bus.publishState({
      conversation: fakeConversation({ mode: 'ai' }),
      handoff: closedHandoff,
    });

    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.handoffId, closedHandoff.id);
  });

  it('forConversation() delivers only that conversation, both message and state events, regardless of handoffId', () => {
    const bus = new ChatEventBus(new FixedClock(1_000));
    const seen: ChatEvent[] = [];
    bus.forConversation('conv-mine').subscribe((event) => seen.push(event));

    bus.publishMessage({
      conversationId: 'conv-mine',
      handoffId: null,
      message: fakeMessage({ conversationId: 'conv-mine' }),
    });
    bus.publishState({
      conversation: fakeConversation({ id: 'conv-mine' }),
      handoff: fakeHandoff({ conversationId: 'conv-mine' }),
    });
    // Someone else's dialogue, live at the same instant, must not leak into this reader.
    bus.publishMessage({
      conversationId: 'conv-other',
      handoffId: 'handoff-other',
      message: fakeMessage({ conversationId: 'conv-other' }),
    });

    assert.equal(seen.length, 2);
    assert.ok(seen.every((event) => event.conversationId === 'conv-mine'));
    assert.deepEqual(
      seen.map((event) => event.type),
      ['message', 'state'],
    );
  });

  it('publishState maps a null handoff to a null handoffId, not the string "null"', () => {
    const bus = new ChatEventBus(new FixedClock(1_000));
    const seen: ChatEvent[] = [];
    bus.forConversation('conv-1').subscribe((event) => seen.push(event));

    bus.publishState({ conversation: fakeConversation(), handoff: null });

    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.handoffId, null);
  });
});
