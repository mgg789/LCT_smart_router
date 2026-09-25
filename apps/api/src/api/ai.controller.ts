import {
  Body,
  Controller,
  Get,
  Logger,
  type MessageEvent,
  Param,
  Post,
  Query,
  Sse,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  catchError,
  EMPTY,
  endWith,
  ignoreElements,
  interval,
  map,
  merge,
  Observable,
  of,
  share,
  takeUntil,
} from 'rxjs';
import {
  AgentRuntimeService,
  AiOperationService,
  type AiRunEvent,
  BudgetService,
  ChatEventBus,
  ConversationService,
  DispatchChatsService,
  isTerminalAiEvent,
  type OperationOutcomeView,
  RoleProfileService,
  RunRegistry,
  StopService,
} from '../ai';
import { AlertResolverService } from '../ai/alerts';
import { ExplainService } from '../ai/explain';
import { type Actor, CurrentActor, effectiveRole } from '../auth';
import { AppConfigService } from '../common/config';
import { SysError } from '../common/errors';
import { Clock } from '../common/time';
import { zodBody } from '../common/validation';
import type { AiConversation } from '../generated/prisma/client';
import { OperationsService } from '../operations';
import { PrismaService } from '../persistence';
import {
  type AiConversationView,
  type AiMessageView,
  toConversationView,
  toMessageView,
} from './ai-view';
import { type ChatStreamEvent, chatEventStream, toChatMessageEvent } from './chat-stream';
import { toHandoffView } from './dispatch-chat-view';
import {
  type AfterSeqQueryDto,
  afterSeqQuerySchema,
  type ConfirmAiOperationDto,
  type CreateAiConversationDto,
  confirmAiOperationSchema,
  createAiConversationSchema,
  type ExplainRequestDto,
  explainRequestSchema,
  type PostAiMessageDto,
  postAiMessageSchema,
  type SetAiAssistModeDto,
  type SuggestAlertResolutionDto,
  setAiAssistModeSchema,
  suggestAlertResolutionSchema,
} from './dto/ai.dto';
import { fromAsync } from './sse';

interface SendMessageResponse {
  readonly runId: string | null;
  readonly messageSeq: number;
  readonly handedOver: boolean;
  readonly quota?: {
    readonly remainingMicros: number;
    readonly remainingMessages: number;
    readonly resetAt: number;
  };
}

/**
 * The one HTTP surface every app contour's chat talks to.
 *
 * Open to any of the three roles (a `@Roles` restriction would defeat the point: client,
 * engineer and dispatcher all use this same contract, each in their own lane -- see
 * `ConversationService`'s doc comment on why the lane is the `roleProfile`, not the
 * controller route).
 *
 * **Authorization**: an integration key (`actor.accountId === null`) is refused outright.
 * It has no confirmed email, so there is no budget owner and no history owner for it to
 * spend or read (context/41 section 3.2 applies here the same way it does to
 * `client.notification_settings`).
 */
@ApiTags('ai')
@Controller('ai')
export class AiController {
  constructor(
    private readonly conversations: ConversationService,
    private readonly runtime: AgentRuntimeService,
    private readonly budgets: BudgetService,
    private readonly stop: StopService,
    private readonly registry: RunRegistry,
    private readonly operations: OperationsService,
    private readonly aiOperations: AiOperationService,
    private readonly roleProfiles: RoleProfileService,
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly config: AppConfigService,
    private readonly explain: ExplainService,
    private readonly alertResolver: AlertResolverService,
    private readonly chatEvents: ChatEventBus,
    private readonly dispatchChats: DispatchChatsService,
  ) {}

  private readonly logger = new Logger(AiController.name);

  @Post('explain')
  @ApiOperation({
    summary:
      'Dispatcher-only explanation micro-agent: single-step, no-tool, temperature-0 run seeded with calculation-backed context',
  })
  async explainSelection(
    @CurrentActor() actor: Actor,
    @Body(zodBody(explainRequestSchema)) dto: ExplainRequestDto,
  ): Promise<{ runId: string }> {
    this.requireAccount(actor);
    if (effectiveRole(actor) !== 'dispatcher') {
      // An honest explanation needs the roster -- who else was idle, who else had the
      // skill -- which a customer must never see (task brief for `src/ai/explain/**`).
      // `client` is therefore not an offered scope at all, and this whole surface is
      // dispatcher-only.
      throw SysError.forbidden('Explanations are a dispatcher tool');
    }
    return this.explain.startExplainRun(actor, dto);
  }

