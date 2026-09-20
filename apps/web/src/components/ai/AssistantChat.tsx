import { Send, Square } from 'lucide-react';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import type { AiAssistMode } from '../../api/ai';
import { type AssistantSurface, useAssistantChat } from '../../hooks/useAssistantChat';
import { AiUnavailablePanel } from './AiUnavailablePanel';
import { ChatMessage } from './ChatMessage';
import { HandoffBanner } from './HandoffBanner';

export type AssistantChatVariant = 'panel' | 'sheet' | 'page';

export interface AssistantChatProps {
  readonly token: string | null;
  readonly surface: AssistantSurface;
  readonly variant: AssistantChatVariant;
  /** Which request/engineer/alert this dialogue was opened about, if any. */
  readonly contextRef?: unknown;
  readonly assistMode?: AiAssistMode;
  /** Fires once, the moment a prepared operation first reaches `applied`, from any source
   * (a direct apply here, or a later `operation_state` event from elsewhere). Lets the host
   * page refresh whatever the operation just changed. */
  readonly onOperationApplied?: (operationId: string) => void;
  /** Forwarded from a `text_action`/`text_action_cancel` button of kind `open_object`. */
  readonly onOpenObject?: (target: { type: 'request' | 'engineer' | 'alert'; id: string }) => void;
}

const VARIANT_CLASS: Record<AssistantChatVariant, string> = {
  panel:
    'flex h-full max-h-[36rem] flex-col overflow-hidden rounded-2xl border border-line bg-white',
  sheet: 'flex h-full flex-col overflow-hidden bg-white',
  page: 'flex h-full flex-col overflow-hidden',
};

/** The reusable assistant chat panel: history, composer, stop control, system states. */
export function AssistantChat({
  token,
  surface,
  variant,
  contextRef,
  assistMode,
  onOperationApplied,
  onOpenObject,
}: AssistantChatProps) {
  const chat = useAssistantChat({ token, surface, contextRef, assistMode });
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const appliedSeen = useRef(new Set<string>());

  // biome-ignore lint/correctness/useExhaustiveDependencies: scrolls down on new messages
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [chat.messages.length]);

  useEffect(() => {
    if (!onOperationApplied) return;
    for (const operation of chat.operations.values()) {
      if (operation.state === 'applied' && !appliedSeen.current.has(operation.operationId)) {
        appliedSeen.current.add(operation.operationId);
        onOperationApplied(operation.operationId);
      }
    }
  }, [chat.operations, onOperationApplied]);

  const canSend = token !== null && !chat.sending && chat.unavailable !== 'auth';

  function submit() {
    const text = draft;
    if (text.trim().length === 0) return;
    setDraft('');
    void chat.sendMessage(text);
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <section className={VARIANT_CLASS[variant]}>
      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto p-4">
        {chat.loading && <p className="text-sm text-muted">Загружаем диалог…</p>}
        {!chat.loading && chat.messages.length === 0 && (
          <p className="rounded-2xl border border-dashed border-line p-6 text-center text-sm text-muted">
            Задайте вопрос ассистенту.
          </p>
        )}
        {chat.messages.map((message) => (
          <ChatMessage
            key={message.id}
            message={message}
            operations={chat.operations}
            disabled={chat.sending}
            onApplyOperation={(operationId) => void chat.applyOperation(operationId)}
            onCancelOperation={(operationId) => void chat.cancelOperation(operationId)}
            onOpenObject={onOpenObject}
          />
        ))}
        {chat.activity && (
          <p className="px-1 text-xs text-muted" aria-live="polite">
            {chat.activity}
          </p>
        )}
      </div>

      <div className="shrink-0 space-y-2 border-t border-line p-3">
        <HandoffBanner status={chat.handoffStatus} />
        {chat.error && (
          <p role="alert" className="text-xs text-muted">
            {chat.error}
          </p>
        )}
        {chat.unavailable && (
          <AiUnavailablePanel reason={chat.unavailable} quotaResetAt={chat.quota?.resetAt} />
        )}
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onComposerKeyDown}
            disabled={!canSend}
            rows={1}
            placeholder="Напишите сообщение…"
            className="max-h-32 min-h-[2.5rem] flex-1 resize-none rounded-xl border border-line bg-canvas px-3 py-2 text-sm disabled:opacity-50"
          />
          {chat.runState === 'running' ? (
            <button
              type="button"
              onClick={() => void chat.stop()}
              className="flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-white px-4 py-2 text-sm"
            >
              <Square className="h-4 w-4" />
              Остановить
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!canSend || draft.trim().length === 0}
              className="flex shrink-0 items-center gap-1.5 rounded-full bg-bee px-4 py-2 text-sm font-semibold text-ink disabled:opacity-50"
            >
              <Send className="h-4 w-4" />
              Отправить
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
