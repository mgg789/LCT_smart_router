import { z } from 'zod';
import { t } from '../i18n';
import { DashboardApiError, requestJson } from './client';

/**
 * Assistant chat client: conversation/message CRUD plus the SSE run stream.
 *
 * The wire shape mirrors `apps/api/src/ai/runtime/ai-event.types.ts` field-for-field.
 * This workspace has no shared contract package (`packages/` is declared in
 * `pnpm-workspace.yaml` but does not exist), so mirroring here — the same practice
 * `apps/web/src/api/types.ts` already follows for the dispatcher views — is how the two
 * halves of the product stay in sync. Changing a member here without a matching change on
 * the server (and vice versa) is a contract break.
 */

const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '');

// ---------------------------------------------------------------------------------------
// Enums and small shared shapes (mirrors the enums in ai-event.types.ts / schema.prisma)
// ---------------------------------------------------------------------------------------

export const aiMessageKindSchema = z.enum([
  'text',
  'text_action',
  'text_action_cancel',
  'text_confirmation',
]);
export type AiMessageKind = z.infer<typeof aiMessageKindSchema>;

export const aiOperationStateSchema = z.enum([
  'prepared',
  'awaiting_confirmation',
  'running',
  'applied',
  'rejected',
  'cancelled_before_apply',
  'outcome_unknown',
]);
export type AiOperationState = z.infer<typeof aiOperationStateSchema>;

export const aiRunStateSchema = z.enum(['running', 'stopping', 'stopped', 'completed', 'failed']);
export type AiRunState = z.infer<typeof aiRunStateSchema>;

export const aiStopReasonSchema = z.enum(['user', 'handover', 'budget', 'shutdown']);
export type AiStopReason = z.infer<typeof aiStopReasonSchema>;

export const aiConversationModeSchema = z.enum(['ai', 'dispatcher']);
export type AiConversationMode = z.infer<typeof aiConversationModeSchema>;

export const aiAssistModeSchema = z.enum(['help', 'fix']);
export type AiAssistMode = z.infer<typeof aiAssistModeSchema>;

/** `dispatcher_readonly` / `dispatcher_fix` mirror the `assistMode` a dispatcher chose. */
export const aiRoleProfileSchema = z.enum([
  'client',
  'engineer',
  'dispatcher_readonly',
  'dispatcher_fix',
]);
export type AiRoleProfile = z.infer<typeof aiRoleProfileSchema>;

export const aiMessageAuthorSchema = z.enum(['user', 'assistant', 'dispatcher', 'system']);
export type AiMessageAuthor = z.infer<typeof aiMessageAuthorSchema>;

/**
 * A button under an assistant message. `operationId` addresses a prepared operation the
 * server already validated; the client sends it back to confirm or cancel and never
 * assembles a business payload of its own, and `target` is never a URL from the model.
 */
export const aiActionButtonSchema = z.object({
  kind: z.enum(['confirm_operation', 'cancel_operation', 'open_object']),
  label: z.string(),
  operationId: z.string().optional(),
  target: z
    .object({
      type: z.enum(['request', 'engineer', 'alert']),
      id: z.string(),
    })
    .optional(),
});
export type AiActionButton = z.infer<typeof aiActionButtonSchema>;

/** One row of a confirmation card, rendered by the server from validated arguments. */
export const aiPreviewRowSchema = z.object({ label: z.string(), value: z.string() });
export type AiPreviewRow = z.infer<typeof aiPreviewRowSchema>;

// ---------------------------------------------------------------------------------------
// The SSE run event union
// ---------------------------------------------------------------------------------------

const eventBase = { seq: z.number().int(), at: z.number().int() };

const runStartedEventSchema = z.object({
  ...eventBase,
  type: z.literal('run_started'),
  runId: z.string(),
  conversationId: z.string(),
});

/** Ephemeral: never persisted, never replayed after a reconnect. See the hook's resume. */
const messageDeltaEventSchema = z.object({
  ...eventBase,
  type: z.literal('message_delta'),
  messageId: z.string(),
  text: z.string(),
});

