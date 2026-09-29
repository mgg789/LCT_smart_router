import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { PrismaClient } from '../../generated/prisma/client';
import { APP_STATE_KEYS } from '../../persistence/app-state.keys';
import type { RouterClient, RouterTechnicalSettings } from '../../routing/router-gateway';
import type { LiveService } from '../live/live.service';
import type { personalPolicyPresetSchema } from './personal-policy';

const PRESET_SWITCHES = [
  'lunchesEnabled',
  'trafficEnabled',
  'metroEnabled',
  'equipmentTransfersEnabled',
  'strictTimeWindows',
] as const satisfies ReadonlyArray<keyof RouterTechnicalSettings>;

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

/**
 * Applies or restores the personal-policy router switches after the SQL operation
 * has committed. A failed select therefore leaves the router untouched, and a
 * replay does not put the switches back over later edits.
 */
export async function commitPolicyRouterPreset(input: {
  prisma: PrismaClient;
  router: RouterClient;
  live: LiveService;
  policyId: string;
  preset: z.infer<typeof personalPolicyPresetSchema> | null;
}): Promise<void> {
  if (input.policyId === 'personal') {
    if (!input.preset) return;
    const existing = await input.prisma.appState.findUnique({
      where: { key: APP_STATE_KEYS.POLICY_PERSONAL_ROUTER_BACKUP },
    });
    if (!existing) {
      const current = await input.router.getTechnicalSettings();
      const backup: Record<string, boolean> = {};
      for (const key of PRESET_SWITCHES) {
        const value = current[key];
        if (typeof value === 'boolean') backup[key] = value;
      }
      await input.prisma.appState.create({
        data: {
          key: APP_STATE_KEYS.POLICY_PERSONAL_ROUTER_BACKUP,
          value: backup,
          updatedAt: BigInt(Math.floor(Date.now() / 1000)),
        },
      });
    }
    await applyPersonalPolicyRouterPreset(input.router, input.live, input.preset);
    return;
  }
  const backup = await input.prisma.appState.findUnique({
    where: { key: APP_STATE_KEYS.POLICY_PERSONAL_ROUTER_BACKUP },
  });
  if (
    !backup ||
    backup.value === null ||
    typeof backup.value !== 'object' ||
    Array.isArray(backup.value)
  ) {
    return;
  }
  const stored = backup.value as Record<string, unknown>;
  const current = await input.router.getTechnicalSettings();
  const { routerContextVersion, ...settings } = current;
  const restored: Partial<Record<(typeof PRESET_SWITCHES)[number], boolean>> = {};
  for (const key of PRESET_SWITCHES) {
    const value = stored[key];
    if (typeof value === 'boolean') restored[key] = value;
  }
  await input.router.updateTechnicalSettings({
    ...settings,
    ...restored,
    operationId: randomUUID(),
    expectedContextVersion: routerContextVersion,
  });
  if (typeof stored.lunchesEnabled === 'boolean') {
    await input.live.synchronizeGlobalLunchSwitch(stored.lunchesEnabled);
  }
  await input.prisma.appState.delete({
    where: { key: APP_STATE_KEYS.POLICY_PERSONAL_ROUTER_BACKUP },
  });
}
