import { useEffect, useMemo } from 'react';
import type { ExplainTarget } from '../api/ai';
import { useExplainRun } from '../hooks/useExplainRun';

/**
 * Loads the optional AI wording for facts already rendered by a dashboard panel.
 *
 * The hook never changes the underlying decision: callers keep rendering their
 * deterministic explanation until the optional wording has arrived.
 */
export function useAiExplanation({
  enabled,
  token,
  target,
}: {
  enabled: boolean;
  token: string | null;
  target: ExplainTarget;
}): { text: string | null; ready: boolean } {
  const { state, run, reset } = useExplainRun(token);
  const packed = useMemo(() => JSON.stringify(target), [target]);

  useEffect(() => {
    if (!enabled || !token) {
      return;
    }
    run(JSON.parse(packed) as ExplainTarget);
    return reset;
  }, [enabled, packed, token, run, reset]);

  return {
    text: state.error || state.unavailable ? null : state.text.trim() || null,
    ready: state.done || state.error !== null || state.unavailable !== null,
  };
}