const messageEventSchema = z.object({
  ...eventBase,
  type: z.literal('message'),
  messageId: z.string(),
  messageSeq: z.number().int(),
  kind: aiMessageKindSchema,
  text: z.string(),
  actions: z.array(aiActionButtonSchema),
});

const toolStartedEventSchema = z.object({
  ...eventBase,
  type: z.literal('tool_started'),
  toolName: z.string(),
  intent: z.string(),
});

const toolResultEventSchema = z.object({
  ...eventBase,
  type: z.literal('tool_result'),
  toolName: z.string(),
  ok: z.boolean(),
  summary: z.string(),
});

const operationPreparedEventSchema = z.object({
  ...eventBase,
  type: z.literal('operation_prepared'),
  operationId: z.string(),
  action: z.string(),
  targetRef: z.string().nullable(),
  state: aiOperationStateSchema,
  preview: z.array(aiPreviewRowSchema),
  expiresAt: z.number().int(),
  guard: z.enum(['clear', 'risky']).optional(),
});

const operationStateEventSchema = z.object({
  ...eventBase,
  type: z.literal('operation_state'),
  operationId: z.string(),
  state: aiOperationStateSchema,
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});

const helpRequestedEventSchema = z.object({
  ...eventBase,
  type: z.literal('help_requested'),
  handoffId: z.string(),
});

const modeChangedEventSchema = z.object({
  ...eventBase,
  type: z.literal('mode_changed'),
  mode: aiConversationModeSchema,
});

const quotaEventSchema = z.object({
  ...eventBase,
  type: z.literal('quota'),
  remainingMicros: z.number().int(),
  remainingMessages: z.number().int(),
  resetAt: z.number().int(),
});

const stoppedEventSchema = z.object({
  ...eventBase,
  type: z.literal('stopped'),
  reason: aiStopReasonSchema,
});

const errorEventSchema = z.object({
  ...eventBase,
  type: z.literal('error'),
  code: z.string(),
  message: z.string(),
});

const runFinishedEventSchema = z.object({
  ...eventBase,
  type: z.literal('run_finished'),
  state: aiRunStateSchema,
  usage: z.object({
    promptTokens: z.number().int(),
    completionTokens: z.number().int(),
    costMicros: z.number().int(),
  }),
});

export const aiRunEventSchema = z.discriminatedUnion('type', [
  runStartedEventSchema,
  messageDeltaEventSchema,
  messageEventSchema,
  toolStartedEventSchema,
  toolResultEventSchema,
  operationPreparedEventSchema,
  operationStateEventSchema,
  helpRequestedEventSchema,
  modeChangedEventSchema,
  quotaEventSchema,
  stoppedEventSchema,
  errorEventSchema,
  runFinishedEventSchema,
]);
export type AiRunEvent = z.infer<typeof aiRunEventSchema>;
export type AiRunEventType = AiRunEvent['type'];

/** True when the event ends the run and the client may close the stream. */
export function isTerminalAiEvent(event: AiRunEvent): boolean {
  return event.type === 'run_finished';
}

// ---------------------------------------------------------------------------------------
// Conversation and message resources
// ---------------------------------------------------------------------------------------

export const aiConversationSchema = z.object({
  id: z.string(),
  role: z.enum(['client', 'engineer', 'dispatcher']),
  roleProfile: aiRoleProfileSchema,
  mode: aiConversationModeSchema,
  assistMode: aiAssistModeSchema,
  contextRef: z.unknown().nullable(),
  title: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  lastMessageAt: z.number().int(),
  closedAt: z.number().int().nullable(),
  version: z.number().int(),
});
export type AiConversation = z.infer<typeof aiConversationSchema>;

export const aiMessageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  seq: z.number().int(),
  author: aiMessageAuthorSchema,
  kind: aiMessageKindSchema,
  text: z.string(),
  actions: z.array(aiActionButtonSchema),
  runId: z.string().nullable(),
  operationId: z.string().nullable(),
  authorAccountId: z.string().nullable(),
  createdAt: z.number().int(),
});
export type AiMessage = z.infer<typeof aiMessageSchema>;

