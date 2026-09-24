/**
 * The wire contract of one assistant run.
 *
 * Both halves of the product depend on this file: the System Layer emits these objects as
 * Server-Sent Events, and the web client mirrors them with its own schema because this
 * workspace has no shared contract package yet (`packages/` is declared in
 * `pnpm-workspace.yaml` but does not exist). Changing a member here is a contract change
 * and belongs in `docs/frontend-api.md` in the same commit.
 *
 * Three rules hold for every member and are the reason the union looks the way it does:
 *
 *   * `seq` is assigned by the server, is strictly increasing within a run, and is the only
 *     state a client keeps. A reconnect asks for `?afterSeq=<last rendered>` and receives
 *     exactly the tail it missed, so a page reload mid-run is an ordinary resume rather
 *     than a lost answer;
 *   * every member except `message_delta` is persisted before it is multicast. Deltas are
 *     deliberately ephemeral: after a gap the client receives the finished `message` and
 *     live deltas from the current point, and never redraws partial text it cannot prove;
 *   * only `message` carries one of the four agreed visual forms. The rest are system
 *     events and must not grow the vocabulary the model can render (context/35 section 15.2).
 */

/**
 * The four message forms the product accepts. Nothing else is ever generated, and a button
 * always references an allowed system action rather than a URL or a script chosen by the
 * model (context/35 section 8).
 *
 * Declared as a literal union rather than imported from the Prisma enum so that the web
 * client can mirror this file without a database client. The server pins the two together
 * with a compile-time assertion where the enum is available.
 */
export type AiMessageKind = 'text' | 'text_action' | 'text_action_cancel' | 'text_confirmation';

/**
 * Lifecycle of an operation the assistant prepared for a human to confirm.
 *
 * `cancelled_before_apply` and `outcome_unknown` are states rather than the absence of a
 * row on purpose: stopping a run must never be presented as a rollback, and a write whose
 * result was lost must be shown as uncertain rather than as undone (context/35 section 5).
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

/**
 * A button under an assistant message. `operationId` addresses a prepared operation the
 * server already validated; the client sends it back to confirm or cancel and never
 * assembles a business payload of its own.
 */
export interface AiActionButton {
  readonly kind: 'confirm_operation' | 'cancel_operation' | 'open_object';
  readonly label: string;
  readonly operationId?: string;
  /** For `open_object`: what the dashboard should select. Never a URL from the model. */
  readonly target?: { readonly type: 'request' | 'engineer' | 'alert'; readonly id: string };
}

/** One row of a confirmation card, rendered by the server from validated arguments. */
export interface AiPreviewRow {
  readonly label: string;
  readonly value: string;
}

interface AiRunEventBase {
  /** Server-assigned, strictly increasing within the run. The client's resume cursor. */
  readonly seq: number;
  /** Unix seconds, whole, as everywhere else in this contract (context/33 section 4). */
  readonly at: number;
}

export type AiRunEvent =
  | (AiRunEventBase & {
      readonly type: 'run_started';
      readonly runId: string;
      readonly conversationId: string;
    })
  /** Ephemeral: never persisted, never replayed. See the note at the top of this file. */
  | (AiRunEventBase & {
      readonly type: 'message_delta';
      readonly messageId: string;
      readonly text: string;
    })
  | (AiRunEventBase & {
      readonly type: 'message';
      readonly messageId: string;
      /** Position in the conversation, distinct from this run's event `seq`. */
      readonly messageSeq: number;
      readonly kind: AiMessageKind;
      readonly text: string;
      readonly actions: readonly AiActionButton[];
    })
  /**
   * A tool the runtime is about to run, described before it runs so the journal reflects
   * intent as well as outcome. `intent` is rendered by the server from validated
   * arguments, not taken from the model's prose.
   */
  | (AiRunEventBase & {
      readonly type: 'tool_started';
      readonly toolName: string;
      readonly intent: string;
    })
  | (AiRunEventBase & {
      readonly type: 'tool_result';
      readonly toolName: string;
      readonly ok: boolean;
      /** A safe public summary. Raw rows and provider payloads never travel here. */
      readonly summary: string;
    })
  | (AiRunEventBase & {
      readonly type: 'operation_prepared';
      readonly operationId: string;
      /** Catalogue action, e.g. `request.submit` -- the same string the controller uses. */
      readonly action: string;
      readonly targetRef: string | null;
      readonly state: AiOperationState;
      readonly preview: readonly AiPreviewRow[];
      readonly expiresAt: number;
    })
  | (AiRunEventBase & {
      readonly type: 'operation_state';
      readonly operationId: string;
      readonly state: AiOperationState;
      readonly error?: { readonly code: string; readonly message: string };
    })
  /** A human dispatcher was asked to take this dialogue over; the AI goes silent in it. */
  | (AiRunEventBase & {
      readonly type: 'help_requested';
      readonly handoffId: string;
    })
  | (AiRunEventBase & {
      readonly type: 'mode_changed';
      readonly mode: 'ai' | 'dispatcher';
    })
  /**
   * Remaining daily budget. Quota is a distinct condition from a provider failure and is
   * never reported as one (context/35 section 8).
   */
  | (AiRunEventBase & {
      readonly type: 'quota';
      readonly remainingMicros: number;
      readonly remainingMessages: number;
      readonly resetAt: number;
    })
  | (AiRunEventBase & {
      readonly type: 'stopped';
      readonly reason: AiStopReason;
    })
  /**
   * A terminal failure rendered as an event rather than thrown.
   *
   * The global exception filter answers with `response.json()`, which after the SSE headers
   * have been sent is `ERR_HTTP_HEADERS_SENT` and a dead socket with no usable body. The
   * stream observable must therefore never error.
   */
  | (AiRunEventBase & {
      readonly type: 'error';
      readonly code: string;
      readonly message: string;
    })
  | (AiRunEventBase & {
      readonly type: 'run_finished';
      readonly state: AiRunState;
      readonly usage: {
        readonly promptTokens: number;
        readonly completionTokens: number;
        readonly costMicros: number;
      };
    });

export type AiRunEventType = AiRunEvent['type'];

/**
 * Events written to `ai_run_events` before they are multicast, and therefore the ones a
 * reconnecting client can be given again. `message_delta` is absent by design.
 */
export const PERSISTED_AI_EVENT_TYPES: ReadonlySet<AiRunEventType> = new Set<AiRunEventType>([
  'run_started',
  'message',
  'tool_started',
  'tool_result',
  'operation_prepared',
  'operation_state',
  'help_requested',
  'mode_changed',
  'quota',
  'stopped',
  'error',
  'run_finished',
]);

/** True when the event ends the run and the client may close the stream. */
export function isTerminalAiEvent(event: AiRunEvent): boolean {
  return event.type === 'run_finished';
}
