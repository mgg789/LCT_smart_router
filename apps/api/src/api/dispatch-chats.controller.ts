import { Body, Controller, Get, Logger, type MessageEvent, Param, Post, Query, Sse } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { catchError, EMPTY, endWith, ignoreElements, interval, map, merge, type Observable, share, takeUntil } from 'rxjs';
import {
  ChatEventBus,
  type DispatchChatRow,
  DispatchChatsService,
} from '../ai';
import type { AiMessage } from '../generated/prisma/client';
import { type Actor, CurrentActor, Roles } from '../auth';
import { AppConfigService } from '../common/config';
import { SysError } from '../common/errors';
import { zodBody } from '../common/validation';
import { OperationsService } from '../operations';
import { toConversationView, toMessageView } from './ai-view';
import { chatEventStream, toChatMessageEvent } from './chat-stream';
import { toDispatchChatView } from './dispatch-chat-view';
import {
  type FinishDispatchChatDto,
  finishDispatchChatSchema,
  type ListDispatchChatsQueryDto,
  listDispatchChatsQuerySchema,
  type OpenDispatchChatDto,
  openDispatchChatSchema,
  type ReadDispatchChatDto,
  readDispatchChatSchema,
  type SendDispatchChatMessageDto,
  sendDispatchChatMessageSchema,
} from './dto/dispatch-chat.dto';

/**
 * Dispatcher chats with a client or an engineer.
 *
 * Kept beside the day-plan controller so the chat contour from dev can land without
 * rewriting the routes that already own planning, alerts and settings.
 */
@Roles('dispatcher')
@ApiTags('dispatch')
@Controller('dispatch')
export class DispatchChatsController {
  private readonly logger = new Logger(DispatchChatsController.name);

  constructor(
    private readonly operations: OperationsService,
    private readonly config: AppConfigService,
    private readonly dispatchChats: DispatchChatsService,
    private readonly chatBus: ChatEventBus,
  ) {}

  @Get('chats')
  @ApiOperation({ summary: 'Chats with clients and engineers: live ones, then finished ones' })
  async listChats(
    @Query(zodBody(listDispatchChatsQuerySchema)) query: ListDispatchChatsQueryDto,
  ): Promise<{ chats: ReturnType<typeof toDispatchChatView>[] }> {
    const rows = await this.dispatchChats.list({ closedLimit: query.closedLimit });
    return { chats: rows.map(toDispatchChatView) };
  }

