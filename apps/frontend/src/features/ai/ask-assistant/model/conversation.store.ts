import { create } from 'zustand';
import type { AiActionButton, AiRunEvent, ExplainRequest } from '@/entities/conversation';
import {
  applyOperation,
  cancelOperation,
  getConversationMessages,
  openConversation,
  requestExplanation,
  sendConversationMessage,
  stopRun,
  streamRunEvents,
} from '@/entities/conversation';
import { isApiError } from '@/shared/api';
import type { AssistantMessage, OperationCard, Rating } from './foldRunEvent';
import { blankAnswer, foldRunEvent } from './foldRunEvent';

export interface UserMessage {
  id: string;
  role: 'user';
  text: string;
}

export type { AssistantMessage, OperationCard, Rating };

export type Message = UserMessage | AssistantMessage;

interface ConversationState {
  conversationId: string | null;
  messages: Message[];
  /** The run currently open, so it can be stopped. */
  runId: string | null;
  /** `dispatcher` once a human took the dialogue over: the assistant stays silent. */
  mode: 'ai' | 'dispatcher';
  quota: { remainingMessages: number; resetAt: number } | null;
  ask: (text: string) => Promise<void>;
  /** «Разобрать» from another screen: one explanation about one named object. */
  explain: (request: ExplainRequest, label: string) => Promise<void>;
  retry: (assistantId: string) => Promise<void>;
  rate: (assistantId: string, rating: Rating) => void;
  stop: () => Promise<void>;
  act: (assistantId: string, button: AiActionButton) => Promise<void>;
}

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}`;
}

function failureText(error: unknown): string {
  if (isApiError(error)) return `${error.message} (${error.code})`;
  return error instanceof Error ? error.message : 'Не удалось получить ответ';
}

/**
 * The dispatcher's dialogue with the assistant.
 *
 * The conversation itself lives on the server (`POST /ai/conversations` returns
 * the open one), so this store holds only what the screen needs to draw and the
 * cursor-free view of a run in flight. Nothing here invents an answer: text
 * arrives as `message_delta`/`message`, buttons come attached to the reply, and a
 * failure is whatever the stream reported.
 */
export const useConversation = create<ConversationState>()((set, get) => {
  /**
   * Applies one run event: the answer's own change through the pure fold, and
   * the dialogue-wide fields — which run is open, which lane it is in, what
   * budget is left — here, where the store can see them.
   */
  const applyEvent = (assistantId: string, event: AiRunEvent, startedAt: number) => {
    set((state) => ({
      messages: state.messages.map((message) =>
        message.id === assistantId && message.role === 'assistant'
          ? foldRunEvent(message, event, startedAt)
          : message,
      ),
    }));

    if (event.type === 'run_started') set({ runId: event.runId });
    if (event.type === 'run_finished') set({ runId: null });
    if (event.type === 'help_requested') set({ mode: 'dispatcher' });
    if (event.type === 'mode_changed') set({ mode: event.mode });
    if (event.type === 'quota') {
      set({ quota: { remainingMessages: event.remainingMessages, resetAt: event.resetAt } });
    }
  };

  /**
   * Opens the dialogue if needed and posts one question.
   *
   * Returns the run to follow, or null when the dialogue is already with a human:
   * then no run starts and no quota is spent, which is not the assistant failing
   * to answer, and the screen says so instead.
   */
  const sendQuestion = async (assistantId: string, question: string): Promise<string | null> => {
    let conversationId = get().conversationId;
    if (!conversationId) {
      const opened = await openConversation();
      conversationId = opened.conversation.id;
      set({
        conversationId,
        mode: opened.conversation.mode === 'dispatcher' ? 'dispatcher' : 'ai',
      });
    }

    const sent = await sendConversationMessage(conversationId, question);
    if (sent.quota) {
      set({
        quota: { remainingMessages: sent.quota.remainingMessages, resetAt: sent.quota.resetAt },
      });
    }
    if (sent.handedOver || sent.runId === null) {
      set({ mode: 'dispatcher' });
      set((state) => ({
        messages: state.messages.map((message) =>
          message.id === assistantId && message.role === 'assistant'
            ? {
                ...message,
                streaming: false,
                failure:
                  'Диалог ведёт диспетчер — ассистент здесь не отвечает, пока передача не завершена.',
              }
            : message,
        ),
      }));
      return null;
    }
    return sent.runId;
  };

  /**
   * Drains a run into one answer.
   *
   * `start` returns the run to follow, or null when there is nothing to follow —
   * a dialogue already handed to a human. Both the typed question and the
   * explanation go through here so a reply is read one way, not two.
   */
  const drain = async (assistantId: string, start: () => Promise<string | null>) => {
    const patch = (change: (message: AssistantMessage) => AssistantMessage) =>
      set((state) => ({
        messages: state.messages.map((message) =>
          message.id === assistantId && message.role === 'assistant' ? change(message) : message,
        ),
      }));

    try {
      const runId = await start();
      if (runId === null) return;

      const startedAt = Math.floor(Date.now() / 1000);
      for await (const event of streamRunEvents(runId)) {
        applyEvent(assistantId, event, startedAt);
      }
      // A stream that ends without `run_finished` still has to release the pill.
      patch((message) => (message.streaming ? { ...message, streaming: false } : message));
      set({ runId: null });
    } catch (error) {
      patch((message) => ({ ...message, streaming: false, failure: failureText(error) }));
      set({ runId: null });
    }
  };

  return {
    conversationId: null,
    messages: [],
    runId: null,
    mode: 'ai',
    quota: null,

    ask: async (text) => {
      const question = text.trim();
      if (!question) return;
      const userId = nextId('u');
      const answer = blankAnswer(nextId('a'), userId);
      set((state) => ({
        messages: [...state.messages, { id: userId, role: 'user', text: question }, answer],
      }));
      await drain(answer.id, () => sendQuestion(answer.id, question));
    },

    explain: async (request, label) => {
      const userId = nextId('u');
      const answer = blankAnswer(nextId('a'), userId, request);
      set((state) => ({
        messages: [...state.messages, { id: userId, role: 'user', text: label }, answer],
      }));
      await drain(answer.id, async () => (await requestExplanation(request)).runId);
    },

    retry: async (assistantId) => {
      const target = get().messages.find(
        (message): message is AssistantMessage =>
          message.id === assistantId && message.role === 'assistant',
      );
      const question = get().messages.find((message) => message.id === target?.questionId);
      if (!target || !question || question.role !== 'user') return;
      set((state) => ({
        messages: state.messages.map((message) =>
          message.id === assistantId
            ? blankAnswer(assistantId, target.questionId, target.explain)
            : message,
        ),
      }));
      await drain(
        assistantId,
        target.explain
          ? async () => (await requestExplanation(target.explain as ExplainRequest)).runId
          : () => sendQuestion(assistantId, question.text),
      );
    },

    rate: (assistantId, rating) =>
      set((state) => ({
        messages: state.messages.map((message) =>
          message.id === assistantId && message.role === 'assistant'
            ? { ...message, rating }
            : message,
        ),
      })),

    stop: async () => {
      const runId = get().runId;
      if (!runId) return;
      // The run still ends through its own `stopped` event; this only asks.
      await stopRun(runId).catch(() => undefined);
    },

    act: async (assistantId, button) => {
      const operationId = button.operationId;
      if (!operationId) return;
      const outcome =
        button.kind === 'confirm_operation'
          ? await applyOperation(operationId).catch((error: unknown) => failureText(error))
          : await cancelOperation(operationId).catch((error: unknown) => failureText(error));
      set((state) => ({
        messages: state.messages.map((message) =>
          message.id === assistantId && message.role === 'assistant'
            ? {
                ...message,
                cards: message.cards.map((card) =>
                  card.operationId !== operationId
                    ? card
                    : typeof outcome === 'string'
                      ? { ...card, error: outcome }
                      : { ...card, state: outcome.state, error: outcome.error?.message ?? null },
                ),
              }
            : message,
        ),
      }));
    },
  };
});

/** Loads the dialogue the server already has, so a reload is a resume (§9.2). */
export async function resumeConversation(): Promise<void> {
  if (useConversation.getState().messages.length > 0) return;
  const opened = await openConversation();
  const { messages } = await getConversationMessages(opened.conversation.id);
  useConversation.setState({
    conversationId: opened.conversation.id,
    mode: opened.conversation.mode === 'dispatcher' ? 'dispatcher' : 'ai',
    messages: messages.map(
      (message): Message =>
        message.author === 'user'
          ? { id: message.id, role: 'user', text: message.text }
          : {
              id: message.id,
              role: 'assistant',
              questionId: '',
              text: message.text,
              actions: [...message.actions],
              cards: [],
              notes: [],
              streaming: false,
              thoughtSec: null,
              failure: null,
              rating: null,
              explain: null,
            },
    ),
  });
}
