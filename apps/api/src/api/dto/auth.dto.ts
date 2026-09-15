import { z } from 'zod';

/**
 * Request shapes of the auth endpoints.
 *
 * Types are inferred from the schemas, so the compile-time shape and the runtime check
 * cannot drift apart.
 */

export const requestLoginCodeSchema = z.object({
  email: z.email(),
});
export type RequestLoginCodeDto = z.infer<typeof requestLoginCodeSchema>;

export const verifyLoginCodeSchema = z.object({
  email: z.email(),
  code: z.string().regex(/^\d{6}$/, 'The code is six digits'),
  /**
   * Which contour the caller is signing in to. Asking for a role does not grant it: the
   * engineer role must already have been created by the dispatcher, and only the client
   * role is created on first successful verification (context/36 section 7.2).
   */
  role: z.enum(['client', 'engineer', 'dispatcher']),
});
export type VerifyLoginCodeDto = z.infer<typeof verifyLoginCodeSchema>;

export const dispatcherPasswordLoginSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
});
export type DispatcherPasswordLoginDto = z.infer<typeof dispatcherPasswordLoginSchema>;

export const createApiTokenSchema = z.object({
  /** A label the dispatcher recognises. */
  name: z.string().min(1).max(120),
  /** Exactly the two parameters context/41 section 4.1 allows: a name and a category. */
  category: z.enum(['client', 'eng', 'master']),
});
export type CreateApiTokenDto = z.infer<typeof createApiTokenSchema>;
