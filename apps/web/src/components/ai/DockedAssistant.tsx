import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import type { AiAssistMode } from '../../api/ai';
import type { AssistantSurface } from '../../hooks/useAssistantChat';
import { AssistantChat } from './AssistantChat';

export interface DockedAssistantProps {
  readonly open: boolean;
  /** `side`: a drawer over the right edge (dispatcher, keeps the map/plan visible).
   * `bottom`: a sheet from the bottom (engineer, small screens). */
  readonly dock: 'side' | 'bottom';
  readonly token: string | null;
  readonly surface: AssistantSurface;
  readonly title: string;
  readonly contextRef?: unknown;
  readonly assistMode?: AiAssistMode;
  /** Header pill for the dispatcher's help/fix switch. Omitted elsewhere. */
  readonly headerExtra?: ReactNode;
  /** One-line notice of what the current mode changes. Omitted elsewhere. */
  readonly notice?: ReactNode;
  readonly onClose: () => void;
  readonly onOperationApplied?: (operationId: string) => void;
  readonly onOpenObject?: (target: { type: 'request' | 'engineer' | 'alert'; id: string }) => void;
}

const DOCK_CLASS: Record<'side' | 'bottom', string> = {
  side: 'fixed inset-y-0 right-0 z-30 flex w-full max-w-md flex-col border-l border-line bg-white shadow-xl',
  bottom: 'fixed inset-x-0 bottom-0 z-30 flex h-[80vh] flex-col rounded-t-3xl bg-white shadow-xl',
};

/** The one docked assistant surface, shared by the dispatcher drawer and the engineer
 * bottom sheet so both stay a thin shell around the same `AssistantChat`. */
export function DockedAssistant({
  open,
  dock,
  token,
  surface,
  title,
  contextRef,
  assistMode,
  headerExtra,
  notice,
  onClose,
  onOperationApplied,
  onOpenObject,
}: DockedAssistantProps) {
  if (!open) return null;
  return (
    <div className={DOCK_CLASS[dock]}>
      <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">{title}</span>
          {headerExtra}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Закрыть ассистента"
          className="flex h-8 w-8 items-center justify-center rounded-full text-muted hover:bg-canvas"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      {notice ? (
        <p className="border-b border-line bg-canvas px-4 py-2 text-xs text-muted">{notice}</p>
      ) : null}
      <div className="min-h-0 flex-1">
        <AssistantChat
          token={token}
          surface={surface}
          variant="sheet"
          contextRef={contextRef}
          assistMode={assistMode}
          onOperationApplied={onOperationApplied}
          onOpenObject={onOpenObject}
        />
      </div>
    </div>
  );
}