  @Post('alerts/:id/suggest')
  @ApiOperation({
    summary:
      'LLM-assisted alert resolution proposal, prepared through the alert.resolve operation spine',
  })
  async suggestAlertResolution(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body(zodBody(suggestAlertResolutionSchema)) _dto: SuggestAlertResolutionDto,
  ) {
    this.requireAccount(actor);
    if (effectiveRole(actor) !== 'dispatcher') {
      throw SysError.forbidden('Alert resolution suggestions are a dispatcher tool');
    }
    return this.alertResolver.suggest(actor, id);
  }

  @Post('conversations')
  @ApiOperation({ summary: 'Get or create the open conversation for this account and lane' })
  async openConversation(
    @CurrentActor() actor: Actor,
    @Body(zodBody(createAiConversationSchema)) dto: CreateAiConversationDto,
  ): Promise<{ conversation: AiConversationView }> {
    const accountId = this.requireAccount(actor);
    const role = effectiveRole(actor);
    if (!role) {
      throw SysError.forbidden('This actor has no role to open a conversation as');
    }
    if (role === 'dispatcher' && dto.assistMode !== undefined) {
      // The single dispatcher's lane is durable, not per-conversation (role-profile.ts's
      // own note on why): an explicit `assistMode` moves it, and a plain open -- no
      // `assistMode` -- leaves it exactly where it was, it does not reset it to `help`
      // on every new tab.
      await this.roleProfiles.setDispatcherAssistMode(dto.assistMode);
    }
    const roleProfile = await this.roleProfiles.forActor(actor);
    const conversation = await this.conversations.getOrCreate({
      accountId,
      role,
      roleProfile,
      contextRef: dto.contextRef ?? null,
    });
    return { conversation: toConversationView(conversation) };
  }

  @Post('conversations/:id/assist-mode')
  @ApiOperation({ summary: 'Switch the dispatcher lane between help and fix' })
  async setAssistMode(
    @CurrentActor() actor: Actor,
    @Param('id') conversationId: string,
    @Body(zodBody(setAiAssistModeSchema)) dto: SetAiAssistModeDto,
  ): Promise<{ conversation: AiConversationView }> {
    const accountId = this.requireAccount(actor);
    if (effectiveRole(actor) !== 'dispatcher') {
      throw SysError.forbidden('Only a dispatcher switches the assistant lane');
    }
    await this.roleProfiles.setDispatcherAssistMode(dto.assistMode);
    const conversation = await this.conversations.setDispatcherAssistMode(
      accountId,
      conversationId,
      dto.assistMode,
      this.clock.nowSeconds(),
    );
    return { conversation: toConversationView(conversation) };
  }

  @Post('conversations/:id/clear')
  @ApiOperation({ summary: 'Close this dialogue so the next open starts empty' })
  async clearConversation(
    @CurrentActor() actor: Actor,
    @Param('id') conversationId: string,
  ): Promise<{ closed: true }> {
    const accountId = this.requireAccount(actor);
    const now = this.clock.nowSeconds();
    const closed = await this.conversations.closeForAccount(accountId, conversationId, now);
    await this.conversations.closeOpenLane(accountId, closed.roleProfile, now);
    return { closed: true };
  }

  @Get('conversations/:id/messages')
  @ApiOperation({ summary: 'The tail of a conversation after a given message sequence' })
  async listMessages(
    @CurrentActor() actor: Actor,
    @Param('id') conversationId: string,
    @Query(zodBody(afterSeqQuerySchema)) query: AfterSeqQueryDto,
  ): Promise<{ messages: AiMessageView[]; conversation: AiConversationView }> {
    const conversation = await this.assertOwned(actor, conversationId);
    const messages = await this.conversations.listMessages(conversationId, query.afterSeq);
    return {
      messages: messages.map(toMessageView),
      conversation: toConversationView(conversation),
    };
  }

