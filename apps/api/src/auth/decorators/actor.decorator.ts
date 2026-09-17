import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { SysError } from '../../common/errors';
import type { Actor } from '../actor';

/**
 * Injects the actor the guard established.
 *
 * Throwing when it is absent is intentional: a handler that asks for an actor must never
 * silently receive `undefined` and continue as if anonymous.
 */
export const CurrentActor = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const request = context.switchToHttp().getRequest<Request & { actor?: Actor }>();
  if (!request.actor) {
    throw new SysError('UNAUTHENTICATED', 'Authentication is required');
  }
  return request.actor;
});
