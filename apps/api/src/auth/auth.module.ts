import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
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
    { provide: APP_GUARD, useClass: ActorGuard },
  ],
  exports: [AuthService, LoginCodeService, SessionService, ApiTokenService],
})
export class AuthModule {}