  @Post('conversations/:id/messages')
  @ApiOperation({
    summary: 'Send a message; starts a run unless the conversation was handed to a dispatcher',
  })
  async sendMessage(
    @CurrentActor() actor: Actor,
    @Param('id') conversationId: string,
    @Body(zodBody(postAiMessageSchema)) dto: PostAiMessageDto,
  ): Promise<SendMessageResponse> {
    const accountId = this.requireAccount(actor);
    const conversation = await this.assertOwned(actor, conversationId);

    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'ai.message.send',
        targetRef: conversationId,
        payload: dto,
      },
      async (context) => {
        const message = await this.conversations.appendMessage(
          context.tx,
          conversationId,
          context.now,
          {
            author: 'user',
            kind: 'text',
            text: dto.text,
            operationId: dto.operationId,
            authorAccountId: accountId,
          },
        );
        // A message written into a handed-over dialogue is the dispatcher's to answer,
        // so the chat goes back to "needs a reply" and their badge counts it. Returns
        // `null` for an ordinary assistant conversation, which is not their business.
        const handoff = await this.dispatchChats.markAwaitingDispatcher(context.tx, conversationId);
        return { messageSeq: message.seq, messageId: message.id, handoffId: handoff?.id ?? null };
      },
    );

    // Published after the transaction commits, never inside it (`ChatEventBus`'s own note
    // on why), and not at all on a replayed retry -- the first attempt already announced
    // this message, and a dispatcher seeing it twice would read it as the person repeating
    // themselves.
    if (!outcome.replayed) {
      const written = await this.prisma.aiMessage.findUnique({
        where: { id: outcome.result.messageId },
      });
      if (written) {
        this.chatEvents.publishMessage({
          conversationId,
          handoffId: outcome.result.handoffId,
          message: written,
        });
      }
    }

    if (conversation.mode === 'dispatcher') {
      // The assistant stays silent for the rest of this dialogue (schema.prisma's own
      // comment on `AiConversationMode`): no run, no quota spent.
      return { runId: null, messageSeq: outcome.result.messageSeq, handedOver: true };
    }

    if (outcome.replayed) {
      const previous = await this.prisma.aiMessage.findFirst({
        where: { conversationId, operationId: dto.operationId },
      });
      if (previous?.runId) {
        const quota = await this.budgets.snapshot(accountId);
        return {
          runId: previous.runId,
          messageSeq: outcome.result.messageSeq,
          handedOver: false,
          quota,
        };
      }
      // The earlier attempt never got as far as starting a run -- a narrow crash window
      // between the message write and the run start. Starting one now is the safer
      // outcome: a silently unanswered message is worse than one extra run in that rare
      // retry window.
    }

    const started = await this.runtime.startRun({ conversation, actor });
    await this.prisma.aiMessage.updateMany({
      where: { conversationId, operationId: dto.operationId, runId: null },
      data: { runId: started.runId },
    });
    return {
      runId: started.runId,
      messageSeq: outcome.result.messageSeq,
      handedOver: false,
      quota: started.quota,
    };
  }

  /**
   * Server-sent events for one dialogue: every message written into it, by whoever, plus
   * the current mode whenever it changes hands.
   *
   * This is what makes a dispatcher's reply appear in the customer's chat the moment it is
   * sent, with no run to attach to -- a human answering is not a model call, so there is no
   * `runId` and `runs/:runId/events` has nothing to stream. Resumable exactly like that
   * endpoint (`?afterSeq=` is the last message `seq` the reader rendered), and open to both
   * modes on purpose: a reader does not have to tear the connection down and open another
   * one when the assistant hands the dialogue over or takes it back.
   */
  @Sse('conversations/:id/events')
  @ApiOperation({ summary: 'Server-sent events for one dialogue, resumable with ?afterSeq=' })
  async conversationEvents(
    @CurrentActor() actor: Actor,
    @Param('id') conversationId: string,
    @Query(zodBody(afterSeqQuerySchema)) query: AfterSeqQueryDto,
  ): Promise<Observable<MessageEvent>> {
    await this.assertOwned(actor, conversationId);

    const heartbeatMs = this.config.get('AI_SSE_HEARTBEAT_MS');
    const heartbeat$: Observable<MessageEvent> = interval(heartbeatMs).pipe(
      map(() => ({ type: 'heartbeat', data: {} }) satisfies MessageEvent),
    );

    const main$: Observable<MessageEvent> = chatEventStream({
      live: this.chatEvents.forConversation(conversationId),
      replay: () => this.replayConversation(conversationId, query.afterSeq),
    }).pipe(
      map(toChatMessageEvent),
      catchError((error: unknown) => {
        // The global exception filter answers with `response.status().json()`, which after
        // SSE headers are sent is `ERR_HTTP_HEADERS_SENT` and a dead socket, so this stream
        // must never error. Unlike a run, a chat has no terminal event to end on honestly:
        // completing the response is what a reader already handles, because it is also what
        // an ordinary network drop looks like, and their next `?afterSeq=` loses nothing.
        this.logger.error(
          `Chat stream for conversation ${conversationId} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return EMPTY;
      }),
      share(),
    );
    const stop$ = main$.pipe(ignoreElements(), endWith(true));

    return merge(main$, heartbeat$).pipe(takeUntil(stop$));
  }

  @Sse('runs/:runId/events')
  @ApiOperation({ summary: 'Server-sent events for one run, resumable with ?afterSeq=' })
  async runEvents(
    @CurrentActor() actor: Actor,
    @Param('runId') runId: string,
    @Query(zodBody(afterSeqQuerySchema)) query: AfterSeqQueryDto,
  ): Promise<Observable<MessageEvent>> {
    const run = await this.prisma.aiRun.findUnique({ where: { id: runId } });
    if (!run || run.accountId !== actor.accountId) {
      throw SysError.notFound('Run', { runId });
    }

    const heartbeatMs = this.config.get('AI_SSE_HEARTBEAT_MS');
    const heartbeat$: Observable<MessageEvent> = interval(heartbeatMs).pipe(
      map(() => ({ type: 'heartbeat', data: {} }) satisfies MessageEvent),
    );

    // The global exception filter answers with `response.status().json()`, which after
    // SSE headers are sent is `ERR_HTTP_HEADERS_SENT` and a dead socket with no usable
    // body (ai-event.types.ts's own note on `error`). This stream must therefore never
    // error: any failure becomes one terminal `error` event followed by `run_finished`
    // instead of propagating.
    const main$: Observable<MessageEvent> = fromAsync(
      this.streamRunEvents(runId, query.afterSeq),
    ).pipe(
      map((event) => toMessageEvent(event)),
      catchError((error: unknown) => {
        const now = this.clock.nowSeconds();
        const message =
          error instanceof Error ? error.message : 'The event stream failed unexpectedly';
        return of(
          toMessageEvent({ type: 'error', seq: -1, at: now, code: 'INTERNAL_ERROR', message }),
          toMessageEvent({
            type: 'run_finished',
            seq: -1,
            at: now,
            state: 'failed',
            usage: { promptTokens: 0, completionTokens: 0, costMicros: 0 },
          }),
        );
      }),
      share(),
    );
    const stop$ = main$.pipe(ignoreElements(), endWith(true));

    return merge(main$, heartbeat$).pipe(takeUntil(stop$));
  }

  @Post('runs/:runId/stop')
  @ApiOperation({ summary: 'Ask a running assistant turn to stop' })
  async stopRun(
    @CurrentActor() actor: Actor,
    @Param('runId') runId: string,
  ): Promise<{ stopped: boolean }> {
    const run = await this.prisma.aiRun.findUnique({ where: { id: runId } });
    if (!run || run.accountId !== actor.accountId) {
      throw SysError.notFound('Run', { runId });
    }
    await this.stop.requestStop(runId, 'user');
    return { stopped: true };
  }

  @Post('operations/:id/apply')
  @ApiOperation({ summary: 'Confirm a prepared AI operation and apply it' })
  async applyOperation(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body(zodBody(confirmAiOperationSchema)) dto: ConfirmAiOperationDto,
  ): Promise<OperationOutcomeView> {
    this.requireAccount(actor);
    return this.aiOperations.confirm({ actor, aiOperationId: id, operationId: dto.operationId });
  }

  @Post('operations/:id/cancel')
  @ApiOperation({ summary: 'Withdraw a prepared AI operation before it is applied' })
  async cancelOperation(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    // Validated for shape consistency with `apply`, even though cancelling never opens a
    // second, independently-idempotent business write of its own.
    @Body(zodBody(confirmAiOperationSchema)) _dto: ConfirmAiOperationDto,
  ): Promise<OperationOutcomeView> {
    this.requireAccount(actor);
    return this.aiOperations.cancel({ actor, aiOperationId: id });
  }

  /**
   * Replays the persisted tail of a run and then follows it live, without losing an
   * event produced in the gap between the two: the live subscription is opened *before*
   * the database read, so anything multicast during that read lands in `queue` and is
   * replayed (deduplicated by `seq`) once the persisted tail has been drained, rather
   * than being missed the way it would be if the subscription started only afterwards.
   */
  private async *streamRunEvents(runId: string, afterSeq: number): AsyncGenerator<AiRunEvent> {
    const handle = this.registry.get(runId);
    const queue: AiRunEvent[] = [];
    let wake: (() => void) | null = null;
    const subscription = handle?.events.subscribe((event) => {
      queue.push(event);
      const resolve = wake;
      wake = null;
      resolve?.();
    });

    try {
      const rows = await this.prisma.aiRunEvent.findMany({
        where: { runId, seq: { gt: afterSeq } },
        orderBy: { seq: 'asc' },
      });
      let lastSeq = afterSeq;
      for (const row of rows) {
        const event = row.payload as unknown as AiRunEvent;
        lastSeq = event.seq;
        yield event;
        if (isTerminalAiEvent(event)) {
          return;
        }
      }

      for (;;) {
        while (queue.length > 0) {
          const event = queue.shift() as AiRunEvent;
          if (event.seq > lastSeq) {
            lastSeq = event.seq;
            yield event;
            if (isTerminalAiEvent(event)) {
              return;
            }
          }
        }
        if (!subscription) {
          // No live handle: the run already ended (its terminal event was already
          // yielded above from the persisted tail) or belongs to a process that is gone,
          // in which case the startup sweep already gave it a truthful ending.
          return;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      subscription?.unsubscribe();
    }
  }

  /**
   * What a reader missed, as stream events: the messages after their cursor, then the
   * dialogue's current mode and chat.
   *
   * The state event comes last on purpose -- it is the present, and the messages are the
   * past. `at` is the moment of replay rather than of writing; each message carries its own
   * `createdAt`, which is the timestamp a reader renders.
   */
  private async replayConversation(
    conversationId: string,
    afterSeq: number,
  ): Promise<ChatStreamEvent[]> {
    const at = this.clock.nowSeconds();
    const [messages, conversation, handoff] = await Promise.all([
      this.conversations.listMessages(conversationId, afterSeq),
      this.prisma.aiConversation.findUnique({ where: { id: conversationId } }),
      this.prisma.aiHandoff.findFirst({
        where: { conversationId },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    const events: ChatStreamEvent[] = messages.map((message) => ({
      type: 'message',
      at,
      conversationId,
      message: toMessageView(message),
    }));
    if (conversation) {
      events.push({
        type: 'state',
        at,
        conversationId,
        mode: conversation.mode,
        handoff: handoff ? toHandoffView(handoff) : null,
      });
    }
    return events;
  }

  private requireAccount(actor: Actor): string {
    if (!actor.accountId) {
      throw SysError.forbidden(
        'An integration key has no confirmed email to own a chat or its budget',
      );
    }
    return actor.accountId;
  }

  private async assertOwned(actor: Actor, conversationId: string): Promise<AiConversation> {
    this.requireAccount(actor);
    const conversation = await this.conversations.byId(conversationId);
    if (!conversation || conversation.accountId !== actor.accountId) {
      // Reported as absent rather than forbidden, the same convention `assertOwned` in
      // `client.controller.ts` uses: confirming someone else's conversation exists is
      // itself a disclosure.
      throw SysError.notFound('Conversation', { conversationId });
    }
    return conversation;
  }
}

function toMessageEvent(event: AiRunEvent): MessageEvent {
  return { type: event.type, data: event, id: String(event.seq) };
}
