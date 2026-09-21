import { useCallback, useRef, useState } from 'react';
import { type ExplainTarget, requestAiExplain, streamAssistantRun } from '../api/ai';
import { DashboardApiError } from '../api/client';
import type { AiUnavailableReason } from './useAssistantChat';

export interface ExplainRunState {
  readonly text: string;
  readonly activity: string | null;
  readonly loading: boolean;
  readonly done: boolean;
  readonly error: string | null;
  readonly unavailable: AiUnavailableReason | null;
}

const IDLE_STATE: ExplainRunState = {
  text: '',
  activity: null,
  loading: false,
  done: false,
  error: null,
  unavailable: null,
};

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'Не удалось получить объяснение';
}

/**
 * Owns one one-shot `/ai/explain` run: no conversation, no persistence, no dispatcher
 * handover -- just "why is this the way it is" for one object on screen. Mirrors the
 * generation-guarded in-flight idiom `useAssistantChat` and `useDashboard` already use, so a
 * stale run from a previous target can never overwrite a newer one.
 */
export function useExplainRun(token: string | null) {
  const [state, setState] = useState<ExplainRunState>(IDLE_STATE);
  const generationRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(
    (target: ExplainTarget) => {
      abortRef.current?.abort();
      generationRef.current += 1;
      const generation = generationRef.current;
      if (!token) {
        setState({ ...IDLE_STATE, unavailable: 'auth' });
        return;
      }
      setState({ ...IDLE_STATE, loading: true });
      void (async () => {
        try {
          const { runId } = await requestAiExplain(token, target);
          if (generation !== generationRef.current) return;
          const controller = new AbortController();
          abortRef.current = controller;
          await streamAssistantRun(
            runId,
            token,
            0,
            (outcome) => {
              if (generation !== generationRef.current) return;
              if (!outcome.ok) {
                setState((current) => ({ ...current, error: outcome.error.message }));
                return;
              }
              const event = outcome.event;
              switch (event.type) {
                case 'message_delta':
                  setState((current) => ({ ...current, text: current.text + event.text }));
                  break;
                case 'message':
                  setState((current) => ({ ...current, text: event.text, activity: null }));
                  break;
                case 'tool_started':
                  setState((current) => ({ ...current, activity: event.intent }));
                  break;
                case 'tool_result':
                  setState((current) => ({ ...current, activity: null }));
                  break;
                case 'quota':
                  if (event.remainingMessages <= 0) {
                    setState((current) => ({ ...current, unavailable: 'quota' }));
                  }
                  break;
                case 'stopped':
                  setState((current) => ({
                    ...current,
                    activity: null,
                    unavailable:
                      event.reason === 'budget'
                        ? 'quota'
                        : event.reason === 'shutdown'
                          ? 'stopped'
                          : current.unavailable,
                  }));
                  break;
                case 'error':
                  setState((current) => ({
                    ...current,
                    activity: null,
                    error: event.message,
                    unavailable: event.code.toLowerCase().includes('quota') ? 'quota' : 'provider',
                  }));
                  break;
                case 'run_finished':
                  setState((current) => ({
                    ...current,
                    loading: false,
                    done: true,
                    activity: null,
                  }));
                  break;
                default:
                  break;
              }
            },
            controller.signal,
          );
        } catch (cause) {
          if (generation !== generationRef.current) return;
          const unavailable: AiUnavailableReason | undefined =
            cause instanceof DashboardApiError && (cause.status === 401 || cause.status === 403)
              ? 'auth'
              : cause instanceof DashboardApiError && cause.status === 429
                ? 'quota'
                : 'provider';
          setState((current) => ({
            ...current,
            loading: false,
            error: errorMessage(cause),
            unavailable,
          }));
        }
      })();
    },
    [token],
  );

  const reset = useCallback(() => {
    abortRef.current?.abort();
    generationRef.current += 1;
    setState(IDLE_STATE);
  }, []);

  return { state, run, reset };
}
