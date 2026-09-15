import { z } from 'zod';

export const selectPolicySchema = z.object({
  operationId: z.uuid(),
  /**
   * One of the prepared policies. Free-form parameters are not accepted: a policy is a
   * catalogue entry, not executable input (context/33 section 5).
   */
  policyId: z.string().min(1).max(64),
});
export type SelectPolicyDto = z.infer<typeof selectPolicySchema>;
