import { authorizedRequest, useSessionStore } from '@/entities/session';
import { readEventStream } from '@/shared/api';
import { newOperationId } from '@/shared/lib';
import type {
  AiAssistMode,
  AiConversation,
  AiMessage,
  AiRunEvent,
  ExplainRequest,
  OperationOutcome,
} from '../model/types';

/**
 * `POST /ai/conversations` — returns the dispatcher's open dialogue or starts one.
 *
 * `assistMode` is not a field of this dialogue but a durable system-wide flag
 * (docs/frontend-api.md §9.7), so sending it here switches the lane for every
 * later run too.
 */
export function openConversation(assistMode?: AiAssistMode): Promise<{
  conversation: AiConversation;
}> {
  return authorizedRequest('/ai/conversations', {
    method: 'POST',
    body: assistMode ? { assistMode } : {},
  });
}

/** `GET /ai/conversations/:id/messages?afterSeq=` — the tail after a cursor (§9.2). */
export function getConversationMessages(
  conversationId: string,
  afterSeq = 0,
): Promise<{ messages: AiMessage[] }> {
  return authorizedRequest(`/ai/conversations/${conversationId}/messages?afterSeq=${afterSeq}`);
}

export interface SendMessageResult {
  /** `null` together with `handedOver: true`: a human owns the dialogue now. */
  runId: string | null;
  messageSeq: number;
  /** The dialogue is with a dispatcher, so no run starts and no quota is spent. */
  handedOver: boolean;
  quota?: { remainingMicros: number; remainingMessages: number; resetAt: number };
}

/** `POST /ai/conversations/:id/messages` — the operation envelope plus the text. */
export function sendConversationMessage(
  conversationId: string,
  text: string,
): Promise<SendMessageResult> {
  return authorizedRequest(`/ai/conversations/${conversationId}/messages`, {
    method: 'POST',
    body: { operationId: newOperationId(), text },
  });
}

/**
 * `POST /ai/runs/:runId/stop` — asks the run to end.
 *
 * The run still finishes through an ordinary `stopped` event in the stream rather
 * than being cut off by this answer, and a card that was already applied stays
 * applied: stopping is not a rollback (§9.6).
 */
export function stopRun(runId: string): Promise<{ stopped: boolean }> {
  return authorizedRequest(`/ai/runs/${runId}/stop`, {
    method: 'POST',
    body: { operationId: newOperationId() },
  });
}

/** `POST /ai/operations/:id/apply` — confirms a card the server prepared. */
export function applyOperation(operationId: string): Promise<OperationOutcome> {
  return authorizedRequest(`/ai/operations/${operationId}/apply`, {
    method: 'POST',
    body: { operationId: newOperationId() },
  });
}

/** `POST /ai/operations/:id/cancel` — declines it before it runs. */
export function cancelOperation(operationId: string): Promise<OperationOutcome> {
  return authorizedRequest(`/ai/operations/${operationId}/cancel`, {
    method: 'POST',
    body: { operationId: newOperationId() },
  });
}

/**
 * `GET /ai/runs/:runId/events?afterSeq=` — one run, from a cursor onwards.
 *
 * Read through `fetch` streaming rather than `EventSource`, which cannot carry the
 * bearer token in a header (§9.1). Resuming at the last rendered `seq` after a
 * reload is ordinary, not a lost answer — except for `message_delta`, which is
 * never replayed, so partial text is not redrawn from a claim that cannot be
 * proved.
 */
export function streamRunEvents(
  runId: string,
  afterSeq = 0,
  signal?: AbortSignal,
): AsyncGenerator<AiRunEvent> {
  return readEventStream<AiRunEvent>(`/ai/runs/${runId}/events?afterSeq=${afterSeq}`, {
    token: useSessionStore.getState().session?.token ?? null,
    signal,
  });
}

/**
 * `POST /ai/explain` — asks why the plan looks the way it does about one object.
 *
 * Answers with a run id and nothing else: the explanation itself arrives over
 * `GET /ai/runs/:runId/events`, exactly like an ordinary reply, so there is one
 * way to read an assistant answer rather than two.
 */
export function requestExplanation(body: ExplainRequest): Promise<{ runId: string }> {
  return authorizedRequest('/ai/explain', { method: 'POST', body });
}
