/** Roles the System Layer issues tokens for (docs/frontend-api.md §1). */
export type SessionRole = 'client' | 'engineer' | 'dispatcher';

export interface Session {
  /** Bearer token sent as `Authorization: Bearer <token>`. */
  token: string;
  role: SessionRole;
  /** Unix seconds; the token is worthless past this moment. */
  expiresAt: number;
}
