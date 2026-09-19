import { authorizedRequest } from '@/entities/session';
import type { EngineersView } from '../model/types';

/** `GET /dispatch/engineers` — crews with their current working day. */
export function getEngineers(): Promise<EngineersView> {
  return authorizedRequest<EngineersView>('/dispatch/engineers');
}
