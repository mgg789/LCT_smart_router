import { authorizedRequest } from '@/entities/session';
import { type AssistedState, assistedStateSchema } from '../model/types';

/** Read current pins and any candidate waiting for a dispatcher decision. */
export async function getAssistedState(): Promise<AssistedState> {
  return assistedStateSchema.parse(await authorizedRequest('/dispatch/assisted'));
}