export const aiQuotaSchema = z.object({
  remainingMicros: z.number().int(),
  remainingMessages: z.number().int(),
  resetAt: z.number().int(),
});
export type AiQuota = z.infer<typeof aiQuotaSchema>;

export interface CreateAiConversationInput {
  readonly roleProfile: AiRoleProfile;
  readonly assistMode?: AiAssistMode;
  /** Which request/engineer/alert the dialogue was opened about, if any. */
  readonly contextRef?: unknown;
}

/** Opens a new assistant conversation. */
export async function createAiConversation(
  token: string,
  input: CreateAiConversationInput,
): Promise<AiConversation> {
  const created = await requestJson(
    '/api/v1/ai/conversations',
    z.object({ conversation: aiConversationSchema }),
    token,
    { method: 'POST', body: JSON.stringify(input) },
  );
  return created.conversation;
}

/** Moves the open dispatcher dialogue between consultant (`help`) and agent (`fix`). */
export async function setAiAssistMode(
  token: string,
  conversationId: string,
  assistMode: AiAssistMode,
): Promise<AiConversation> {
  const updated = await requestJson(
    `/api/v1/ai/conversations/${encodeURIComponent(conversationId)}/assist-mode`,
    z.object({ conversation: aiConversationSchema }),
    token,
    { method: 'POST', body: JSON.stringify({ assistMode }) },
  );
  return updated.conversation;
}

/** Closes the dialogue. The caller opens a fresh one afterwards. */
export async function clearAiConversation(token: string, conversationId: string): Promise<void> {
  await requestJson(
    `/api/v1/ai/conversations/${encodeURIComponent(conversationId)}/clear`,
    z.object({ closed: z.literal(true) }),
    token,
    { method: 'POST', body: JSON.stringify({}) },
  );
}

export interface LoadAiMessagesResult {
  readonly messages: readonly AiMessage[];
  readonly conversation: AiConversation;
}

/** Reads the messages after a resume cursor, and the conversation's current mode. */
export function loadAiMessages(
  token: string,
  conversationId: string,
  afterSeq = 0,
): Promise<LoadAiMessagesResult> {
  return requestJson(
    `/api/v1/ai/conversations/${encodeURIComponent(conversationId)}/messages?afterSeq=${afterSeq}`,
    z.object({ messages: z.array(aiMessageSchema), conversation: aiConversationSchema }),
    token,
  );
}

export type SendAiMessageResult =
  | { readonly runId: string; readonly messageSeq: number; readonly quota: AiQuota }
  | { readonly runId: null; readonly handedOver: true };

const sendAiMessageResultSchema = z.union([
  z.object({ runId: z.string(), messageSeq: z.number().int(), quota: aiQuotaSchema }),
  z.object({ runId: z.null(), handedOver: z.literal(true) }),
]);

/**
 * Sends one user message. `operationId` makes the send idempotent across retries, the same
 * convention `resolveDispatchAlert` uses in `client.ts`. A `handedOver` reply means a human
 * dispatcher already owns this conversation, so there is no run to stream.
 */
export function sendAiMessage(
  token: string,
  conversationId: string,
  operationId: string,
  text: string,
): Promise<SendAiMessageResult> {
  return requestJson(
    `/api/v1/ai/conversations/${encodeURIComponent(conversationId)}/messages`,
    sendAiMessageResultSchema,
    token,
    { method: 'POST', body: JSON.stringify({ operationId, text }) },
  );
}

/** Requests that a live run stop. The run still finishes with a `stopped` event. */
export async function stopAiRun(token: string, runId: string, operationId: string): Promise<void> {
  await requestJson(`/api/v1/ai/runs/${encodeURIComponent(runId)}/stop`, z.unknown(), token, {
    method: 'POST',
    body: JSON.stringify({ operationId }),
  });
}

