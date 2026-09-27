import { z } from 'zod';
import { requestJson } from './client';

const personalPolicySchema = z.object({
  profile: z
    .object({ title: z.string(), objectiveOrder: z.array(z.string()), version: z.number() })
    .nullable(),
});
export type PersonalPolicyProfile = z.infer<typeof personalPolicySchema>['profile'];
/** Reads the signed-in dispatcher's saved objective order without changing the active policy. */
export function loadPersonalPolicy(token: string) {
  return requestJson('/api/v1/dispatch/policy/personal', personalPolicySchema, token);
}
