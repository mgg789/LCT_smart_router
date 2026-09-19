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
  /**
   * Which interface the key replaces (context/41 section 5): `client`, `eng`, `client_eng`
   * for both app contours with one key, `master` for everything including the dispatcher
   * contour and system/debug functions.
   */
  category: z.enum(['client', 'eng', 'client_eng', 'master']),
  /**
   * Unix-epoch seconds after which the key stops authorising new calls; omitted or null
   * means the key never expires (context/41 section 4.2, 2026-09-19 amendment). Not in
   * the past: a key born dead has no owner who asked for it.
   */
  expiresAt: z.number().int().positive().nullable().optional(),
});
export type CreateApiTokenDto = z.infer<typeof createApiTokenSchema>;