const aiOperationResultSchema = z.object({
  operationId: z.string(),
  state: aiOperationStateSchema,
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
export type AiOperationResult = z.infer<typeof aiOperationResultSchema>;

/** Confirms a prepared operation. The definitive state still arrives as `operation_state`. */
export function applyAiOperation(token: string, operationId: string): Promise<AiOperationResult> {
  return requestJson(
    `/api/v1/ai/operations/${encodeURIComponent(operationId)}/apply`,
    aiOperationResultSchema,
    token,
    { method: 'POST', body: JSON.stringify({ operationId }) },
  );
}

/** Cancels a prepared operation before it runs. */
export function cancelAiOperation(token: string, operationId: string): Promise<AiOperationResult> {
  return requestJson(
    `/api/v1/ai/operations/${encodeURIComponent(operationId)}/cancel`,
    aiOperationResultSchema,
    token,
    { method: 'POST', body: JSON.stringify({ operationId }) },
  );
}

// ---------------------------------------------------------------------------------------
// One-shot explain: POST /ai/explain returns a runId, streamed with the same run-events
// endpoint as a conversation run. Unlike a conversation, this never persists and never
// hands off to a dispatcher -- it is a quick "why" against one object on screen.
// ---------------------------------------------------------------------------------------

export const explainScopeSchema = z.enum([
  'request',
  'engineer',
  'route',
  'alert',
  'policy',
  'degraded',
]);
export type ExplainScope = z.infer<typeof explainScopeSchema>;

/** The exact `/ai/explain` request body -- also reused as a conversation `contextRef` when
 * an explain affordance escalates into the full assistant drawer/sheet, since `contextRef`
 * is defined as "a small server-defined selector object" and this already is one. */
export interface ExplainTarget {
  readonly scope: ExplainScope;
  readonly requestId?: string;
  readonly engineerId?: string;
  readonly alertId?: string;
  readonly policyId?: string;
  readonly question?: string;
}

/** Starts a one-shot explain run. Stream its events with `streamAssistantRun`. */
export function requestAiExplain(token: string, target: ExplainTarget): Promise<{ runId: string }> {
  return requestJson('/api/v1/ai/explain', z.object({ runId: z.string() }), token, {
    method: 'POST',
    body: JSON.stringify(target),
  });
}

// ---------------------------------------------------------------------------------------
// «Решить с AI»: a proposed alert resolution the dispatcher still applies by hand through
// the existing resolution form -- the assistant only pre-fills it.
// ---------------------------------------------------------------------------------------

export const alertResolutionProposalSchema = z.object({
  action: z.string(),
  minutes: z.number().optional(),
  windowDate: z.string().optional(),
  windowStartLocal: z.string().optional(),
  windowEndLocal: z.string().optional(),
  engineerId: z.string().optional(),
  reason: z.string(),
  confidence: z.number(),
  rejected: z.array(z.object({ action: z.string(), why: z.string() })),
});
export type AlertResolutionProposal = z.infer<typeof alertResolutionProposalSchema>;

const alertSuggestResultSchema = z.union([
  z.object({ proposal: alertResolutionProposalSchema, aiOperationId: z.string() }),
  z.object({ refused: z.literal(true), why: z.string() }),
]);
export type AlertSuggestResult = z.infer<typeof alertSuggestResultSchema>;

/** Asks the assistant to propose how to resolve one open alert. Never applies anything. */
export function suggestAlertResolution(
  token: string,
  alertId: string,
  operationId: string,
): Promise<AlertSuggestResult> {
  return requestJson(
    `/api/v1/ai/alerts/${encodeURIComponent(alertId)}/suggest`,
    alertSuggestResultSchema,
    token,
    { method: 'POST', body: JSON.stringify({ operationId }) },
  );
}

// ---------------------------------------------------------------------------------------
// Dispatcher chat handovers: conversations a human dispatcher has been handed, for the
// «Чаты» tab. Every entry is already `conversation.mode === 'dispatcher'` (the server
// only lists those), so wait/answered comes from the handoff's own `state` below, not
// from `mode` -- unlike `HandoffBanner`'s single-conversation view, where reaching
// `dispatcher` mode at all *is* the "a human replied" signal.
// ---------------------------------------------------------------------------------------

export const aiHandoffStateSchema = z.enum(['waiting', 'answered', 'closed']);
export type AiHandoffState = z.infer<typeof aiHandoffStateSchema>;

/**
 * Who started the handover and in what role, the related request/engineer ids, where in
 * the dialogue this episode begins and ends, when it began, and whether a human has
 * replied yet. `state`/`firstReplyAt` -- never `conversation.mode` -- decide waiting vs
 * answered: every chat this endpoint lists is already in `dispatcher` mode, so mode alone
 * cannot tell the two apart.
 */
export const aiHandoffSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  requestedByAccountId: z.string(),
  actorRole: z.enum(['client', 'engineer', 'dispatcher']),
  /** `user` when the assistant escalated, `dispatcher` when a dispatcher opened the chat
   *  from the dashboard -- the client and engineer apps never see a special case for it,
   *  history simply starts with a dispatcher message instead of a user one. */
  initiatedBy: z.enum(['user', 'dispatcher']),
  requestIds: z.array(z.string()),
  engineerIds: z.array(z.string()),
  state: aiHandoffStateSchema,
  /** Message `seq` the dialogue stood at when this episode opened. */
  startSeq: z.number().int(),
  /** Message `seq` this episode ended at, or `null` while it is still live. */
  endSeq: z.number().int().nullable(),
  createdAt: z.number().int(),
  firstReplyAt: z.number().int().nullable(),
  closedAt: z.number().int().nullable(),
});
export type AiHandoffView = z.infer<typeof aiHandoffSchema>;

