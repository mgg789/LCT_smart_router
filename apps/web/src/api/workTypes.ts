import type { WorkTypeView } from '@lct/shared';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { t } from '../i18n';
import { requestJson } from './client';

const catalogueSchema = z.object({
  workTypes: z.array(
    z.object({
      code: z.string(),
      title: z.string(),
      category: z.enum(['emergency', 'connection', 'service']),
      categoryTitle: z.string(),
      serviceDurationSec: z.number().int().positive(),
      requiredSkill: z.enum(['local', 'connection', 'emergency']),
    }),
  ),
});
let cached: { at: number; rows: WorkTypeView[] } | null = null;

/** Cache only public catalogue metadata; unavailable metadata never enables guessed writes. */
export function useWorkTypes() {
  const [rows, setRows] = useState<WorkTypeView[]>(cached?.rows ?? []);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    if (cached && Date.now() - cached.at < 60_000 && attempt === 0) return;
    setError(null);
    void requestJson('/api/v1/client/work-types', catalogueSchema)
      .then(({ workTypes }) => {
        cached = { at: Date.now(), rows: workTypes };
        if (active) setRows(workTypes);
      })
      .catch((cause: unknown) => {
        if (active)
          setError(cause instanceof Error ? cause.message : t('api.workTypes.47b03cd3a0'));
      });
    return () => {
      active = false;
    };
  }, [attempt]);
  return { rows, error, retry: () => setAttempt((value) => value + 1) };
}
