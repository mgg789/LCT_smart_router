import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { Clock } from '../../common/time';
import {
  EMPTY_PROVIDER_OUTCOME,
  type LlmStreamEvent,
  type LlmTurnInput,
  type ProviderOutcome,
} from './llm.types';
import { LlmProvider } from './llm-provider.port';

/**
 * Offline stand-in for a real model, and what makes the demo contour work with no
 * network at all (AGENTS.md section 4.7).
 *
 * Fixtures are addressed two ways: `AI_REPLAY_SCENARIO` forces one file regardless of
 * what was typed, which is how a scripted demo step gets a guaranteed answer; absent
 * that, the file is chosen by a hash of the last user message, normalised so trivial
 * whitespace differences still hit the same fixture. Anything that does not resolve to a
 * file -- including a judge typing freely at the demo -- gets one fixed, honest sentence
 * rather than a crash or a fabricated answer. That fallback is the one behaviour this
 * class must never fail to provide, so every I/O and parse error along the way is
 * swallowed and logged, never thrown.
 */
@Injectable()
export class ReplayProvider extends LlmProvider {
  /** Reaches the chat as an assistant reply, so it is written in the product's language
   *  rather than in the language of the code around it. */
  private static readonly FALLBACK_TEXT =
    'Сейчас работает автономный режим без обращения к модели, и на этот вопрос нет ' +
    'записанного ответа. Спросите диспетчера или попробуйте один из готовых сценариев.';

  private readonly logger = new Logger(ReplayProvider.name);
  private outcome: ProviderOutcome = EMPTY_PROVIDER_OUTCOME;

  readonly kind = 'replay' as const;

  constructor(
    private readonly directory: string,
    private readonly forcedScenario: string | undefined,
    private readonly clock: Clock,
  ) {
    super();
  }

  isConfigured(): boolean {
    return true;
  }

  async *turn(input: LlmTurnInput): AsyncIterable<LlmStreamEvent> {
    if (input.signal.aborted) {
      yield abortedEvent();
      return;
    }

    const lastUserText =
      [...input.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const fixture = await this.loadFixture(lastUserText);
    const text = fixture?.reply ?? ReplayProvider.FALLBACK_TEXT;
    const chunkSize = fixture?.chunkSize ?? 48;

    if (fixture?.reasoningContent) {
      yield { type: 'reasoning', content: fixture.reasoningContent };
    }

    const chunkDelayMs = fixture?.chunkDelayMs ?? DEFAULT_CHUNK_DELAY_MS;
    for (let index = 0; index < text.length; index += chunkSize) {
      if (input.signal.aborted) {
        yield abortedEvent();
        this.recordOk();
        return;
      }
      if (index > 0) {
        await delay(chunkDelayMs);
      }
      yield { type: 'text_delta', text: text.slice(index, index + chunkSize) };
    }

    for (const call of fixture?.toolCalls ?? []) {
      yield {
        type: 'tool_call',
        call: { id: call.id ?? randomUUID(), name: call.name, arguments: call.arguments },
      };
    }

    yield {
      type: 'done',
      finishReason: fixture?.toolCalls && fixture.toolCalls.length > 0 ? 'tool_calls' : 'stop',
      usage: {
        promptTokens: fixture?.usage?.promptTokens ?? estimateTokens(lastUserText),
        completionTokens: fixture?.usage?.completionTokens ?? estimateTokens(text),
      },
    };
    this.recordOk();
  }

  lastOutcome(): ProviderOutcome {
    return this.outcome;
  }

  private recordOk(): void {
    this.outcome = {
      lastOkAt: this.clock.nowSeconds(),
      lastFailureAt: this.outcome.lastFailureAt,
      consecutiveFailures: 0,
      authFailed: false,
      lastErrorMessage: null,
    };
  }

  private async loadFixture(lastUserText: string): Promise<ReplayFixture | null> {
    const key = this.forcedScenario ?? fixtureKey(lastUserText);
    try {
      const raw = await readFile(join(this.directory, `${key}.json`), 'utf8');
      const parsed = replayFixtureSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        this.logger.debug(`Replay fixture ${key} failed validation: ${parsed.error.message}`);
        return null;
      }
      return parsed.data;
    } catch (error) {
      // A missing fixture is the expected, common case (free-typed input); only log it
      // at debug level. Any other failure (unreadable directory, bad JSON) degrades the
      // same way -- this provider must never throw out of a demo run.
      this.logger.debug(
        `No replay fixture for key ${key}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }
}

const replayFixtureSchema = z.object({
  reply: z.string().min(1),
  reasoningContent: z.string().optional(),
  toolCalls: z
    .array(z.object({ id: z.string().optional(), name: z.string().min(1), arguments: z.unknown() }))
    .optional(),
  usage: z
    .object({
      promptTokens: z.number().int().nonnegative(),
      completionTokens: z.number().int().nonnegative(),
    })
    .optional(),
  /** Characters per `text_delta`, so a fixture can exercise the streaming UI realistically. */
  chunkSize: z.number().int().positive().max(2000).optional(),
  /**
   * Milliseconds to wait between deltas.
   *
   * A real provider paces its own output over the network, and the offline contour has to
   * look like the thing it stands in for: without a pause the whole answer is emitted in
   * one synchronous burst, so a demo shows finished text instead of text arriving, and a
   * reader that attaches a moment later sees no deltas at all -- they are deliberately not
   * persisted, so anything emitted before the first subscriber is gone. Default is the
   * smallest pause that still yields to the event loop.
   */
  chunkDelayMs: z.number().int().nonnegative().max(2000).optional(),
});
type ReplayFixture = z.infer<typeof replayFixtureSchema>;

/**
 * Pause between replayed deltas when a fixture does not choose one. Small enough to keep
 * tests fast, large enough that the loop actually yields, which is what lets a subscriber
 * attach mid-answer instead of finding the run already over.
 */
const DEFAULT_CHUNK_DELAY_MS = 25;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/** Deterministic file key: trimmed, lower-cased and whitespace-collapsed so "Hello!" and
 *  "  hello!  " hit the same recorded fixture. */
export function fixtureKey(userText: string): string {
  const normalized = userText.trim().toLowerCase().replace(/\s+/g, ' ');
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

function abortedEvent(): LlmStreamEvent {
  return { type: 'done', finishReason: 'aborted', usage: { promptTokens: 0, completionTokens: 0 } };
}

/** A cheap, offline stand-in for a token count: real providers report their own. */
function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