export const dispatchChatSchema = z.object({
  handoff: aiHandoffSchema,
  conversation: aiConversationSchema,
  messages: z.array(aiMessageSchema),
  /** Missing on an older server: treated as nothing new, never as a false positive. */
  unreadCount: z.number().int().nonnegative().default(0),
});
export type DispatchChatView = z.infer<typeof dispatchChatSchema>;

/**
 * The wire contract of the person-to-person chat stream, mirroring
 * `apps/api/src/api/chat-stream.ts`'s `ChatStreamEvent` field-for-field -- the same
 * mirroring discipline the top of this file already follows for `ai-event.types.ts`. Two
 * endpoints emit exactly this union: one scoped to a single dialogue (`streamConversationEvents`)
 * and one covering every chat handed to the dispatcher (`streamDispatcherChatEvents`).
 */
const chatMessageStreamEventSchema = z.object({
  type: z.literal('message'),
  at: z.number().int(),
  conversationId: z.string(),
  message: aiMessageSchema,
});

const chatStateStreamEventSchema = z.object({
  type: z.literal('state'),
  at: z.number().int(),
  conversationId: z.string(),
  mode: aiConversationModeSchema,
  handoff: aiHandoffSchema.nullable(),
});

export const chatStreamEventSchema = z.discriminatedUnion('type', [
  chatMessageStreamEventSchema,
  chatStateStreamEventSchema,
]);
export type ChatStreamEvent = z.infer<typeof chatStreamEventSchema>;

/** Who a dispatcher-opened chat writes to -- a request's customer, or an engineer, never a
 *  raw account id (mirrors `dispatchChatTargetSchema` in `dispatch-chat.dto.ts`). */
export type DispatchChatTarget =
  | { readonly kind: 'request'; readonly requestId: string }
  | { readonly kind: 'engineer'; readonly engineerId: string };

/** Conversations currently handed to a human dispatcher, live ones first, then finished
 *  ones up to `closedLimit` -- a closed chat stays reachable for context, it is never
 *  deleted (see `DispatchController.listChats`'s own note on why). */
export function loadDispatchChats(
  token: string,
  closedLimit = 30,
): Promise<{ chats: DispatchChatView[] }> {
  return requestJson(
    `/api/v1/dispatch/chats?closedLimit=${closedLimit}`,
    z.object({ chats: z.array(dispatchChatSchema) }),
    token,
  );
}

