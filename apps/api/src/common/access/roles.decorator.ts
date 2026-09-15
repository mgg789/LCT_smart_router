import { type CustomDecorator, SetMetadata } from '@nestjs/common';
import type { Role } from '../../generated/prisma/client';

export const REQUIRED_ROLES = 'auth:roles';

/** Restricts an endpoint to the listed roles. An integration key maps to the role whose
 * UI actions its category replaces (context/41 section 5). */
export const Roles = (...roles: Role[]): CustomDecorator => SetMetadata(REQUIRED_ROLES, roles);
