import { Body, Controller, Get, type MessageEvent, Param, Post, Query, Sse } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  catchError,
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
  type AiRunEvent,
  BudgetService,
  ConversationService,
  isTerminalAiEvent,
  RunRegistry,
  StopService,
} from '../ai';
import { type Actor, CurrentActor, effectiveRole } from '../auth';
import { AppConfigService } from '../common/config';
import { SysError } from '../common/errors';
import { Clock } from '../common/time';
import { zodBody } from '../common/validation';
import type { AiConversation, AiRoleProfile } from '../generated/prisma/client';
import { OperationsService } from '../operations';
import { PrismaService } from '../persistence';
import {
  type AiConversationView,
  type AiMessageView,
  toConversationView,
  toMessageView,
} from './ai-view';
import {
  type AfterSeqQueryDto,
  afterSeqQuerySchema,
  type CreateAiConversationDto,
  createAiConversationSchema,
  type PostAiMessageDto,
  postAiMessageSchema,
} from './dto/ai.dto';

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
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly config: AppConfigService,
  ) {}

  @Post('conversations')
  @ApiOperation({ summary: 'Get or create the open conversation for this account and lane' })
  async openConversation(
    @CurrentActor() actor: Actor,
    @Body(zodBody(createAiConversationSchema)) dto: CreateAiConversationDto,
  ): Promise<{ conversation: AiConversationView }> {
    const accountId = this.requireAccount(actor);
    const roleProfile = this.roleProfileFor(actor, dto.assistMode);
    const role = effectiveRole(actor);
    if (!role) {
      throw SysError.forbidden('This actor has no role to open a conversation as');
    }
    const conversation = await this.conversations.getOrCreate({
      accountId,
      role,
      roleProfile,
      contextRef: dto.contextRef ?? null,
    });
    return { conversation: toConversationView(conversation) };
  }

  @Get('conversations/:id/messages')
  @ApiOperation({ summary: 'The tail of a conversation after a given message sequence' })
  async listMessages(
    @CurrentActor() actor: Actor,
    @Param('id') conversationId: string,
    @Query(zodBody(afterSeqQuerySchema)) query: AfterSeqQueryDto,
  ): Promise<{ messages: AiMessageView[] }> {
    await this.assertOwned(actor, conversationId);
    const messages = await this.conversations.listMessages(conversationId, query.afterSeq);
    return { messages: messages.map(toMessageView) };
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
        return { messageSeq: message.seq };
      },
    );

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

  private requireAccount(actor: Actor): string {
    if (!actor.accountId) {
      throw SysError.forbidden(
        'An integration key has no confirmed email to own a chat or its budget',
      );
    }
    return actor.accountId;
  }

  private roleProfileFor(actor: Actor, assistMode: 'help' | 'fix' | undefined): AiRoleProfile {
    const role = effectiveRole(actor);
    if (role === 'dispatcher') {
      return assistMode === 'fix' ? 'dispatcher_fix' : 'dispatcher_readonly';
    }
    if (role === 'client' || role === 'engineer') {
      return role;
    }
    throw SysError.forbidden('This actor has no role to open a conversation as');
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

/** Adapts an async generator to an RxJS `Observable`, since `Sse()` needs one. */
function fromAsync<T>(source: AsyncGenerator<T>): Observable<T> {
  return new Observable<T>((subscriber) => {
    let cancelled = false;
    void (async () => {
      try {
        for await (const value of source) {
          if (cancelled) {
            return;
          }
          subscriber.next(value);
        }
        subscriber.complete();
      } catch (error) {
        subscriber.error(error);
      }
    })();
    return () => {
      cancelled = true;
      void source.return?.(undefined);
    };
  });
}
