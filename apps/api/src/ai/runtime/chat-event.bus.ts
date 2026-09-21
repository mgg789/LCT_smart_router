import { Injectable } from '@nestjs/common';
import { filter, Observable, Subject } from 'rxjs';
import { Clock } from '../../common/time';
import type { AiConversation, AiHandoff, AiMessage } from '../../generated/prisma/client';

/** Fields every chat event carries, whatever it announces. */
interface ChatEventBase {
  readonly at: number;
  readonly conversationId: string;
  /**
   * The handover this event belongs to, or `null` when the dialogue is an ordinary
   * assistant conversation.
   *
   * This is the audience switch: the dispatcher's inbox subscribes to events with a
   * handover and nothing else, so a client chatting to the AI does not stream into a
   * dispatcher's browser. It is set from the handover row the writer already had in hand,
   * never re-derived here, because the writer knows whether the row it just wrote is the
   * open one and this bus does not read the database.
   */
  readonly handoffId: string | null;
}

/** One message was appended -- by the counterpart, the dispatcher, the assistant or the
 *  system. The row is the durable record; this event only says it exists now. */
export interface ChatMessageEvent extends ChatEventBase {
  readonly type: 'message';
  readonly message: AiMessage;
}

/** The dialogue changed hands: a handover opened, was answered, or ended. `handoff` is
 *  `null` only for a conversation that has never been handed over. */
export interface ChatStateEvent extends ChatEventBase {
  readonly type: 'state';
  readonly conversation: AiConversation;
  readonly handoff: AiHandoff | null;
}

export type ChatEvent = ChatMessageEvent | ChatStateEvent;

/**
 * The live channel for person-to-person chat: one in-process multicast that both the
 * counterpart's own conversation stream and the dispatcher's inbox stream read from.
 *
 * **Nothing here is a source of truth.** Every message is already committed to
 * `ai_messages` with a per-conversation `seq` before it is published, and every reader
 * resumes with `?afterSeq=`, so a dropped connection, a restart or a second replica costs
 * a reader nothing but a re-read. That is the whole reason this bus is allowed to be a
 * plain `Subject` rather than a durable outbox: unlike `AiRunEvent.message_delta`, no
 * chat event carries information that exists only in flight.
 *
 * **Publish after commit, never inside the transaction.** A subscriber that receives a
 * message event immediately re-reads or renders it; if the writing transaction then rolls
 * back, the dispatcher has been shown a message that does not exist. Every caller
 * therefore publishes from outside `OperationsService.execute`, using the row that call
 * returned -- which is also why this class takes no `Tx` and never writes.
 *
 * The same single-instance caveat as `RunRegistry` applies: a second API replica would
 * multicast only to the browsers connected to itself. The durable state stays correct in
 * both replicas; only the liveness degrades to the reader's next poll or reconnect.
 */
@Injectable()
export class ChatEventBus {
  private readonly events = new Subject<ChatEvent>();

  constructor(private readonly clock: Clock) {}

  publishMessage(input: {
    readonly conversationId: string;
    readonly handoffId: string | null;
    readonly message: AiMessage;
  }): void {
    this.events.next({ type: 'message', at: this.clock.nowSeconds(), ...input });
  }

  publishState(input: {
    readonly conversation: AiConversation;
    readonly handoff: AiHandoff | null;
  }): void {
    this.events.next({
      type: 'state',
      at: this.clock.nowSeconds(),
      conversationId: input.conversation.id,
      handoffId: input.handoff?.id ?? null,
      conversation: input.conversation,
      handoff: input.handoff,
    });
  }

  /** Everything happening in one dialogue, for the client or engineer reading their own
   *  chat. */
  forConversation(conversationId: string): Observable<ChatEvent> {
    return this.events.pipe(filter((event) => event.conversationId === conversationId));
  }

  /**
   * Everything happening in dialogues a human is carrying, for the dispatcher's chat
   * list.
   *
   * A `state` event announcing the *end* of a handover still carries its `handoffId`, so
   * the dispatcher learns the chat closed -- the row stays in their list, and the event
   * that put it there must reach them even though the conversation has already returned
   * to the assistant.
   */
  inbox(): Observable<ChatEvent> {
    return this.events.pipe(filter((event) => event.handoffId !== null));
  }
}
