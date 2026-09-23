/**
 * The AI contour's wire contract, mirrored from the System Layer.
 *
 * This workspace has no shared contract package (`packages/` is declared in
 * `pnpm-workspace.yaml` but does not exist), so the server's
 * `ai/runtime/ai-event.types.ts` and `api/ai-view.ts` are mirrored here by hand.
 * Changing a member is a contract change on both sides and in
 * `docs/frontend-api.md` — never a local edit.
 */

/** The four message forms the product accepts; the model can render nothing else. */
export type AiMessageKind = 'text' | 'text_action' | 'text_action_cancel' | 'text_confirmation';

/**
 * Lifecycle of an operation the assistant prepared for a human to confirm.
 *
 * `cancelled_before_apply` and `outcome_unknown` are different answers, not two
 * words for "nothing happened": the first says the write never ran, the second
 * that it may or may not have (docs/frontend-api.md §9.6). Rendering the second
 * as either "отменено" or "выполнено" would be a guess stated as a fact.
 */
export type AiOperationState =
  | 'prepared'
  | 'awaiting_confirmation'
  | 'running'
  | 'applied'
  | 'rejected'
  | 'cancelled_before_apply'
  | 'outcome_unknown';

export type AiRunState = 'running' | 'stopping' | 'stopped' | 'completed' | 'failed';

/** Why a run ended early. `handover` means a human took the dialogue over mid-generation. */
export type AiStopReason = 'user' | 'handover' | 'budget' | 'shutdown';

export interface AiActionTarget {
  type: 'request' | 'engineer' | 'alert';
  id: string;
}

/**
 * A button under an assistant message.
 *
 * `operationId` addresses an operation the server already prepared and validated;
 * the client sends it back to confirm or cancel and never assembles a business
 * payload of its own (§9.5). `target` says what the dashboard should select —
 * never a URL chosen by the model.
 */
export interface AiActionButton {
  kind: 'confirm_operation' | 'cancel_operation' | 'open_object';
  label: string;
  operationId?: string;
  target?: AiActionTarget;
}

/** One row of a confirmation card, rendered by the server from validated arguments. */
export interface AiPreviewRow {
  label: string;
  value: string;
}

interface AiRunEventBase {
  /** Server-assigned, strictly increasing within the run: the only resume cursor. */
  seq: number;
  /** Whole Unix seconds, as everywhere in this contract. */
  at: number;
}

export type AiRunEvent =
  | (AiRunEventBase & { type: 'run_started'; runId: string; conversationId: string })
  /** Ephemeral: never persisted, never replayed after a reconnect (§9.2). */
  | (AiRunEventBase & { type: 'message_delta'; messageId: string; text: string })
  | (AiRunEventBase & {
      type: 'message';
      messageId: string;
      /** Position in the conversation, distinct from this run's event `seq`. */
      messageSeq: number;
      kind: AiMessageKind;
      text: string;
      actions: AiActionButton[];
    })
  | (AiRunEventBase & { type: 'tool_started'; toolName: string; intent: string })
  | (AiRunEventBase & { type: 'tool_result'; toolName: string; ok: boolean; summary: string })
  | (AiRunEventBase & {
      type: 'operation_prepared';
      operationId: string;
      action: string;
      targetRef: string | null;
      state: AiOperationState;
      preview: AiPreviewRow[];
      expiresAt: number;
    })
  | (AiRunEventBase & {
      type: 'operation_state';
      operationId: string;
      state: AiOperationState;
      error?: { code: string; message: string };
    })
  | (AiRunEventBase & { type: 'help_requested'; handoffId: string })
  | (AiRunEventBase & { type: 'mode_changed'; mode: 'ai' | 'dispatcher' })
  | (AiRunEventBase & {
      type: 'quota';
      remainingMicros: number;
      remainingMessages: number;
      resetAt: number;
    })
  | (AiRunEventBase & { type: 'stopped'; reason: AiStopReason })
  /** A terminal failure rendered as an event: after SSE headers there is no other way. */
  | (AiRunEventBase & { type: 'error'; code: string; message: string })
  | (AiRunEventBase & {
      type: 'run_finished';
      state: AiRunState;
      usage: { promptTokens: number; completionTokens: number; costMicros: number };
    });

export type AiRunEventType = AiRunEvent['type'];

/** Ends the run: the consumer may close the connection (§9.3). */
export function isTerminalRunEvent(event: AiRunEvent): boolean {
  return event.type === 'run_finished';
}

export interface AiConversation {
  id: string;
  role: string;
  /** `ai` while the assistant answers, `dispatcher` once a human took over. */
  mode: string;
  assistMode: string;
  roleProfile: string;
  contextRef: unknown;
  title: string | null;
  createdAt: number;
  updatedAt: number;
  lastMessageAt: number;
  closedAt: number | null;
  version: number;
}

export interface AiMessage {
  id: string;
  /** Position in the conversation; the cursor for `?afterSeq=`. */
  seq: number;
  author: string;
  kind: string;
  text: string;
  actions: AiActionButton[];
  runId: string | null;
  operationId: string | null;
  /** Set only for `dispatcher` authorship, so a reply names the human who sent it. */
  authorAccountId: string | null;
  createdAt: number;
}

/** What `POST /ai/operations/:id/apply` and `.../cancel` answer (§9.6). */
export interface OperationOutcome {
  aiOperationId: string;
  state: AiOperationState;
  result?: unknown;
  error?: { code: string; message: string };
}

/** Which assistant lane the dispatcher is in: read-only help, or prepared writes. */
export type AiAssistMode = 'help' | 'fix';
