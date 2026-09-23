/**
 * What the assistant said back, or — today — why it could not.
 *
 * `connected: false` is the honest answer while the System Layer has no AI
 * contract (docs/frontend-api.md: «Чат/поддержка и AI не подключены; кнопки не
 * имитируют отправку»). The UI shows it as such and never passes it off as a
 * model's reply.
 */
export interface AssistantReply {
  connected: boolean;
  text: string;
  /** Seconds the model spent, when there is a model to measure. */
  thoughtSec: number | null;
}

/**
 * The one door to the assistant. There is no endpoint behind it yet, so it
 * answers at once and says so; nothing leaves the browser. When the System
 * Layer gains an AI contract, this is the only function to change.
 */
export async function askAssistant(_question: string): Promise<AssistantReply> {
  return {
    connected: false,
    text:
      'Ответить не могу: AI-ассистента в System Layer пока нет — ни модели, ни контракта на ответы. ' +
      'Вопрос никуда не отправлен и хранится только в этой вкладке. ' +
      'Почему заявка без назначения, видно в «Плане дня» и в «Алертах»; план против FIFO — в «Политике».',
    thoughtSec: null,
  };
}
