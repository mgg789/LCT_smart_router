import { create } from 'zustand';
import type { AssistantReply } from '../api/askAssistant';
import { askAssistant } from '../api/askAssistant';

export type Rating = 'up' | 'down' | null;

export interface UserMessage {
  id: string;
  role: 'user';
  text: string;
}

export interface AssistantMessage {
  id: string;
  role: 'assistant';
  /** The question it answers, so «повторить» can ask it again. */
  questionId: string;
  reply: AssistantReply | null;
  /** The dispatcher's thumbs; kept in the tab, not sent anywhere — there is nowhere to send it. */
  rating: Rating;
}

export type Message = UserMessage | AssistantMessage;

interface ConversationState {
  messages: Message[];
  ask: (text: string) => Promise<void>;
  retry: (assistantId: string) => Promise<void>;
  rate: (assistantId: string, rating: Rating) => void;
}

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}`;
}

/**
 * The conversation on the AI screen. It lives for the tab: moving to another
 * section and back keeps it, a new tab starts clean — the same lifetime as the
 * dispatcher's session.
 */
export const useConversation = create<ConversationState>()((set, get) => {
  const answer = async (assistantId: string, question: string) => {
    const reply = await askAssistant(question);
    set((state) => ({
      messages: state.messages.map((message) =>
        message.id === assistantId && message.role === 'assistant'
          ? { ...message, reply }
          : message,
      ),
    }));
  };

  return {
    messages: [],
    ask: async (text) => {
      const question = text.trim();
      if (!question) return;
      const userId = nextId('u');
      const assistantId = nextId('a');
      set((state) => ({
        messages: [
          ...state.messages,
          { id: userId, role: 'user', text: question },
          { id: assistantId, role: 'assistant', questionId: userId, reply: null, rating: null },
        ],
      }));
      await answer(assistantId, question);
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
          message.id === assistantId ? { ...target, reply: null, rating: null } : message,
        ),
      }));
      await answer(assistantId, question.text);
    },
    rate: (assistantId, rating) =>
      set((state) => ({
        messages: state.messages.map((message) =>
          message.id === assistantId && message.role === 'assistant'
            ? { ...message, rating }
            : message,
        ),
      })),
  };
});
