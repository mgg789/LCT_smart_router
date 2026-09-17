import { type CustomDecorator, SetMetadata } from '@nestjs/common';

export const PUBLIC_ROUTE = 'auth:public';

/**
 * Marks the few endpoints that may be reached without a session.
 *
 * The exceptions are exactly the ones context/32 section 15 allows: requesting and
 * checking a login code, plus health. Everything else requires an authorised actor, and
 * the guard denies by default so a forgotten decorator fails closed.
 */
export const Public = (): CustomDecorator => SetMetadata(PUBLIC_ROUTE, true);
