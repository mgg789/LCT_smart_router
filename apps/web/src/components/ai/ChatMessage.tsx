import type { AiActionButton } from '../../api/ai';
import type { AiOperationView, AssistantChatMessage } from '../../hooks/useAssistantChat';
import { t } from '../../i18n';
import { AiOperationCard } from './AiOperationCard';

const AUTHOR_LABEL: Record<AssistantChatMessage['author'], string> = {
  user: t('components.ai.ChatMessage.041bfceecc'),
  assistant: t('components.ai.ChatMessage.e69724d99d'),
  dispatcher: t('components.ai.ChatMessage.d75c355491'),
  system: t('components.ai.ChatMessage.6da215b1bd'),
};

export interface ChatMessageProps {
  readonly message: AssistantChatMessage;
  readonly operations: ReadonlyMap<string, AiOperationView>;
  readonly disabled?: boolean;
  readonly onApplyOperation: (operationId: string) => void;
  readonly onCancelOperation: (operationId: string) => void;
  readonly onOpenObject?: (target: { type: 'request' | 'engineer' | 'alert'; id: string }) => void;
}

/**
 * Renders exactly the four message kinds the product accepts, and nothing else: `text`,
 * `text_action`, `text_action_cancel`, `text_confirmation`. Author is always shown
 * explicitly (Вы / Ассистент / Диспетчер / Система) so a reader never has to guess who is
 * speaking. A button click only ever forwards an `operationId` the server already
 * validated, or an `open_object` selector — never a URL or script chosen by the model.
 */
export function ChatMessage({
  message,
  operations,
  disabled,
  onApplyOperation,
  onCancelOperation,
  onOpenObject,
}: ChatMessageProps) {
  const mine = message.author === 'user';
  return (
    <div className={`flex flex-col gap-1 ${mine ? 'items-end' : 'items-start'}`}>
      <span className="px-1 text-xs text-muted">{AUTHOR_LABEL[message.author]}</span>
      <div
        className={`max-w-[38rem] rounded-2xl px-4 py-3 text-sm ${
          mine ? 'bg-ink text-white' : 'border border-line bg-white'
        } ${message.pending ? 'opacity-70' : ''}`}
      >
        <MessageBody
          message={message}
          operations={operations}
          disabled={disabled}
          onApplyOperation={onApplyOperation}
          onCancelOperation={onCancelOperation}
          onOpenObject={onOpenObject}
        />
      </div>
    </div>
  );
}

function MessageBody({
  message,
  operations,
  disabled,
  onApplyOperation,
  onCancelOperation,
  onOpenObject,
}: ChatMessageProps) {
  switch (message.kind) {
    case 'text':
      return <TextParagraphs text={message.text} />;
    case 'text_action': {
      const primary = message.actions[0];
      return (
        <>
          <TextParagraphs text={message.text} />
          {primary && (
            <div className="mt-3 flex flex-wrap gap-2">
              <ActionButton
                action={primary}
                variant="primary"
                disabled={disabled}
                onApplyOperation={onApplyOperation}
                onCancelOperation={onCancelOperation}
                onOpenObject={onOpenObject}
              />
            </div>
          )}
        </>
      );
    }
    case 'text_action_cancel': {
      const [primary, secondary] = message.actions;
      return (
        <>
          <TextParagraphs text={message.text} />
          {(primary || secondary) && (
            <div className="mt-3 flex flex-wrap gap-2">
              {primary && (
                <ActionButton
                  action={primary}
                  variant="primary"
                  disabled={disabled}
                  onApplyOperation={onApplyOperation}
                  onCancelOperation={onCancelOperation}
                  onOpenObject={onOpenObject}
                />
              )}
              {secondary && (
                <ActionButton
                  action={secondary}
                  variant="ghost"
                  disabled={disabled}
                  onApplyOperation={onApplyOperation}
                  onCancelOperation={onCancelOperation}
                  onOpenObject={onOpenObject}
                />
              )}
            </div>
          )}
        </>
      );
    }
    case 'text_confirmation': {
      const operationId = message.actions.find((action) => action.operationId)?.operationId;
      return (
        <>
          <TextParagraphs text={message.text} />
          {operationId ? (
            <AiOperationCard
              operationId={operationId}
              operation={operations.get(operationId)}
              disabled={disabled}
              onApply={() => onApplyOperation(operationId)}
              onCancel={() => onCancelOperation(operationId)}
            />
          ) : (
            <p className="mt-2 text-xs text-muted">{t('components.ai.ChatMessage.69b0f99567')}</p>
          )}
        </>
      );
    }
  }
}

function TextParagraphs({ text }: { text: string }) {
  return (
    <>
      {text.split('\n').map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static text, lines never reorder
        <p key={index} className={index === 0 ? '' : 'mt-2'}>
          {line.length === 0 ? ' ' : line}
        </p>
      ))}
    </>
  );
}

interface ActionButtonProps {
  readonly action: AiActionButton;
  readonly variant: 'primary' | 'ghost';
  readonly disabled?: boolean;
  readonly onApplyOperation: (operationId: string) => void;
  readonly onCancelOperation: (operationId: string) => void;
  readonly onOpenObject?: (target: { type: 'request' | 'engineer' | 'alert'; id: string }) => void;
}

function ActionButton({
  action,
  variant,
  disabled,
  onApplyOperation,
  onCancelOperation,
  onOpenObject,
}: ActionButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        if (action.kind === 'confirm_operation' && action.operationId) {
          onApplyOperation(action.operationId);
        } else if (action.kind === 'cancel_operation' && action.operationId) {
          onCancelOperation(action.operationId);
        } else if (action.kind === 'open_object' && action.target) {
          onOpenObject?.(action.target);
        }
      }}
      className={
        variant === 'primary'
          ? 'rounded-full bg-bee px-4 py-2 text-sm font-semibold text-ink disabled:opacity-50'
          : 'rounded-full border border-line bg-white px-4 py-2 text-sm disabled:opacity-50'
      }
    >
      {action.label}
    </button>
  );
}
