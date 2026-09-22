import type { MessageEvent } from '@nestjs/common';
import {
  concat,
  concatMap,
  defer,
  filter,
  finalize,
  from,
  map,
  Observable,
  ReplaySubject,
} from 'rxjs';
import type { ChatEvent } from '../ai/runtime';
import { type AiMessageView, toMessageView } from './ai-view';
import { type AiHandoffView, toHandoffView } from './dispatch-chat-view';

/**
 * The wire contract of a person-to-person chat stream.
 *
 * Two endpoints emit exactly this union over Server-Sent Events -- one scoped to a single
 * dialogue for the client and engineer apps, one covering every handed-over dialogue for
 * the dispatcher -- and the web client mirrors it with its own schema, the same way it
 * mirrors `ai-event.types.ts`. This workspace has no shared contract package, so changing
 * a member here is a contract change and belongs in `docs/frontend-api.md` in the same
 * commit.
 *
 * It is deliberately **not** the run-event union. A run is a bounded generation with an
 * ephemeral middle (`message_delta`) and a terminal event; a chat between two people has
 * neither, and forcing both through one union would mean inventing a "terminal" for
 * something that simply continues tomorrow. What the two share is the resume rule, and
 * only that:
 *
 *   * `message.seq` is the per-conversation message sequence, assigned by the database,
 *     and is the only state a reader keeps. A reconnect asks for `?afterSeq=<last
 *     rendered>` and receives exactly the tail it missed;
 *   * every message is committed before it is published, so a reader may render one on
 *     arrival instead of re-reading to confirm it exists;
 *   * `state` carries the current mode and handover rather than a transition, so it is
 *     idempotent: delivering it twice, or missing one and picking the truth up at the next
 *     reconnect, costs a reader nothing.
 */
export type ChatStreamEvent =
  | {
      readonly type: 'message';
      readonly at: number;
      readonly conversationId: string;
      readonly message: AiMessageView;
    }
  | {
      readonly type: 'state';
      readonly at: number;
      readonly conversationId: string;
      /** `dispatcher` while a human is carrying the dialogue, `ai` otherwise. */
      readonly mode: string;
      /** The chat this dialogue is in, or the one that most recently ended. `null` for a
       *  dialogue that has never been handed over. */
      readonly handoff: AiHandoffView | null;
    };

export function toChatStreamEvent(event: ChatEvent): ChatStreamEvent {
  if (event.type === 'message') {
    return {
      type: 'message',
      at: event.at,
      conversationId: event.conversationId,
      message: toMessageView(event.message),
    };
  }
  return {
    type: 'state',
    at: event.at,
    conversationId: event.conversationId,
    mode: event.conversation.mode,
    handoff: event.handoff ? toHandoffView(event.handoff) : null,
  };
}

export function toChatMessageEvent(event: ChatStreamEvent): MessageEvent {
  return event.type === 'message'
    ? { type: event.type, data: event, id: String(event.message.seq) }
    : { type: event.type, data: event };
}

/**
 * How many live events are held while the catch-up read is in flight.
 *
 * The buffer exists only to cover those few milliseconds, so it is small on purpose: a
 * reader that somehow fell further behind than this recovers on its next reconnect, which
 * re-reads from `?afterSeq=` and loses nothing, whereas an unbounded buffer would hold
 * every message of every open connection for as long as the dispatcher's tab stays open.
 */
const LIVE_BUFFER_EVENTS = 256;

/**
 * Replays what a reader missed and then follows the live channel, without losing anything
 * produced in the gap between the two.
 *
 * The live subscription is opened **before** the catch-up read -- that is what `defer`
 * plus the buffering subject buy -- so a message committed while that read is in flight is
 * held and delivered after the tail rather than falling between them. Anything the read
 * already returned is then dropped by sequence number, per conversation: `seq` is
 * per-conversation, so a single counter would silently suppress one dialogue's messages
 * because another had reached a higher number on the dispatcher's shared stream.
 *
 * Written as an `Observable` rather than as the async generator `streamRunEvents` uses,
 * because a chat stream never ends on its own. Returning from a generator parked on an
 * `await` is not something a caller can force, so a disconnected browser would leave its
 * subscription on the bus for the lifetime of the process; `finalize` on an unsubscribed
 * `Observable` runs immediately and unconditionally.
 */
export function chatEventStream(input: {
  readonly live: Observable<ChatEvent>;
  readonly replay: () => Promise<ChatStreamEvent[]>;
}): Observable<ChatStreamEvent> {
  return defer(() => {
    const buffered = new ReplaySubject<ChatEvent>(LIVE_BUFFER_EVENTS);
    const subscription = input.live.subscribe(buffered);
    const lastSeq = new Map<string, number>();

    const unseen = (event: ChatStreamEvent): boolean => {
      if (event.type !== 'message') {
        // `state` carries the present rather than a transition, so a second copy of it
        // tells a reader the same true thing twice and needs no suppression.
        return true;
      }
      const seen = lastSeq.get(event.conversationId) ?? 0;
      if (event.message.seq <= seen) {
        return false;
      }
      lastSeq.set(event.conversationId, event.message.seq);
      return true;
    };

    return concat(
      from(input.replay()).pipe(concatMap((events) => from(events))),
      buffered.pipe(map(toChatStreamEvent)),
    ).pipe(
      filter(unseen),
      finalize(() => subscription.unsubscribe()),
    );
  });
}
