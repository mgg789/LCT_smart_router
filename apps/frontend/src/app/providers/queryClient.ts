import { QueryClient } from '@tanstack/react-query';

/**
 * Server state is read-mostly and polled — the System Layer has no SSE
 * (docs/frontend-api.md §6.5). Refetch-on-focus is off so a stale answer never
 * replaces the plan the dispatcher is looking at outside a deliberate poll tick.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: 1,
        refetchOnWindowFocus: false,
        staleTime: 2_000,
      },
      mutations: { retry: false },
    },
  });
}
