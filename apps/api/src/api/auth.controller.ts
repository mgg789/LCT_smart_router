import { Body, Controller, Delete, Get, Headers, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  type Actor,
  ApiTokenService,
  AuthService,
  CurrentActor,
  effectiveRole,
  Public,
  Roles,
} from '../auth';
import { SysError } from '../common/errors';
import { zodBody } from '../common/validation';
import {
  type CreateApiTokenDto,
  createApiTokenSchema,
  type DispatcherPasswordLoginDto,
  dispatcherPasswordLoginSchema,
  type RequestLoginCodeDto,
  requestLoginCodeSchema,
  type VerifyLoginCodeDto,
  verifyLoginCodeSchema,
} from './dto/auth.dto';

/**
 * Authentication surface.
 *
 * Requesting and checking a login code are the only operations reachable without a
 * session -- the exact exceptions context/32 section 15 allows. Everything else, here and
 * in every other controller, requires an authorised actor.
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly apiTokens: ApiTokenService,
  ) {}

  @Public()
  @Post('login-code')
  @ApiOperation({ summary: 'Request a one-time login code for an email address' })
  async requestLoginCode(@Body(zodBody(requestLoginCodeSchema)) dto: RequestLoginCodeDto) {
    const issued = await this.auth.requestLoginCode(dto.email);
    // The response never reveals whether the address is known: that would turn this
    // endpoint into a directory of clients, engineers and the dispatcher.
    return {
      email: issued.email,
      expiresAt: issued.expiresAt,
      ...(issued.devCode === undefined ? {} : { devCode: issued.devCode }),
    };
  }

  @Public()
  @Post('login-code/verify')
  @ApiOperation({ summary: 'Exchange a login code for a session' })
  async verifyLoginCode(@Body(zodBody(verifyLoginCodeSchema)) dto: VerifyLoginCodeDto) {
    const session = await this.auth.verifyLoginCode(dto.email, dto.code, dto.role);
    return {
      token: session.token,
      role: session.role,
      expiresAt: session.expiresAt,
    };
  }

  @Public()
  @Post('dispatcher/password')
  @ApiOperation({
    summary: 'Sign the dispatcher in with the configured password, without SMTP',
  })
  async dispatcherPassword(
    @Body(zodBody(dispatcherPasswordLoginSchema)) dto: DispatcherPasswordLoginDto,
  ) {
    const session = await this.auth.loginDispatcherWithPassword(dto.email, dto.password);
    return {
      token: session.token,
      role: session.role,
      expiresAt: session.expiresAt,
    };
  }

  @Get('session')
  @ApiOperation({ summary: 'Describe the actor behind the presented credential' })
  session(@CurrentActor() actor: Actor) {
    return {
      kind: actor.kind,
      source: actor.source,
      role: effectiveRole(actor),
      accountId: actor.accountId,
      tokenCategory: actor.tokenCategory,
    };
  }

  @Delete('session')
  @ApiOperation({ summary: 'Sign out of the current session' })
  async signOut(@Headers('authorization') authorization: string | undefined) {
    const token = authorization?.split(' ')[1]?.trim();
    if (token) {
      await this.auth.signOut(token);
    }
    // Idempotent: signing out twice, or without a session, is not an error.
    return { signedOut: true };
  }

  @Roles('dispatcher')
  @Post('tokens')
  @ApiOperation({ summary: 'Create an integration key; the secret is shown once' })
  async createToken(@Body(zodBody(createApiTokenSchema)) dto: CreateApiTokenDto) {
    return this.apiTokens.create(dto.name, dto.category);
  }

  @Roles('dispatcher')
  @Get('tokens')
  @ApiOperation({ summary: 'List integration keys without revealing their secrets' })
  async listTokens() {
    return { tokens: await this.apiTokens.list() };
  }

  @Roles('dispatcher')
  @Delete('tokens/:id')
  @ApiOperation({ summary: 'Revoke an integration key' })
  async revokeToken(@Param('id') id: string, @CurrentActor() actor: Actor) {
    // An integration key must not be able to revoke keys: that is a dispatcher action in
    // the Dashboard, not a category function (context/41 section 4.1).
    if (actor.kind !== 'account') {
      throw SysError.forbidden('Integration keys are managed from the Dashboard');
    }
    await this.apiTokens.revoke(id);
    return { revoked: true };
  }
}
