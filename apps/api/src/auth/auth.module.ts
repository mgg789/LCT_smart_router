import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PreAuthRateLimitGuard, RateLimitGuard } from '../common/rate-limit';
import { ApiTokenService } from './api-token.service';
import { AuthService } from './auth.service';
import { ActorGuard } from './guards/actor.guard';
import { LoginCodeService } from './login-code.service';
import { SessionService } from './session.service';

/**
 * `auth-engine` of context/36 section 2.
 *
 * The guard is registered globally rather than per controller so that endpoints are
 * closed by default: forgetting a decorator on a new route denies access instead of
 * publishing it.
 */
@Global()
@Module({
  providers: [
    AuthService,
    LoginCodeService,
    SessionService,
    ApiTokenService,
    // Both ordinary and pre-auth budgets are global so metadata is enforced even when a
    // controller's @UseGuards class is not registered in that controller's module.
    { provide: APP_GUARD, useClass: RateLimitGuard },
    // Credential budgets must run before ActorGuard resolves bearer values.
    { provide: APP_GUARD, useClass: PreAuthRateLimitGuard },
    { provide: APP_GUARD, useClass: ActorGuard },
  ],
  exports: [AuthService, LoginCodeService, SessionService, ApiTokenService],
})
export class AuthModule {}