/**
 * Opens (or re-enters) a chat with a request's customer or with an engineer, from the
 * dashboard rather than from the assistant escalating. Pressing the button again while the
 * chat is already open just returns it.
 */
export function openDispatchChat(
  token: string,
  operationId: string,
  target: DispatchChatTarget,
  text?: string,
): Promise<{ chat: DispatchChatView }> {
  return requestJson('/api/v1/dispatch/chats', z.object({ chat: dispatchChatSchema }), token, {
    method: 'POST',
    body: JSON.stringify({ operationId, target, ...(text ? { text } : {}) }),
  });
}

/** Sends the dispatcher's own reply into a handed-over conversation. The response's `chat`
 *  carries the committed row -- callers that keep a chat list no longer need a separate
 *  refetch to reconcile it. */
export function sendDispatchChatMessage(
  token: string,
  chatId: string,
  operationId: string,
  text: string,
): Promise<{ message: AiMessage; chat: DispatchChatView }> {
  return requestJson(
    `/api/v1/dispatch/chats/${encodeURIComponent(chatId)}/messages`,
    z.object({ message: aiMessageSchema, chat: dispatchChatSchema }),
    token,
    { method: 'POST', body: JSON.stringify({ operationId, text }) },
  );
}

/** Returns the conversation to the AI. History stays -- nothing here deletes messages. */
export function finishDispatchChat(
  token: string,
  chatId: string,
  operationId: string,
): Promise<{ conversation: AiConversation; chat: DispatchChatView }> {
  return requestJson(
    `/api/v1/dispatch/chats/${encodeURIComponent(chatId)}/finish`,
    z.object({ conversation: aiConversationSchema, chat: dispatchChatSchema }),
    token,
    { method: 'POST', body: JSON.stringify({ operationId }) },
  );
}

/** Marks a chat read up to a message `seq`, clearing its unread badge. `null` when the
 *  chat is not found (already finished cursors that moved on are a no-op server-side). */
export function readDispatchChat(
  token: string,
  conversationId: string,
  operationId: string,
  seq: number,
): Promise<{ chat: DispatchChatView | null }> {
  return requestJson(
    `/api/v1/dispatch/chats/${encodeURIComponent(conversationId)}/read`,
    z.object({ chat: dispatchChatSchema.nullable() }),
    token,
    { method: 'POST', body: JSON.stringify({ operationId, seq }) },
  );
}

// ---------------------------------------------------------------------------------------
// The SSE run stream
// ---------------------------------------------------------------------------------------

/**
 * One parsed frame: either a contract-valid event, or a report that a frame arrived but
 * failed to parse. The parser never silently drops a malformed frame — the caller decides
 * what an unreadable event should do to the chat (surface an error, keep going). Generic
 * over the event union so the run stream and the chat stream below share one parser
 * instead of two copies of the same frame-splitting logic.
 */
type StreamOutcome<TEvent> =
  | { readonly ok: true; readonly event: TEvent }
  | { readonly ok: false; readonly error: DashboardApiError; readonly raw: string };

export type AiStreamOutcome = StreamOutcome<AiRunEvent>;

/**
 * Streams run events for one assistant run.
 *
 * This uses `fetch` + `response.body.getReader()`, deliberately NOT `EventSource`.
 * `EventSource` cannot attach an `Authorization` header, and this project forbids putting
 * bearer tokens in a URL (they would then sit in browser history, proxy logs and the
 * `Referer` header of any request the page makes afterwards). `fetch` streaming is the
 * only transport that satisfies both the auth model and that rule, so do not "simplify"
 * this back to `EventSource` — it would silently reintroduce an unauthenticated stream.
 */
