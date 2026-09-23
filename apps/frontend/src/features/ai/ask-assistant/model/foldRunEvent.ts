import type { AiActionButton, AiPreviewRow, AiRunEvent } from '@/entities/conversation';

export type Rating = 'up' | 'down' | null;

/** A card the assistant prepared, as it stands right now. */
export interface OperationCard {
  operationId: string;
  action: string;
  state: string;
  preview: AiPreviewRow[];
  /** Filled once a state carries one — a refusal names its reason. */
  error: string | null;
}

export interface AssistantMessage {
  id: string;
  role: 'assistant';
  /** The question it answers, so «спросить ещё раз» can ask it again. */
  questionId: string;
  /** Grows while the run streams; null until the first token or verdict arrives. */
  text: string | null;
  /** Buttons the server attached to the finished reply (never assembled here). */
  actions: AiActionButton[];
  cards: OperationCard[];
  /** What the run did on the way — tool intents and results, in order. */
  notes: string[];
  /** True while the run is still open: the pill shows «Думает» and the dots run. */
  streaming: boolean;
  /** Seconds the run actually took, measured between its first and last event. */
  thoughtSec: number | null;
  /** A terminal failure the stream reported, or the reason a run stopped early. */
  failure: string | null;
  /** The dispatcher's thumbs; kept in the tab — the contract has nowhere to send them. */
  rating: Rating;
}

export const STOP_REASON: Record<string, string> = {
  user: 'Остановлено вами.',
  handover: 'Диалог передан диспетчеру — ассистент замолчал.',
  budget: 'Закончился дневной бюджет ассистента.',
  shutdown: 'Сервер остановил запуск.',
};

/** A fresh answer, before its run has said anything. */
export function blankAnswer(id: string, questionId: string): AssistantMessage {
  return {
    id,
    role: 'assistant',
    questionId,
    text: null,
    actions: [],
    cards: [],
    notes: [],
    streaming: true,
    thoughtSec: null,
    failure: null,
    rating: null,
  };
}

/**
 * Folds one run event into the answer it belongs to.
 *
 * Kept pure and separate from the store so the rules that matter can be checked
 * without a socket: a delta appends, a finished `message` replaces the draft it
 * was building (it is the text the server persisted, and the only one carrying
 * buttons), and a failure is whatever the stream reported rather than something
 * inferred from a missing reply.
 *
 * Events that change the dialogue rather than this answer — `run_started`,
 * `quota`, `mode_changed` — return the message unchanged; the store reads those
 * separately.
 */
export function foldRunEvent(
  message: AssistantMessage,
  event: AiRunEvent,
  startedAt: number,
): AssistantMessage {
  switch (event.type) {
    case 'message_delta':
      return { ...message, text: (message.text ?? '') + event.text };
    case 'message':
      return { ...message, text: event.text, actions: [...event.actions] };
    case 'tool_started':
      return { ...message, notes: [...message.notes, event.intent] };
    case 'tool_result':
      return {
        ...message,
        notes: [...message.notes, event.ok ? event.summary : `Не удалось: ${event.summary}`],
      };
    case 'operation_prepared':
      return {
        ...message,
        cards: [
          ...message.cards,
          {
            operationId: event.operationId,
            action: event.action,
            state: event.state,
            preview: [...event.preview],
            error: null,
          },
        ],
      };
    case 'operation_state':
      return {
        ...message,
        cards: message.cards.map((card) =>
          card.operationId === event.operationId
            ? { ...card, state: event.state, error: event.error?.message ?? card.error }
            : card,
        ),
      };
    case 'stopped':
      return { ...message, failure: STOP_REASON[event.reason] ?? 'Запуск прерван.' };
    case 'error':
      return { ...message, failure: `${event.message} (${event.code})` };
    case 'run_finished':
      return {
        ...message,
        streaming: false,
        // Whole seconds between the run's own clock and when it was asked for.
        thoughtSec: Math.max(0, Math.round(event.at - startedAt)),
      };
    default:
      return message;
  }
}
