import { authorizedRequest } from '@/entities/session';
import type { RouterSettingsView } from '../model/types';

export function getRouterSettings(): Promise<RouterSettingsView> {
  return authorizedRequest<RouterSettingsView>('/dispatch/router/technical-settings');
}
