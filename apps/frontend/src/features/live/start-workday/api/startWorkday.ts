import type { DispatchLiveView } from '@/entities/live';
import { authorizedRequest } from '@/entities/session';
import { newOperationId } from '@/shared/lib';

/** Starts the prepared LIVE day once; the server returns its authoritative state. */
export function startWorkday(): Promise<DispatchLiveView> {
  return authorizedRequest<DispatchLiveView>('/dispatch/live/start', {
    method: 'POST',
    body: { operationId: newOperationId() },
  });
}
