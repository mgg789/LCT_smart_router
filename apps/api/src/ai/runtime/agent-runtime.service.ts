import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Actor } from '../../auth';
import { AppConfigService } from '../../common/config';
import { SysError } from '../../common/errors';
import { Clock } from '../../common/time';
import type { AiConversation } from '../../generated/prisma/client';
import { PrismaService, UnitOfWork } from '../../persistence';
import {
  type LlmMessage,
  LlmProvider,
  type LlmToolCall,
  type LlmToolSpec,
  type LlmTurnInput,
  type RetryRunResult,
  runProviderTurn,
} from '../provider';
import type { AiRunEvent, AiRunState } from './ai-event.types';
import { type BudgetReservation, BudgetService } from './budget.service';
import { ConversationService } from './conversation.service';
import { RunEventBus } from './run-event.bus';
import { type RunHandle, RunRegistry } from './run-registry';
import { RunStoppedSignal, StopService } from './stop.service';
import { ToolDispatcher } from './tool-dispatcher';

/** DI token for the optional secondary provider chosen by `LLM_FALLBACK_PROVIDER`. Kept
 *  separate from the `LlmProvider` token itself, which is always the primary: the two
 *  need independent bindings (e.g. `replay` as primary and `openai_chat` as fallback are
 *  two different concrete instances of possibly the same class). */
export const AI_FALLBACK_PROVIDER = Symbol('AI_FALLBACK_PROVIDER');

export interface StartRunInput {
  readonly conversation: AiConversation;
  readonly actor: Actor;
}

export interface StartRunResult {
  readonly runId: string;
  readonly quota: {
    readonly remainingMicros: number;
    readonly remainingMessages: number;
    readonly resetAt: number;
  };
}

/**
 * The run loop: reserve budget, start a run, drive the provider turn by turn, persist the
 * assistant's answer, end with `run_finished`.
 *
 * The loop is started and returns to the caller (the controller) as soon as the run row
 * exists and its opening events are journalled -- `drive()` then continues in the
 * background, and a client follows it exclusively through `GET /ai/runs/:id/events`. That
 * split exists because starting a run and watching it are two different HTTP requests in
 * this contract (a `POST` and an `@Sse()` `GET`), and the SSE transport is what is
 * required to never error (ai-event.types.ts); the `POST` handler is not it.
 *
 * Tool execution is deliberately not implemented here: `ToolDispatcher` is a seam a later
 * piece of work fills in with the real catalogue and the prepare/confirm spine. Passing
 * an empty tool list keeps this loop exercising the full turn/tool-call/tool-result shape
 * end to end today, against `NoopToolDispatcher`, without inventing business behaviour
 * that belongs to that later change.
 */
@Injectable()
export class AgentRuntimeService implements OnModuleInit {
  private readonly logger = new Logger(AgentRuntimeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly config: AppConfigService,
    private readonly conversations: ConversationService,
    private readonly budgets: BudgetService,
    private readonly registry: RunRegistry,
    private readonly bus: RunEventBus,
    private readonly stop: StopService,
    private readonly provider: LlmProvider,
    @Inject(AI_FALLBACK_PROVIDER) private readonly fallbackProvider: LlmProvider | null,
    private readonly toolDispatcher: ToolDispatcher,
  ) {}

  /**
   * A run a restart left in `running`/`stopping` can never be resumed -- its `RunHandle`
   * and everything in flight died with the old process. Marking it `failed` with a
   * terminal event here is what makes a client that reconnects to
   * `GET /ai/runs/:id/events` read a truthful ending instead of waiting forever on a run
   * nothing will ever finish.
   */
  async onModuleInit(): Promise<void> {
    await this.sweepOrphanedRuns();
  }

  private async sweepOrphanedRuns(): Promise<void> {
    const stuck = await this.prisma.aiRun.findMany({
      where: { state: { in: ['running', 'stopping'] } },
    });
    for (const run of stuck) {
      const now = this.clock.nowSeconds();
      const seq = run.lastEventSeq + 1;
      const event: AiRunEvent = {
        type: 'run_finished',
        seq,
        at: now,
        state: 'failed',
        usage: {
          promptTokens: run.promptTokens ?? 0,
          completionTokens: run.completionTokens ?? 0,
          costMicros: run.costMicros,
        },
      };
      await this.prisma.$transaction([
        this.prisma.aiRun.update({
          where: { id: run.id },
          data: {
            state: 'failed',
            finishedAt: BigInt(now),
            errorCode: 'AI_UNAVAILABLE',
            lastEventSeq: seq,
          },
        }),
        this.prisma.aiRunEvent.create({
          data: {
            runId: run.id,
            seq,
            type: event.type,
            payload: event as object,
            createdAt: BigInt(now),
          },
        }),
      ]);
      this.logger.warn(`Run ${run.id} was left ${run.state} by a restart; marked failed`);
    }
  }

