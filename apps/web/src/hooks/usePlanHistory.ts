import { useEffect, useState } from 'react';
import { loadPlanHistory } from '../api/client';
import type { PlanHistoryResponse } from '../api/types';

/** Load durable history once per visible revision; late reads cannot cross sessions. */
export function usePlanHistory(token: string | null, revision: number | null, enabled: boolean) {
  const [history, setHistory] = useState<PlanHistoryResponse | null>(null);
  useEffect(() => {
    let active = true;
    setHistory(null);
    if (token && revision !== null && enabled) {
      void loadPlanHistory(token)
        .then((value) => {
          if (active && value.current?.revision === revision) setHistory(value);
        })
        .catch(() => {
          // Core reads report connection/auth errors. Missing history never enables undo.
          if (active) setHistory(null);
        });
    }
    return () => {
      active = false;
    };
  }, [token, revision, enabled]);
  return history?.current?.revision === revision ? history : null;
}