export async function streamAssistantRun(
  runId: string,
  token: string,
  afterSeq: number,
  onEvent: (outcome: AiStreamOutcome) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await openAssistantRunEvents(runId, token, afterSeq, signal);
  if (!response.body) {
    throw new DashboardApiError(t('api.ai.f96963397c'), response.status, `ai/runs/${runId}/events`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = drainFrames(buffer, aiRunEventSchema, t('api.ai.0940af4949'), onEvent);
    }
    // A stream that ends right after its last frame's data may not carry a trailing blank
    // line; feed one so that last complete frame is still parsed rather than dropped.
    drainFrames(`${buffer}\n\n`, aiRunEventSchema, t('api.ai.0940af4949'), onEvent);
  } catch (cause) {
    // An aborted read (the caller called stop(), or unmounted) is expected termination,
    // not a failure to report — the reader simply stops.
    if (signal?.aborted) return;
    throw cause instanceof DashboardApiError
      ? cause
      : new DashboardApiError(t('api.ai.0b12c2bba9'), 0, `ai/runs/${runId}/events`);
  } finally {
    reader.releaseLock();
  }
}

/**
 * Non-streaming fallback: reads the whole SSE response body as text and parses every
 * complete frame from it at once. Used by unit tests (no `ReadableStream` plumbing needed)
 * and by the offline demo, which replays a canned response instead of running a live
 * server.
 */
export async function fetchAssistantRunEventsOnce(
  runId: string,
  token: string,
  afterSeq: number,
  signal?: AbortSignal,
): Promise<AiStreamOutcome[]> {
  const response = await openAssistantRunEvents(runId, token, afterSeq, signal);
  const text = await response.text();
  const outcomes: AiStreamOutcome[] = [];
  drainFrames(`${text}\n\n`, aiRunEventSchema, t('api.ai.0940af4949'), (outcome) =>
    outcomes.push(outcome),
  );
  return outcomes;
}

async function openAssistantRunEvents(
  runId: string,
  token: string,
  afterSeq: number,
  signal?: AbortSignal,
): Promise<Response> {
  const response = await fetch(
    `${API_BASE}/api/v1/ai/runs/${encodeURIComponent(runId)}/events?afterSeq=${afterSeq}`,
    { signal, headers: { accept: 'text/event-stream', authorization: `Bearer ${token}` } },
  );
  if (!response.ok) {
    throw new DashboardApiError(
      t('api.ai.125ed29258', { value0: response.status }),
      response.status,
      `ai/runs/${runId}/events`,
    );
  }
  return response;
}

/** Frames are separated by one blank line, `\n\n` (or `\r\n\r\n`), per the SSE format. */
const FRAME_SEPARATOR = /\r?\n\r?\n/;

/**
 * Consumes every complete frame in `buffer` and returns what remains — a possibly-partial
 * frame that arrived split across a chunk boundary and must wait for the rest of it. The
 * parser never looks at that remainder until it is complete. Shared by the run stream and
 * the chat stream below: `schema` is the event union to validate against and `contextLabel`
 * (Russian, for the error text) says which stream a parse failure belongs to.
 */
function drainFrames<TEvent>(
  buffer: string,
  schema: z.ZodType<TEvent>,
  contextLabel: string,
  onEvent: (outcome: StreamOutcome<TEvent>) => void,
): string {
  const parts = buffer.split(FRAME_SEPARATOR);
  const remainder = parts.pop() ?? '';
  for (const frame of parts) {
    parseFrame(frame, schema, contextLabel, onEvent);
  }
  return remainder;
}

