import { useQuery } from '@tanstack/react-query';
import type { ApiError } from '@/shared/api';
import { getRouterSettings } from '../api/getRouterSettings';
import type { RouterSettingsView } from './types';

export const routerSettingsQueryKey = ['dispatch', 'router', 'technical-settings'] as const;

/** Changes only when a dispatcher edits it, so it is read on demand, not polled. */
export function useRouterSettings() {
  return useQuery<RouterSettingsView, ApiError>({
    queryKey: routerSettingsQueryKey,
    queryFn: getRouterSettings,
    staleTime: 60_000,
  });
}
