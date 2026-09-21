import type { ActorKind, ActorSource, ApiTokenCategory, Role } from '../generated/prisma/client';

/**
 * Who is performing an operation, as established by the server.
 *
 * Never taken from the request body. A UI session and an integration token differ only
 * in `kind` and `source`; both then go through the same system operation, because a
 * business rule exists in exactly one handler (context/36 section 2).
 */
export interface Actor {
  readonly kind: ActorKind;
  readonly source: ActorSource;
  /** Account id for a session, token id for an integration key. */
  readonly id: string;
  /** Role a session acts as. Null for an integration token, which has a category instead. */
  readonly role: Role | null;
  /**
   * Category of an integration key. Full access inside the category, with no binding to
   * an end user: the key's owner is always the single dispatcher (context/41 section 3).
   */
  readonly tokenCategory: ApiTokenCategory | null;
  /** Account the actor acts as, when there is one. */
  readonly accountId: string | null;
}

/**
 * Roles an endpoint may require.
 *
 * A token category is mapped onto the roles whose UI actions it replaces: `client` and
 * `eng` keys get the corresponding role, `client_eng` gets both, `master` gets the
 * dispatcher's plus both app contours and the system/debug functions that travel with
 * them (context/41 section 5, 2026-09-19 amendment). `client` and `eng` never gain
 * dispatcher functions just because the same person owns the key.
 */
export function effectiveRoles(actor: Actor): Role[] {
  if (actor.role) {
    return [actor.role];
  }
  switch (actor.tokenCategory) {
    case 'client':
      return ['client'];
    case 'eng':
      return ['engineer'];
    case 'client_eng':
      return ['client', 'engineer'];
    case 'master':
      return ['dispatcher', 'client', 'engineer'];
    default:
      return [];
  }
}

/**
 * The primary role of an actor, kept for the session description and the journal: the
 * first role of the category mapping. Access decisions use [[effectiveRoles]] instead,
 * because a category may legitimately carry more than one role.
 */
export function effectiveRole(actor: Actor): Role | null {
  return effectiveRoles(actor)[0] ?? null;
}

export function describeActor(actor: Actor): string {
  return `${actor.kind}:${actor.id}:${effectiveRole(actor) ?? 'unknown'}`;
}
