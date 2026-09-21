import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Subject } from 'rxjs';
import type { ChatEvent } from '../../src/ai/runtime/chat-event.bus';
import { type ChatStreamEvent, chatEventStream } from '../../src/api/chat-stream';
import type { AiMessage } from '../../src/generated/prisma/client';

/** A minimal already-committed message row: only `seq` (dedup) and the fields
 *  `toMessageView` copies through are ever read here. */
function fakeMessage(conversationId: string, seq: number): AiMessage {
  return {
    id: `m-${conversationId}-${seq}`,
    conversationId,
    seq,
    author: 'user',
    kind: 'text',
    text: 'hi',
    actions: [],
    runId: null,
    operationId: null,
    authorAccountId: null,
    createdAt: 1_000n,
  } as unknown as AiMessage;
}

/** A live event straight off `ChatEventBus`, the shape `input.live` emits. */
function liveMessage(conversationId: string, seq: number): ChatEvent {
  return {
    type: 'message',
    at: 1_000,
    conversationId,
    handoffId: 'handoff-1',
    message: fakeMessage(conversationId, seq),
  };
}

/** A catch-up event, already on the wire contract -- the shape `input.replay()` resolves
 *  to, unlike `liveMessage` above. */
function replayMessage(conversationId: string, seq: number): ChatStreamEvent {
  return {
    type: 'message',
    at: 1_000,
    conversationId,
    message: {
      id: `m-${conversationId}-${seq}`,
      seq,
      author: 'user',
      kind: 'text',
      text: 'hi',
      actions: [],
      runId: null,
      operationId: null,
      authorAccountId: null,
      createdAt: 1_000,
    },
  };
}

function seqOf(event: ChatStreamEvent | undefined): number | undefined {
  return event?.type === 'message' ? event.message.seq : undefined;
}

/** Lets every microtask queued so far (promise resolutions, `concat`'s handoff between
 *  its sources, `ReplaySubject` delivery) actually run before the next assertion. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

describe('chatEventStream', () => {
  it('replays the catch-up batch first, then follows the live channel', async () => {
    const live = new Subject<ChatEvent>();
    const seen: ChatStreamEvent[] = [];
    const subscription = chatEventStream({
      live,
      replay: async () => [replayMessage('c1', 1)],
    }).subscribe((event) => seen.push(event));

    await flush();
    assert.deepEqual(seen.map(seqOf), [1], 'the replayed message arrives on its own first');

    live.next(liveMessage('c1', 2));
    await flush();
    assert.deepEqual(seen.map(seqOf), [1, 2], 'the live message follows the replay');

    subscription.unsubscribe();
  });

  it('drops a live event whose seq was already delivered in the replay', async () => {
    const live = new Subject<ChatEvent>();
    const seen: ChatStreamEvent[] = [];
    const subscription = chatEventStream({
      live,
      replay: async () => [replayMessage('c1', 5)],
    }).subscribe((event) => seen.push(event));
    await flush();

    // A message can legitimately land twice -- once via the catch-up read, once via the
    // bus, if it was written right at the boundary between the two -- and the reader must
    // never be shown it twice.
    live.next(liveMessage('c1', 5));
    live.next(liveMessage('c1', 6));
    await flush();

    assert.deepEqual(
      seen.map(seqOf),
      [5, 6],
      'the duplicate is dropped; only the genuinely new message arrives',
    );
    subscription.unsubscribe();
  });

  it("dedup is per conversation: another dialogue's cursor does not suppress this one", async () => {
    const live = new Subject<ChatEvent>();
    const seen: ChatStreamEvent[] = [];
    const subscription = chatEventStream({
      live,
      replay: async () => [replayMessage('c1', 9)],
    }).subscribe((event) => seen.push(event));
    await flush();

    // A single shared counter would wrongly suppress c2's message 1 because 1 <= 9; `seq`
    // is per-conversation, which matters on the dispatcher's shared inbox stream where many
    // dialogues share one connection.
    live.next(liveMessage('c2', 1));
    await flush();

    assert.equal(seen.length, 2);
    assert.equal(seen[1]?.conversationId, 'c2');
    assert.equal(seqOf(seen[1]), 1);
    subscription.unsubscribe();
  });

  it('does not lose an event published while the replay read is still in flight', async () => {
    const live = new Subject<ChatEvent>();
    const seen: ChatStreamEvent[] = [];
    const subscription = chatEventStream({
      live,
      // The live subscription is opened before this runs (chat-stream.ts's own doc comment
      // on why), so a message committed during the catch-up read -- simulated here by
      // publishing from inside `replay` itself -- must still reach the reader afterwards
      // rather than falling in the gap between the two sources.
      replay: async () => {
        live.next(liveMessage('c1', 10));
        return [replayMessage('c1', 1)];
      },
    }).subscribe((event) => seen.push(event));

    await flush();
    assert.deepEqual(
      seen.map(seqOf),
      [1, 10],
      'the persisted tail comes first, then the event queued mid-replay -- neither is lost',
    );
    subscription.unsubscribe();
  });

  it('a state event is never deduplicated, even repeated back to back', async () => {
    const live = new Subject<ChatEvent>();
    const seen: ChatStreamEvent[] = [];
    const subscription = chatEventStream({ live, replay: async () => [] }).subscribe((event) =>
      seen.push(event),
    );
    await flush();

    const stateEvent = {
      type: 'state',
      at: 1_000,
      conversationId: 'c1',
      handoffId: 'handoff-1',
      conversation: { id: 'c1', mode: 'dispatcher' },
      handoff: null,
    } as unknown as ChatEvent;

    live.next(stateEvent);
    live.next(stateEvent);
    await flush();

    assert.equal(
      seen.length,
      2,
      'state carries the present, not a transition, so repeats are fine',
    );
    assert.ok(seen.every((event) => event.type === 'state'));
    subscription.unsubscribe();
  });

  it('unsubscribes from the live channel once the reader disconnects', async () => {
    const live = new Subject<ChatEvent>();
    const subscription = chatEventStream({ live, replay: async () => [] }).subscribe(() => {});
    await flush();

    assert.equal(live.observed, true, 'the bus is subscribed while the reader is connected');
    subscription.unsubscribe();
    assert.equal(live.observed, false, 'a disconnected reader must not keep the bus subscribed');
  });
});
