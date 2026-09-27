import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { RouterClient } from '../../routing/router-gateway';
import type { LiveService } from '../live/live.service';
import type { personalPolicyPresetSchema } from './personal-policy';

/** One-time explicit selection pre-step, outside SQL. Existing Router CAS preserves unrelated settings. */
export async function applyPersonalPolicyRouterPreset(
  router: RouterClient,
  live: LiveService,
  preset: z.infer<typeof personalPolicyPresetSchema>,
): Promise<void> {
  const current = await router.getTechnicalSettings();
  const { ordinaryReplanningDisabled: _ordinary, ...switches } = preset;
  const changed = Object.entries(switches).some(
    ([key, value]) => current[key as keyof typeof switches] !== value,
  );
  if (!changed) return;
  const { routerContextVersion, ...settings } = current;
  await router.updateTechnicalSettings({
    ...settings,
    ...switches,
    operationId: randomUUID(),
    expectedContextVersion: routerContextVersion,
  });
  await live.synchronizeGlobalLunchSwitch(preset.lunchesEnabled);
}
