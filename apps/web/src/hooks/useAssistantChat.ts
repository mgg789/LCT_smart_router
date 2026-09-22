import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type AiActionButton,
  type AiAssistMode,
  type AiConversation,
  type AiMessage,
  type AiMessageAuthor,
  type AiMessageKind,
  type AiOperationState,
  type AiPreviewRow,
  type AiQuota,
  type AiRoleProfile,
  type AiRunState,
  type AiStreamOutcome,
  applyAiOperation,
  type ChatStreamOutcome,
  cancelAiOperation,
  createAiConversation,
  loadAiMessages,
  sendAiMessage,
  stopAiRun,
  streamAssistantRun,
  streamConversationEvents,
} from '../api/ai';
import { DashboardApiError } from '../api/client';
import { useChatStream } from './useChatStream';

/** Where the chat panel is mounted. Drives the role profile a new conversation opens as. */
export type AssistantSurface = 'client' | 'engineer' | 'dispatcher' | 'lab';

/** One rendered chat bubble, built either from a persisted `AiMessage` or a run event. */
export interface AssistantChatMessage {
  readonly id: string;
  readonly seq: number;
  readonly author: AiMessageAuthor;
  readonly kind: AiMessageKind;
  readonly text: string;
  readonly actions: readonly AiActionButton[];
  readonly createdAt: number;
  /** True only for the optimistic local echo or the still-streaming assistant bubble. */
  readonly pending: boolean;
}

export interface AiOperationView {
  readonly operationId: string;
  readonly action: string;
  readonly targetRef: string | null;
  readonly state: AiOperationState;
  readonly preview: readonly AiPreviewRow[];
  readonly expiresAt: number;
  readonly error?: { readonly code: string; readonly message: string };
}

/**
 * The four system-unavailable states `AiUnavailablePanel` renders. Quota is tracked
 * separately from a provider failure on purpose (context/35 section 8): a run stopped
 * because the daily budget ran out must never read as "AI сейчас недоступен".
 */
export type AiUnavailableReason = 'provider' | 'quota' | 'auth' | 'stopped';

export type HandoffStatus = 'waiting' | 'answered' | null;

export interface UseAssistantChatOptions {
  readonly token: string | null;
  readonly surface: AssistantSurface;
  readonly contextRef?: unknown;
  readonly assistMode?: AiAssistMode;
  /** Fires for every SSE frame exactly as it arrived off the wire, including
   * `message_delta` and parse failures -- before the generation check below can drop a
   * stale one. Used only by the `/ai-lab` raw event log; ordinary surfaces leave it unset. */
  readonly onRawEvent?: (outcome: AiStreamOutcome) => void;
}

export interface UseAssistantChatResult {
  readonly conversation: AiConversation | null;
  readonly messages: readonly AssistantChatMessage[];
  readonly operations: ReadonlyMap<string, AiOperationView>;
  readonly runState: AiRunState | null;
  readonly quota: AiQuota | null;
  readonly handoffStatus: HandoffStatus;
  /** A short "what the assistant is doing right now" line, from `tool_started`. */
  readonly activity: string | null;
  readonly loading: boolean;
  readonly sending: boolean;
  readonly error: string | null;
  readonly unavailable: AiUnavailableReason | null;
  readonly sendMessage: (text: string) => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly applyOperation: (operationId: string) => Promise<void>;
  readonly cancelOperation: (operationId: string) => Promise<void>;
}

interface StoredAssistantSession {
  readonly conversationId: string;
  readonly lastMessageSeq: number;
  readonly runId: string | null;
  readonly lastEventSeq: number;
}

function storageKey(surface: AssistantSurface, contextRef: unknown): string {
  // contextRef is a small server-defined selector object (e.g. {type:'request',id}), so a
  // plain JSON.stringify is a stable enough cache key without hashing it.
  return `lct.ai.chat.${surface}.${JSON.stringify(contextRef ?? null)}`;
}