  async startRun(input: StartRunInput): Promise<StartRunResult> {
    const accountId = input.actor.accountId;
    if (!accountId) {
      // The controller already refuses integration keys before reaching here; this is a
      // defensive backstop, not the primary enforcement point.
      throw new Error('AgentRuntimeService.startRun requires an actor with an account');
    }

    const reservation = await this.budgets.reserve(accountId);
    const quota = await this.budgets.snapshot(accountId);
    const now = this.clock.nowSeconds();

    const run = await this.prisma.aiRun.create({
      data: {
        conversationId: input.conversation.id,
        accountId,
        quotaDay: reservation.quotaDay,
        quotaAccountId: accountId,
        roleProfile: input.conversation.roleProfile,
        state: 'running',
        providerKind: this.provider.kind,
        model: this.config.get('LLM_MODEL'),
        reservedMicros: reservation.reservedMicros,
        startedAt: BigInt(now),
      },
    });

    const handle = this.registry.create(run.id);
    await this.bus.emit(handle, {
      type: 'run_started',
      runId: run.id,
      conversationId: input.conversation.id,
    });
    await this.bus.emit(handle, {
      type: 'quota',
      remainingMicros: quota.remainingMicros,
      remainingMessages: quota.remainingMessages,
      resetAt: quota.resetAt,
    });

    void this.drive(run.id, input.conversation, input.actor, accountId, reservation, handle).catch(
      (error: unknown) => {
        this.logger.error(
          `Unhandled failure driving run ${run.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    );

    return {
      runId: run.id,
      quota: {
        remainingMicros: quota.remainingMicros,
        remainingMessages: quota.remainingMessages,
        resetAt: quota.resetAt,
      },
    };
  }

  private async drive(
    runId: string,
    conversation: AiConversation,
    actor: Actor,
    accountId: string,
    reservation: BudgetReservation,
    handle: RunHandle,
  ): Promise<void> {
    const model = this.config.get('LLM_MODEL');
    const maxOutputTokens = this.config.get('LLM_MAX_OUTPUT_TOKENS');
    const maxAttempts = this.config.get('LLM_MAX_ATTEMPTS');
    const maxToolSteps = this.config.get('LLM_MAX_TOOL_STEPS');
    // The tool catalogue is a later piece of work; an empty list keeps this loop's shape
    // (turn -> tool_call -> dispatch -> tool_result -> next turn) real and testable
    // without the runtime inventing which tools exist.
    const tools: LlmToolSpec[] = [];

    let messages: LlmMessage[] = await this.conversations.historyWindow(
      conversation.id,
      this.config.get('AI_HISTORY_MESSAGES'),
    );

    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalAttempts = 0;
    let usedFallback = false;
    let finalState: AiRunState = 'completed';
    let terminalEvent: AiRunEvent | null = null;

    try {
      for (let step = 0; step < maxToolSteps; step += 1) {
        this.stop.checkpoint(runId);

        const turnInput: LlmTurnInput = {
          model,
          system: systemPromptFor(conversation.roleProfile),
          messages,
          tools,
          maxOutputTokens,
          signal: handle.abort.signal,
        };

        const messageId = randomUUID();
        let text = '';
        const toolCalls: LlmToolCall[] = [];
        const retryResult: { current: RetryRunResult } = {
          current: { providerKind: this.provider.kind, usedFallback: false, attempts: 0 },
        };
        let aborted = false;

        for await (const event of runProviderTurn(
          turnInput,
          this.provider,
          this.fallbackProvider,
          maxAttempts,
          retryResult,
        )) {
          this.stop.checkpoint(runId);
          if (event.type === 'text_delta') {
            text += event.text;
            await this.bus.emit(handle, { type: 'message_delta', messageId, text: event.text });
          } else if (event.type === 'tool_call') {
            toolCalls.push(event.call);
            await this.bus.emit(handle, {
              type: 'tool_started',
              toolName: event.call.name,
              intent: `Calling ${event.call.name}`,
            });
          } else if (event.type === 'done') {
            totalPromptTokens += event.usage.promptTokens;
            totalCompletionTokens += event.usage.completionTokens;
            aborted = event.finishReason === 'aborted';
          }
        }

        totalAttempts += retryResult.current.attempts;
        usedFallback = usedFallback || retryResult.current.usedFallback;

        if (aborted) {
          throw new RunStoppedSignal(handle.stopReason ?? 'user');
        }

        if (toolCalls.length === 0) {
          const messageRow = await this.uow.run((tx) =>
            this.conversations.appendMessage(tx, conversation.id, this.clock.nowSeconds(), {
              author: 'assistant',
              kind: 'text',
              text,
              runId,
            }),
          );
          terminalEvent = await this.bus.emit(handle, {
            type: 'message',
            messageId,
            messageSeq: messageRow.seq,
            kind: 'text',
            text,
            actions: [],
          });
          break;
        }

        const toolResults: LlmMessage[] = [];
        for (const call of toolCalls) {
          this.stop.checkpoint(runId);
          const result = await this.toolDispatcher.dispatch(call, {
            runId,
            conversationId: conversation.id,
            actor,
            roleProfile: conversation.roleProfile,
          });
          await this.bus.emit(handle, {
            type: 'tool_result',
            toolName: call.name,
            ok: result.ok,
            summary: result.summary,
          });
          toolResults.push({
            role: 'tool',
            toolCallId: call.id,
            name: call.name,
            content: result.resultContent,
          });
        }

        messages = [
          ...messages,
          { role: 'assistant', content: text.length > 0 ? text : null, toolCalls },
          ...toolResults,
        ];
      }

      if (!terminalEvent) {
        // The tool-step budget ran out without a final text turn: end truthfully rather
        // than silently dropping the last round of tool results on the floor.
        finalState = 'failed';
        terminalEvent = await this.bus.emit(handle, {
          type: 'error',
          code: 'AI_UNAVAILABLE',
          message: 'The assistant could not reach a final answer within its tool-step budget',
        });
      }
    } catch (error) {
      if (error instanceof RunStoppedSignal) {
        finalState = 'stopped';
        await this.bus.emit(handle, { type: 'stopped', reason: error.reason });
      } else {
        finalState = 'failed';
        const { code, message } = describeError(error);
        await this.bus.emit(handle, { type: 'error', code, message });
      }
    }

    const costMicros = costMicrosFor(totalPromptTokens, totalCompletionTokens, this.config);
    await this.budgets.settle(reservation, accountId, costMicros);

    let errorCode: string | null = null;
    if (finalState === 'failed' && terminalEvent && terminalEvent.type === 'error') {
      errorCode = terminalEvent.code;
    }

    const finishedAt = this.clock.nowSeconds();
    await this.prisma.aiRun.update({
      where: { id: runId },
      data: {
        state: finalState,
        finishedAt: BigInt(finishedAt),
        promptTokens: totalPromptTokens,
        completionTokens: totalCompletionTokens,
        costMicros,
        attempts: totalAttempts,
        usedFallback,
        errorCode: errorCode ?? (finalState === 'failed' ? 'AI_UNAVAILABLE' : null),
      },
    });

    await this.bus.emit(handle, {
      type: 'run_finished',
      state: finalState,
      usage: {
        promptTokens: totalPromptTokens,
        completionTokens: totalCompletionTokens,
        costMicros,
      },
    });

    this.registry.remove(runId);
    this.bus.forget(runId);
  }
}

function systemPromptFor(roleProfile: string): string {
  return (
    'You are the Navix field-engineer routing assistant. Answer concisely and factually. ' +
    `You are currently assisting in the "${roleProfile}" context. ` +
    'Never invent a status, a schedule or an action; only describe what tools or the ' +
    'conversation actually establish.'
  );
}

function costMicrosFor(
  promptTokens: number,
  completionTokens: number,
  config: AppConfigService,
): number {
  const perKPrompt = config.get('AI_UNITS_PER_1K_PROMPT_MICROS');
  const perKCompletion = config.get('AI_UNITS_PER_1K_COMPLETION_MICROS');
  return Math.round(
    (promptTokens / 1000) * perKPrompt + (completionTokens / 1000) * perKCompletion,
  );
}

function describeError(error: unknown): { code: string; message: string } {
  if (error instanceof SysError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: 'AI_UNAVAILABLE',
    message: error instanceof Error ? error.message : 'The run failed',
  };
}
