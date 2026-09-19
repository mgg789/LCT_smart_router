import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { PUBLIC_ROUTE, REQUIRED_ROLES } from '../../common/access';
import { SysError } from '../../common/errors';
import type { Role } from '../../generated/prisma/client';
import { type Actor, effectiveRoles } from '../actor';
import { AuthService } from '../auth.service';

/**
 * Establishes who is calling and whether the endpoint allows them.
 *
 * Applied globally and denying by default: a new endpoint without a decorator is closed,
 * not open. A UI session and an integration key are resolved by the same guard and differ
 * only in the actor they produce, so neither gets a separate way into the system
 * (context/41 section 11).
 */
@Injectable()
export class ActorGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const handler = context.getHandler();
    const controller = context.getClass();
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [handler, controller]);

    const request = context.switchToHttp().getRequest<Request & { actor?: Actor }>();
    const token = bearerToken(request);

    if (token) {
      const actor = await this.auth.resolveBearer(token);
      if (!actor) {
        // A presented but unusable credential is always rejected, even on a public route:
        // continuing anonymously would hide an expired session from the caller.
        throw new SysError('UNAUTHENTICATED', 'The session or token is no longer valid');
      }
      request.actor = actor;
    }

    if (isPublic) {
      return true;
    }

    const actor = request.actor;
    if (!actor) {
      throw new SysError('UNAUTHENTICATED', 'Authentication is required');
    }

    const required = this.reflector.getAllAndOverride<Role[]>(REQUIRED_ROLES, [
      handler,
      controller,
    ]);
    if (!required || required.length === 0) {
      return true;
    }

    // An actor may carry several roles (a `client_eng` or `master` key): the endpoint
    // admits the actor when any of them satisfies the requirement.
    const roles = effectiveRoles(actor);
    if (!roles.some((role) => required.includes(role))) {
      throw SysError.forbidden('This action does not belong to your role', {
        requiredRoles: required,
        actorRoles: roles,
      });
    }
    return true;
  }
}

function bearerToken(request: Request): string | null {
  const header = request.header('authorization');
  if (!header) {
    return null;
  }
  const [scheme, value] = header.split(' ');
  // The key travels in a header, never in the URL, where it would land in access logs
  // and browser history (context/41 section 12).
  if (scheme?.toLowerCase() !== 'bearer' || !value) {
    return null;
  }
  return value.trim();
}