function parseFrame<TEvent>(
  frame: string,
  schema: z.ZodType<TEvent>,
  contextLabel: string,
  onEvent: (outcome: StreamOutcome<TEvent>) => void,
): void {
  const dataLines: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.length === 0) continue;
    if (line.startsWith(':')) continue; // comment / heartbeat line (e.g. ": ping") — ignored
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    // Other SSE fields (event:, id:, retry:) are not part of this contract and are ignored.
  }
  if (dataLines.length === 0) return; // a pure comment/heartbeat frame carries no event
  const raw = dataLines.join('\n');
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    onEvent({
      ok: false,
      raw,
      error: new DashboardApiError(
        t('api.ai.86d99ce975', { value0: contextLabel }),
        0,
        'ai-stream',
      ),
    });
    return;
  }
  // Nest writes a periodic keep-alive frame as `event: heartbeat` + `data: {}` on every SSE
  // endpoint (see `AI_SSE_HEARTBEAT_MS` in both `AiController` and `DispatchController`).
  // It is valid JSON but carries no `type`, so it is not a malformed or contract-violating
  // event -- it is not an event at all, and skipping it here (rather than in each caller)
  // is what keeps it from showing up as a bogus "не соответствует контракту" outcome in the
  // /ai-lab raw event log.
  if (typeof json !== 'object' || json === null || !('type' in json)) {
    return;
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    onEvent({
      ok: false,
      raw,
      error: new DashboardApiError(
        t('api.ai.2321c233d0', { value0: contextLabel }),
        0,
        'ai-stream',
      ),
    });
    return;
  }
  onEvent({ ok: true, event: parsed.data });
}

// ---------------------------------------------------------------------------------------
// The SSE chat stream: person-to-person messages and handover state, mirroring
// `chatStreamEventSchema` above. Same transport as `streamAssistantRun` and for the same
// reason (its doc comment covers why `EventSource` is never an option here either).
// ---------------------------------------------------------------------------------------

export type ChatStreamOutcome = StreamOutcome<ChatStreamEvent>;

/**
 * Streams one already-built SSE endpoint's events: a single dialogue
 * (`streamConversationEvents`) or the dispatcher's cross-chat feed
 * (`streamDispatcherChatEvents`). `url` is the full request URL so this one function serves
 * both -- the two thin wrappers below only differ in how they build it.
 */
export async function streamChatEvents(
  url: string,
  token: string,
  onEvent: (outcome: ChatStreamOutcome) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(url, {
    signal,
    headers: { accept: 'text/event-stream', authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new DashboardApiError(
      t('api.ai.6f5e9677f5', { value0: response.status }),
      response.status,
      'chat-stream',
    );
  }
  if (!response.body) {
    throw new DashboardApiError(t('api.ai.016128877e'), response.status, 'chat-stream');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = drainFrames(buffer, chatStreamEventSchema, t('api.ai.5e04c41f88'), onEvent);
    }
    // Same trailing-frame rule as the run stream: feed a closing blank line so a last frame
    // with no following one of its own is still parsed rather than dropped.
    drainFrames(`${buffer}\n\n`, chatStreamEventSchema, t('api.ai.5e04c41f88'), onEvent);
  } catch (cause) {
    // An aborted read (the caller reconnecting, or unmounting) is expected termination, not
    // a failure to report — the reader simply stops.
    if (signal?.aborted) return;
    throw cause instanceof DashboardApiError
      ? cause
      : new DashboardApiError(t('api.ai.07959bf5c2'), 0, 'chat-stream');
  } finally {
    reader.releaseLock();
  }
}

/** One dialogue's own stream: every message written into it, by whoever, plus its mode.
 *  `afterSeq` resumes from the highest message `seq` already rendered, same convention as
 *  `streamAssistantRun`. */
export function streamConversationEvents(
  conversationId: string,
  token: string,
  afterSeq: number,
  onEvent: (outcome: ChatStreamOutcome) => void,
  signal?: AbortSignal,
): Promise<void> {
  return streamChatEvents(
    `${API_BASE}/api/v1/ai/conversations/${encodeURIComponent(conversationId)}/events?afterSeq=${afterSeq}`,
    token,
    onEvent,
    signal,
  );
}

/** Every message and handover change across every chat handed to the dispatcher. Carries
 *  no catch-up replay of its own -- a reconnect re-reads `GET /dispatch/chats` instead, see
 *  that endpoint's own note on why. */
export function streamDispatcherChatEvents(
  token: string,
  onEvent: (outcome: ChatStreamOutcome) => void,
  signal?: AbortSignal,
): Promise<void> {
  return streamChatEvents(`${API_BASE}/api/v1/dispatch/chats/events`, token, onEvent, signal);
}
