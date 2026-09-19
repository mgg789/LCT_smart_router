/** Roles the System Layer issues tokens for (docs/frontend-api.md §1). */
export type SessionRole = 'client' | 'engineer' | 'dispatcher';

export interface Session {
  /** Bearer token sent as `Authorization: Bearer <token>`. */
  token: string;
  role: SessionRole;
  /** Unix seconds; the token is worthless past this moment. */
  expiresAt: number;
  /**
   * Address this session signed in with. The API exposes no profile for the
   * dispatcher, so this is the only name the UI honestly has for them.
   */
  email: string;
}