  @Sse('chats/events')
  @ApiOperation({ summary: 'Live messages across every chat handed to the dispatcher' })
  chatEvents(): Observable<MessageEvent> {
    const heartbeatMs = this.config.get('AI_SSE_HEARTBEAT_MS');
    const heartbeat$: Observable<MessageEvent> = interval(heartbeatMs).pipe(
      map(() => ({ type: 'heartbeat', data: {} }) satisfies MessageEvent),
    );
    const main$: Observable<MessageEvent> = chatEventStream({
      live: this.chatBus.inbox(),
      replay: async () => [],
    }).pipe(
      map(toChatMessageEvent),
      catchError((error: unknown) => {
        this.logger.error(
          `Dispatcher chat stream failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return EMPTY;
      }),
      share(),
    );
    const stop$ = main$.pipe(ignoreElements(), endWith(true));
    return merge(main$, heartbeat$).pipe(takeUntil(stop$));
  }

  @Post('chats')
  @ApiOperation({ summary: 'Open a chat with a request customer or an engineer' })
  async openChat(
    @CurrentActor() actor: Actor,
    @Body(zodBody(openDispatchChatSchema)) dto: OpenDispatchChatDto,
  ) {
    const dispatcherAccountId = this.requireDispatcherAccount(actor);
    const outcome = await this.operations.execute(
      { operationId: dto.operationId, actor, action: 'dispatch_chat.open', payload: dto },
      async (context) => {
        const opened = await this.dispatchChats.openWithTarget(
          context.tx,
          context.now,
          dispatcherAccountId,
          dto.target,
          dto.text,
        );
        return {
          handoffId: opened.handoff.id,
          messageIds: opened.messages.map((message) => message.id),
          created: opened.created,
        };
      },
    );
    const chat = await this.requireChat(outcome.result.handoffId);
    if (!outcome.replayed) {
      if (outcome.result.created) this.publishChatState(chat);
      this.publishChatMessages(chat, outcome.result.messageIds);
    }
    return { chat: toDispatchChatView(chat) };
  }

  @Post('chats/:id/messages')
  @ApiOperation({ summary: "Send the dispatcher's own reply into a chat" })
  async sendChatMessage(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body(zodBody(sendDispatchChatMessageSchema)) dto: SendDispatchChatMessageDto,
  ) {
    const dispatcherAccountId = this.requireDispatcherAccount(actor);
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'dispatch_chat.message.send',
        targetRef: id,
        payload: dto,
      },
      async (context) => {
        const written = await this.dispatchChats.reply(
          context.tx,
          context.now,
          id,
          dispatcherAccountId,
          dto.text,
        );
        return { handoffId: written.handoff.id, messageId: written.message.id };
      },
    );
    const chat = await this.requireChat(outcome.result.handoffId);
    if (!outcome.replayed) this.publishChatMessages(chat, [outcome.result.messageId]);
    return {
      message: toMessageView(this.requireChatMessage(chat, outcome.result.messageId)),
      chat: toDispatchChatView(chat),
    };
  }

  @Post('chats/:id/finish')
  @ApiOperation({ summary: 'End a chat: the AI resumes, history and applied actions stay' })
  async finishChat(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body(zodBody(finishDispatchChatSchema)) dto: FinishDispatchChatDto,
  ) {
    const dispatcherAccountId = this.requireDispatcherAccount(actor);
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'dispatch_chat.finish',
        targetRef: id,
        payload: dto,
      },
      async (context) => {
        const written = await this.dispatchChats.finish(
          context.tx,
          context.now,
          id,
          dispatcherAccountId,
        );
        return { handoffId: written.handoff.id, messageId: written.message.id };
      },
    );
    const chat = await this.requireChat(outcome.result.handoffId);
    if (!outcome.replayed) {
      this.publishChatMessages(chat, [outcome.result.messageId]);
      this.publishChatState(chat);
    }
    return { conversation: toConversationView(chat.conversation), chat: toDispatchChatView(chat) };
  }

  @Post('chats/:id/read')
  @ApiOperation({ summary: 'Acknowledge a chat up to a message sequence' })
  async readChat(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body(zodBody(readDispatchChatSchema)) dto: ReadDispatchChatDto,
  ) {
    this.requireDispatcherAccount(actor);
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'dispatch_chat.read',
        targetRef: id,
        payload: dto,
      },
      async (context) => {
        const handoff = await this.dispatchChats.markRead(context.tx, id, dto.seq);
        return { handoffId: handoff?.id ?? null };
      },
    );
    const handoffId = outcome.result.handoffId;
    if (!handoffId) return { chat: null };
    const chat = await this.dispatchChats.byHandoffId(handoffId);
    return { chat: chat ? toDispatchChatView(chat) : null };
  }

  private requireDispatcherAccount(actor: Actor): string {
    if (!actor.accountId) {
      throw SysError.forbidden('A dispatcher chat needs a signed-in account');
    }
    return actor.accountId;
  }

  private async requireChat(handoffId: string): Promise<DispatchChatRow> {
    const chat = await this.dispatchChats.byHandoffId(handoffId);
    if (!chat) throw SysError.notFound('Chat', { handoffId });
    return chat;
  }

  private requireChatMessage(chat: DispatchChatRow, messageId: string): AiMessage {
    const message = chat.messages.find((candidate) => candidate.id === messageId);
    if (!message) throw SysError.notFound('Message', { messageId });
    return message;
  }

  private publishChatMessages(chat: DispatchChatRow, messageIds: readonly string[]): void {
    for (const messageId of messageIds) {
      const message = chat.messages.find((candidate) => candidate.id === messageId);
      if (message) {
        this.chatBus.publishMessage({
          conversationId: chat.conversation.id,
          handoffId: chat.handoff.id,
          message,
        });
      }
    }
  }

  private publishChatState(chat: DispatchChatRow): void {
    this.chatBus.publishState({ conversation: chat.conversation, handoff: chat.handoff });
  }
}
