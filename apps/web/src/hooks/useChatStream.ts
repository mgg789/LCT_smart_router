import { useEffect, useRef, useState } from 'react';

export interface UseChatStreamOptions<TOutcome> {
  readonly token: string | null;
  readonly enabled: boolean;
  /** The transport call, already bound to its endpoint and arguments (e.g.
   *  `(onEvent, signal) => streamConversationEvents(conversationId, token, afterSeq, onEvent,
   *  signal)`). This hook owns *when* it runs -- connect, tear down, reconnect -- and never
   *  *what* it asks for, which is what lets the same hook serve both the single-dialogue
   *  stream and the dispatcher's cross-chat one. */
  readonly connect: (onEvent: (outcome: TOutcome) => void, signal: AbortSignal) => Promise<void>;
  readonly onEvent: (outcome: TOutcome) => void;
}

export interface UseChatStreamResult {
  readonly connected: boolean;
}

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 15_000;

/**
 * Owns one SSE chat subscription and its reconnect loop.
 *
 * `connect`'s promise only resolves once the stream ends (network drop, server restart) or
 * rejects on a genuine failure -- there is no separate "connection opened" signal, so
 * `connected` is driven by the first event actually delivered rather than by the fetch
 * succeeding. For `streamConversationEvents` that is immediate (the server always replays a
 * `state` event on connect, see `AiController.replayConversation`); for the dispatcher's
 * feed, which replays nothing, `connected` only turns true once *something* happens on any
 * handed-over chat -- an accepted gap, not a bug, since that stream's whole contract is "the
 * dispatcher re-reads the list after one" (see `chat-stream.ts`'s own doc comment).
 *
 * Reconnects with a bounded backoff (starts at ~1s, caps at ~15s, reset by every event —
 * a live frame is proof the stream recovered) unless the disconnect was this hook tearing
 * itself down (unmount, or `enabled`/`token` changing), which aborts instead of scheduling
 * another attempt. Follows the in-flight-ref / generation-counter idiom from
 * `useAssistantChat.ts` and `useDashboard.ts` so a stale attempt's late reconnect can never
 * race a fresh one.
 */
export function useChatStream<TOutcome>({
  token,
  enabled,
  connect,
  onEvent,
}: UseChatStreamOptions<TOutcome>): UseChatStreamResult {
  const [connected, setConnected] = useState(false);
  const generationRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<number | null>(null);
  // Read inside the effect without making `connect`/`onEvent` identity part of its deps --
  // both are typically freshly created closures on every render of the caller.
  const connectRef = useRef(connect);
  connectRef.current = connect;
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!token || !enabled) {
      setConnected(false);
      return;
    }
    generationRef.current += 1;
    const generation = generationRef.current;
    let backoffMs = INITIAL_BACKOFF_MS;

    const attempt = () => {
      if (generation !== generationRef.current) return;
      const controller = new AbortController();
      abortRef.current = controller;
      connectRef
        .current((outcome) => {
          if (generation !== generationRef.current) return;
          setConnected(true);
          backoffMs = INITIAL_BACKOFF_MS;
          onEventRef.current(outcome);
        }, controller.signal)
        .catch(() => {
          // Swallowed deliberately: reconnecting below *is* the recovery. A caller that
          // wants to surface a persistent outage reads `connected` instead of an error.
        })
        .finally(() => {
          if (generation !== generationRef.current || controller.signal.aborted) return;
          setConnected(false);
          const wait = backoffMs;
          backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
          timerRef.current = window.setTimeout(attempt, wait);
        });
    };

    attempt();

    return () => {
      generationRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setConnected(false);
    };
  }, [token, enabled]);

  return { connected };
}
