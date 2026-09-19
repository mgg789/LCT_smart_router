import { getRouterSettings, type RouterSettingsView } from '@/entities/router-settings';
import { authorizedRequest } from '@/entities/session';
import { newOperationId } from '@/shared/lib';

/**
 * Flips `lunchesEnabled` in the Router's technical revision.
 *
 * The PUT replaces the whole revision, so the current one is read first and sent
 * back with a single field changed. Nothing is enumerated by hand: settings this
 * client has never heard of survive the write untouched, and the CAS version goes
 * back as `expectedContextVersion`.
 */
export async function setLunchesEnabled(enabled: boolean): Promise<RouterSettingsView> {
  const current = await getRouterSettings();
  const { routerContextVersion, ...revision } = current;

  return authorizedRequest<RouterSettingsView>('/dispatch/router/technical-settings', {
    method: 'PUT',
    body: {
      ...revision,
      operationId: newOperationId(),
      expectedContextVersion: routerContextVersion,
      lunchesEnabled: enabled,
    },
  });
}
