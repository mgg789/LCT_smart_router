import { useEffect, useMemo, useState } from 'react';
import { explainWithAi } from '../api/client';

type AiExplanationKind = 'reasons' | 'plan';

/**
 * Loads the optional AI wording for facts already rendered by a dashboard panel.
 *
 * The hook never changes the underlying decision: callers keep rendering their
 * deterministic explanation until the optional wording has arrived.
 */
export function useAiExplanation({
  enabled,
  token,
  kind,
  context,
}: {
  enabled: boolean;
  token: string | null;
  kind: AiExplanationKind;
  context: unknown;
}): { text: string | null; ready: boolean } {
  const [text, setText] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const packed = useMemo(() => JSON.stringify(context) ?? 'null', [context]);

  useEffect(() => {
    if (!enabled || !token) {
      setText(null);
      setReady(false);
      return;
    }
    let cancelled = false;
    setReady(false);
    void explainWithAi(token, kind, JSON.parse(packed) as unknown)
      .then((result) => {
        if (!cancelled) setText(result.text);
      })
      .catch(() => {
        if (!cancelled) setText(null);
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, kind, packed, token]);

  return { text, ready };
}