function readStoredSession(key: string): StoredAssistantSession | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<StoredAssistantSession>;
    if (typeof parsed.conversationId !== 'string' || parsed.conversationId.length === 0) {
      return null;
    }
    return {
      conversationId: parsed.conversationId,
      lastMessageSeq: typeof parsed.lastMessageSeq === 'number' ? parsed.lastMessageSeq : 0,
      runId: typeof parsed.runId === 'string' ? parsed.runId : null,
      lastEventSeq: typeof parsed.lastEventSeq === 'number' ? parsed.lastEventSeq : 0,
    };
  } catch {
    return null;
  }
}

function writeStoredSession(key: string, session: StoredAssistantSession): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(session));
  } catch {
    // Best-effort cache: a full or blocked localStorage must not break the chat.
  }
}

/** Maps the chat surface (and, for a dispatcher, their chosen assist mode) to a role profile. */
function roleProfileFor(
  surface: AssistantSurface,
  assistMode: AiAssistMode | undefined,
): AiRoleProfile {
  switch (surface) {
    case 'client':
      return 'client';
    case 'engineer':
      return 'engineer';
    case 'dispatcher':
      return assistMode === 'fix' ? 'dispatcher_fix' : 'dispatcher_readonly';
    case 'lab':
      // The internal preview surface never writes; read-only is the safe default profile.
      return 'dispatcher_readonly';
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'Не удалось выполнить действие';
}

function messageFromApi(message: AiMessage): AssistantChatMessage {
  return {
    id: message.id,
    seq: message.seq,
    author: message.author,
    kind: message.kind,
    text: message.text,
    actions: message.actions,
    createdAt: message.createdAt,
    pending: false,
  };
}

const DISPATCHER_POLL_MS = 2000;

/**
 * Owns one assistant conversation: history, the live run stream, prepared operations and
 * the dispatcher-handover poll. Follows the in-flight-ref / generation-counter idiom from
 * `apps/web/src/hooks/useDashboard.ts` so a slow stale read can never clobber a newer one.
 */
export function useAssistantChat({
  token,
  surface,
  contextRef,
  assistMode,
  onRawEvent,
}: UseAssistantChatOptions): UseAssistantChatResult {
  const [conversation, setConversation] = useState<AiConversation | null>(null);
  const [messages, setMessages] = useState<AssistantChatMessage[]>([]);
  const [streaming, setStreaming] = useState<{ id: string; text: string } | null>(null);
  const [operations, setOperations] = useState<Map<string, AiOperationView>>(new Map());
  const [runState, setRunState] = useState<AiRunState | null>(null);
  const [quota, setQuota] = useState<AiQuota | null>(null);
  const [handoffStatus, setHandoffStatus] = useState<HandoffStatus>(null);
  const [activity, setActivity] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState<AiUnavailableReason | null>(null);

  const runIdRef = useRef<string | null>(null);
  const lastEventSeqRef = useRef(0);
  const lastMessageSeqRef = useRef(0);
  const streamAbortRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const conversationRef = useRef<AiConversation | null>(null);
  // Read inside the bootstrap effect without forcing a rerun on every inline-object
  // identity change; the effect itself only re-keys on `key`, which already reflects
  // contextRef's *value* (see storageKey).
  const contextRefLatest = useRef(contextRef);
  contextRefLatest.current = contextRef;
  const onRawEventRef = useRef(onRawEvent);
  onRawEventRef.current = onRawEvent;

  const key = storageKey(surface, contextRef);

  const persist = useCallback(
    (patch: Partial<StoredAssistantSession>) => {
      const conversationId = conversationRef.current?.id;
      if (!conversationId) return;
      writeStoredSession(key, {
        conversationId,
        lastMessageSeq: lastMessageSeqRef.current,
        runId: runIdRef.current,
        lastEventSeq: lastEventSeqRef.current,
        ...patch,
      });
    },
    [key],
  );

  const updateConversation = useCallback((updater: (prev: AiConversation) => AiConversation) => {
    setConversation((current) => {
      if (!current) return current;
      const next = updater(current);
      conversationRef.current = next;
      return next;
    });
  }, []);

  /**
   * Adds or replaces a server-confirmed message and advances the resume cursor.
   *
   * Matches on `id` first -- the ordinary case, since the same persisted message always
   * carries the same real id everywhere it is delivered from (a run event's `messageId`,
   * the chat stream's `message.id`, a poll's `AiMessage.id`). It also matches on `seq`: the
   * optimistic local echo (`sendMessage` below) never gets a real id, only a real `seq` once
   * the send resolves, so the chat stream's own copy of that same user message -- which does
   * carry the real id, and can arrive before or after the send's own response -- has to be
   * recognised as the same message by `seq` alone. Either way exactly one row survives.
   */
  const appendAuthoritative = useCallback((message: AssistantChatMessage) => {
    setMessages((current) => {
      const withoutDuplicate = current.filter(
        (item) =>
          item.id !== message.id && !(Number.isFinite(message.seq) && item.seq === message.seq),
      );
      return [...withoutDuplicate, message].sort((a, b) => a.seq - b.seq);
    });
    if (message.seq > lastMessageSeqRef.current) lastMessageSeqRef.current = message.seq;
  }, []);

  const runStream = useCallback(
    (runId: string, afterSeq: number, generation: number) => {
      runIdRef.current = runId;
      lastEventSeqRef.current = afterSeq;
      const controller = new AbortController();
      streamAbortRef.current = controller;
      setRunState('running');
      void streamAssistantRun(
        runId,
        token ?? '',
        afterSeq,
        (outcome) => {
          onRawEventRef.current?.(outcome);
          if (generation !== generationRef.current) return;
          if (!outcome.ok) {
            setError(outcome.error.message);
            return;
          }
          const event = outcome.event;
          lastEventSeqRef.current = Math.max(lastEventSeqRef.current, event.seq);
          persist({});
          switch (event.type) {
            case 'run_started':
              setRunState('running');
              break;
            case 'message_delta':
              setStreaming((current) =>
                current && current.id === event.messageId
                  ? { id: event.messageId, text: current.text + event.text }
                  : { id: event.messageId, text: event.text },
              );
              break;
            case 'message':
              setStreaming((current) => (current?.id === event.messageId ? null : current));
              appendAuthoritative({
                id: event.messageId,
                seq: event.messageSeq,
                author: 'assistant',
                kind: event.kind,
                text: event.text,
                actions: event.actions,
                createdAt: event.at,
                pending: false,
              });
              setActivity(null);
              break;
            case 'tool_started':
              setActivity(event.intent);
              break;
            case 'tool_result':
              setActivity(null);
              break;
            case 'operation_prepared':
              setOperations((current) => {
                const next = new Map(current);
                next.set(event.operationId, {
                  operationId: event.operationId,
                  action: event.action,
                  targetRef: event.targetRef,
                  state: event.state,
                  preview: event.preview,
                  expiresAt: event.expiresAt,
                });
                return next;
              });
              break;
            case 'operation_state':
              setOperations((current) => {
                const next = new Map(current);
                const existing = next.get(event.operationId);
                next.set(event.operationId, {
                  operationId: event.operationId,
                  action: existing?.action ?? '',
                  targetRef: existing?.targetRef ?? null,
                  preview: existing?.preview ?? [],
                  expiresAt: existing?.expiresAt ?? 0,
                  state: event.state,
                  error: event.error,
                });
                return next;
              });
              break;
            case 'help_requested':
              setHandoffStatus('waiting');
              break;
            case 'mode_changed':
              updateConversation((prev) => ({ ...prev, mode: event.mode }));
              // A conversation only ever switches to `dispatcher` once a human has
              // answered the handoff (schema.prisma, AiConversation.mode) — so the flip
              // itself is the "answered" signal, not just a queued request.
              if (event.mode === 'dispatcher') setHandoffStatus('answered');
              break;
            case 'quota':
              setQuota({
                remainingMicros: event.remainingMicros,
                remainingMessages: event.remainingMessages,
                resetAt: event.resetAt,
              });
              if (event.remainingMessages <= 0) setUnavailable('quota');
              break;
            case 'stopped':
              setRunState('stopped');
              setStreaming(null);
              setActivity(null);
              // A user-initiated stop or a handover away from the AI are ordinary,
              // expected endings and must not present as a system outage.
              if (event.reason === 'shutdown') setUnavailable('stopped');
              else if (event.reason === 'budget') setUnavailable('quota');
              break;
            case 'error':
              setActivity(null);
              // Quota is a distinct condition and must never be dressed up as a
              // provider failure (context/35 section 8); everything else genuinely is.
              setUnavailable(event.code.toLowerCase().includes('quota') ? 'quota' : 'provider');
              setError(event.message);
              break;
            case 'run_finished':
              setRunState(event.state);
              setStreaming(null);
              setActivity(null);
              break;
          }
        },
        controller.signal,
      )
        .catch((cause: unknown) => {
          if (generation !== generationRef.current) return;
          if (
            cause instanceof DashboardApiError &&
            (cause.status === 401 || cause.status === 403)
          ) {
            setUnavailable('auth');
            return;
          }
          setUnavailable('provider');
          setError(errorMessage(cause));
        })
        .finally(() => {
          if (generation === generationRef.current && streamAbortRef.current === controller) {
            streamAbortRef.current = null;
          }
        });
    },
    [appendAuthoritative, persist, token, updateConversation],
  );

  const pollDispatcherMessages = useCallback(
    async (generation: number) => {
      const conv = conversationRef.current;
      if (!token || !conv) return;
      try {
        const result = await loadAiMessages(token, conv.id, lastMessageSeqRef.current);
        if (generation !== generationRef.current) return;
        for (const item of result.messages) appendAuthoritative(messageFromApi(item));
        setConversation(result.conversation);
        conversationRef.current = result.conversation;
        persist({});
      } catch (cause) {
        if (generation !== generationRef.current) return;
        if (cause instanceof DashboardApiError && (cause.status === 401 || cause.status === 403)) {
          setUnavailable('auth');
        }
      }
    },
    [appendAuthoritative, persist, token],
  );

  // Bootstrap: resume a stored conversation (and its run/poll), or open a new one.
  useEffect(() => {
    if (!token) {
      setLoading(false);
      return;
    }
    generationRef.current += 1;
    const generation = generationRef.current;
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
    setLoading(true);
    setError(null);
    setUnavailable(null);
    setMessages([]);
    setStreaming(null);
    setOperations(new Map());
    setRunState(null);
    setHandoffStatus(null);
    setActivity(null);
    lastMessageSeqRef.current = 0;
    lastEventSeqRef.current = 0;
    runIdRef.current = null;

    async function bootstrap() {
      try {
        const stored = readStoredSession(key);
        let conv: AiConversation;
        if (stored) {
          const result = await loadAiMessages(
            token as string,
            stored.conversationId,
            stored.lastMessageSeq,
          );
          if (generation !== generationRef.current) return;
          conv = result.conversation;
          lastMessageSeqRef.current = stored.lastMessageSeq;
          for (const item of result.messages) appendAuthoritative(messageFromApi(item));
          runIdRef.current = stored.runId;
          lastEventSeqRef.current = stored.lastEventSeq;
        } else {
          conv = await createAiConversation(token as string, {
            roleProfile: roleProfileFor(surface, assistMode),
            ...(assistMode ? { assistMode } : {}),
            ...(contextRefLatest.current !== undefined
              ? { contextRef: contextRefLatest.current }
              : {}),
          });
        }
        if (generation !== generationRef.current) return;
        setConversation(conv);
        conversationRef.current = conv;
        persist({ conversationId: conv.id });
        // See the `mode_changed` handler above: reaching `dispatcher` mode at all means a
        // human has already answered, so that is the resumed "answered" state; a request
        // still awaiting a reply is restored from the replayed `help_requested` event once
        // the run stream below reconnects.
        setHandoffStatus(conv.mode === 'dispatcher' ? 'answered' : null);
        if (conv.mode !== 'dispatcher' && runIdRef.current) {
          runStream(runIdRef.current, lastEventSeqRef.current, generation);
        }
      } catch (cause) {
        if (generation !== generationRef.current) return;
        if (cause instanceof DashboardApiError && (cause.status === 401 || cause.status === 403)) {
          setUnavailable('auth');
        } else {
          setError(errorMessage(cause));
        }
      } finally {
        if (generation === generationRef.current) setLoading(false);
      }
    }

    void bootstrap();

    return () => {
      generationRef.current += 1;
      streamAbortRef.current?.abort();
      streamAbortRef.current = null;
    };
  }, [token, key, surface, assistMode, appendAuthoritative, persist, runStream]);

  // Bound to the *current* conversation and read cursor on every (re)connect attempt --
  // `useChatStream` calls this afresh on each attempt, so a reconnect after a drop resumes
  // from wherever this reader has actually rendered up to, not from wherever it started.
  const connectChatStream = useCallback(
    (onEvent: (outcome: ChatStreamOutcome) => void, signal: AbortSignal) => {
      const conv = conversationRef.current;
      if (!token || !conv) return Promise.resolve();
      return streamConversationEvents(conv.id, token, lastMessageSeqRef.current, onEvent, signal);
    },
    [token],
  );

  const handleChatStreamEvent = useCallback(
    (outcome: ChatStreamOutcome) => {
      if (!outcome.ok) return; // a malformed or contract-mismatched frame has nothing to fold in
      const event = outcome.event;
      switch (event.type) {
        case 'message':
          // Also clears a still-streaming assistant placeholder if it finished on this side
          // before the run stream's own `message` event got here -- both feeds carry it.
          setStreaming((current) => (current?.id === event.message.id ? null : current));
          appendAuthoritative(messageFromApi(event.message));
          break;
        case 'state':
          updateConversation((prev) => ({ ...prev, mode: event.mode }));
          setHandoffStatus(
            event.mode === 'dispatcher'
              ? event.handoff?.state === 'waiting'
                ? 'waiting'
                : 'answered'
              : null,
          );
          break;
      }
      persist({});
    },
    [appendAuthoritative, persist, updateConversation],
  );

  /** The primary path for a dispatcher-carried dialogue (`pollDispatcherMessages` below is
   *  only its fallback): every message and handover change, for as long as a conversation is
   *  open, regardless of which mode it is in right now. A dispatcher-initiated chat needs no
   *  special case here -- it is just a `state` event flipping the mode, followed by `message`
   *  events, exactly like every other handover. */
  const { connected: chatStreamConnected } = useChatStream({
    token,
    enabled: conversation !== null,
    connect: connectChatStream,
    onEvent: handleChatStreamEvent,
  });

  // The dispatcher handover poll: only while a human, not the model, owns this dialogue, and
  // only as the fallback for a proxy that buffers SSE -- it stops the moment the chat stream
  // above is connected, which is the primary path.
  useEffect(() => {
    if (!token || conversation?.mode !== 'dispatcher' || chatStreamConnected) return;
    const generation = generationRef.current;
    const timer = window.setInterval(
      () => void pollDispatcherMessages(generation),
      DISPATCHER_POLL_MS,
    );
    return () => window.clearInterval(timer);
  }, [token, conversation?.mode, chatStreamConnected, pollDispatcherMessages]);

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!token || !conversation || trimmed.length === 0 || sending) return;
      setSending(true);
      setError(null);
      // A fresh send is the user's own retry gesture: a stale provider/quota flag from a
      // previous attempt must not keep blocking the composer forever.
      setUnavailable(null);
      const localId = `local-${crypto.randomUUID()}`;
      const localMessage: AssistantChatMessage = {
        id: localId,
        seq: Number.POSITIVE_INFINITY,
        author: 'user',
        kind: 'text',
        text: trimmed,
        actions: [],
        createdAt: Math.floor(Date.now() / 1000),
        pending: true,
      };
      setMessages((current) => [...current, localMessage]);
      try {
        const result = await sendAiMessage(token, conversation.id, crypto.randomUUID(), trimmed);
        if (result.runId === null) {
          // Already fully handed to a dispatcher: drop the local echo and let the poll
          // (fired immediately, then every 2s) bring back the authoritative copy.
          setMessages((current) => current.filter((item) => item.id !== localId));
          setHandoffStatus('answered');
          persist({ runId: null });
          await pollDispatcherMessages(generationRef.current);
          return;
        }
        // `messageSeq` is the seq the server just assigned to this user message. Routed
        // through `appendAuthoritative`, not a plain patch, so it also absorbs the chat
        // stream's own copy of this same message if that already arrived first (see that
        // function's own note on the race).
        appendAuthoritative({
          id: localId,
          seq: result.messageSeq,
          author: 'user',
          kind: 'text',
          text: trimmed,
          actions: [],
          createdAt: localMessage.createdAt,
          pending: false,
        });
        setQuota(result.quota);
        if (result.quota.remainingMessages <= 0) setUnavailable('quota');
        persist({ runId: result.runId, lastEventSeq: 0 });
        runStream(result.runId, 0, generationRef.current);
      } catch (cause) {
        setMessages((current) => current.filter((item) => item.id !== localId));
        if (cause instanceof DashboardApiError && (cause.status === 401 || cause.status === 403)) {
          setUnavailable('auth');
        } else if (cause instanceof DashboardApiError && cause.status === 429) {
          setUnavailable('quota');
        } else {
          setUnavailable('provider');
        }
        setError(errorMessage(cause));
      } finally {
        setSending(false);
      }
    },
    [token, conversation, sending, persist, runStream, pollDispatcherMessages, appendAuthoritative],
  );

  const stop = useCallback(async () => {
    if (!token || !runIdRef.current) return;
    try {
      await stopAiRun(token, runIdRef.current, crypto.randomUUID());
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, [token]);

  const applyOperation = useCallback(
    async (operationId: string) => {
      if (!token) return;
      setOperations((current) => {
        const next = new Map(current);
        const existing = next.get(operationId);
        if (existing) next.set(operationId, { ...existing, state: 'running' });
        return next;
      });
      try {
        const result = await applyAiOperation(token, operationId);
        setOperations((current) => {
          const next = new Map(current);
          const existing = next.get(operationId);
          next.set(operationId, {
            operationId,
            action: existing?.action ?? '',
            targetRef: existing?.targetRef ?? null,
            preview: existing?.preview ?? [],
            expiresAt: existing?.expiresAt ?? 0,
            state: result.state,
            error: result.error,
          });
          return next;
        });
      } catch (cause) {
        setError(errorMessage(cause));
      }
    },
    [token],
  );

  const cancelOperation = useCallback(
    async (operationId: string) => {
      if (!token) return;
      try {
        const result = await cancelAiOperation(token, operationId);
        setOperations((current) => {
          const next = new Map(current);
          const existing = next.get(operationId);
          next.set(operationId, {
            operationId,
            action: existing?.action ?? '',
            targetRef: existing?.targetRef ?? null,
            preview: existing?.preview ?? [],
            expiresAt: existing?.expiresAt ?? 0,
            state: result.state,
            error: result.error,
          });
          return next;
        });
      } catch (cause) {
        setError(errorMessage(cause));
      }
    },
    [token],
  );

  const renderedMessages = useMemo(() => {
    if (!streaming) return messages;
    return [
      ...messages,
      {
        id: streaming.id,
        seq: Number.POSITIVE_INFINITY,
        author: 'assistant' as const,
        kind: 'text' as const,
        text: streaming.text,
        actions: [],
        createdAt: Math.floor(Date.now() / 1000),
        pending: true,
      },
    ];
  }, [messages, streaming]);

  return {
    conversation,
    messages: renderedMessages,
    operations,
    runState,
    quota,
    handoffStatus,
    activity,
    loading,
    sending,
    error,
    unavailable,
    sendMessage,
    stop,
    applyOperation,
    cancelOperation,
  };
}
