import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '../common/config';
import { SysError } from '../common/errors';
import { Clock } from '../common/time';
import type { Role } from '../generated/prisma/client';
import { NotificationsService } from '../notifications';
import { SmtpGatewayService } from '../notifications/smtp-gateway.service';
import { PrismaService, UnitOfWork } from '../persistence';
import type { Actor } from './actor';
import { ApiTokenService } from './api-token.service';
import { type IssuedLoginCode, LoginCodeService } from './login-code.service';
import { derivePasswordHash, newSalt, normalizeEmail, secretsMatch } from './secrets';
import { type IssuedSession, SessionService } from './session.service';

/**
 * `auth-engine` of context/36 section 2: accounts, sessions, roles and the two ways the
 * single dispatcher signs in.
 *
 * The rule that shapes everything here: a role is granted, never claimed. Typing an
 * address on the engineer screen does not create an engineer, and a matching address does
 * not raise an account's role (context/36 section 7.3).
 */
@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);
  private readonly passwordSalt = newSalt();
  private dispatcherPasswordHash: Buffer | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly config: AppConfigService,
    private readonly loginCodes: LoginCodeService,
    private readonly sessions: SessionService,
    private readonly apiTokens: ApiTokenService,
    private readonly notifications: NotificationsService,
    private readonly smtp: SmtpGatewayService,
    private readonly uow: UnitOfWork,
  ) {}

  async onModuleInit(): Promise<void> {
    // The configured password is turned into a verifier once, at start-up, and the plain
    // value is not kept. It is never returned by the API, written to a log or put into an
    // AI context (context/36 section 7.1).
    this.dispatcherPasswordHash = derivePasswordHash(
      this.config.get('DISPATCHER_PASSWORD'),
      this.passwordSalt,
    );
    const email = normalizeEmail(this.config.get('DISPATCHER_EMAIL'));
    await this.ensureAccount(email, 'dispatcher');
    this.logger.log(`Dispatcher account ready for ${email}`);
  }

  /** Step one of the email path. Issuing a code says nothing about who may sign in. */
  async requestLoginCode(email: string): Promise<IssuedLoginCode> {
    const issued = await this.uow.run(async (tx) => {
      const created = await this.loginCodes.issueIn(tx, email);
      await this.notifications.record(tx, created.issuedAt, {
        category: 'account_login_code',
        businessEventKey: `account_login_code:${created.email}:${created.issuedAt}`,
        recipientEmail: created.email,
        payload: { code: created.code, expiresAt: created.expiresAt },
      });
      return created;
    });
    // Transport stays outside the transaction: a mail failure must not undo the code.
    void this.smtp.submitPending();
    return this.loginCodes.toPublic(issued);
  }

  /**
   * Step two of the email path.
   *
   * A client account is created on first successful verification. An engineer must
   * already have been created by the dispatcher; verifying an address does not produce
   * that role (context/36 section 7.2).
   */
  async verifyLoginCode(email: string, code: string, requestedRole: Role): Promise<IssuedSession> {
    const verified = await this.loginCodes.verify(email, code);

    if (requestedRole === 'client') {
      const account = await this.ensureAccount(verified.email, 'client');
      return this.sessions.create(account.id, 'client');
    }

    const account = await this.prisma.account.findUnique({
      where: { email: verified.email },
      include: { roles: true },
    });
    const hasRole = account?.roles.some((entry) => entry.role === requestedRole) ?? false;
    if (!account || !hasRole) {
      // Deliberately indistinguishable from a wrong code: telling the caller that the
      // address exists but lacks the role would leak the staff list.
      throw new SysError('UNAUTHENTICATED', 'The code is invalid or has expired');
    }
    return this.sessions.create(account.id, requestedRole);
  }

  /**
   * The dispatcher's fallback path.
   *
   * It exists so that access to the Dashboard does not depend on the mail contour working
   * (context/36 section 7.1). Both paths open the same single account and role -- not two
   * accounts with different data.
   */
  async loginDispatcherWithPassword(email: string, password: string): Promise<IssuedSession> {
    const configuredEmail = normalizeEmail(this.config.get('DISPATCHER_EMAIL'));
    const submittedEmail = normalizeEmail(email);
    const expected = this.dispatcherPasswordHash;

    // The password is always hashed, even when the address is wrong, so the two failures
    // take the same time and the response cannot be used to discover the address.
    const submitted = derivePasswordHash(password, this.passwordSalt);
    const passwordOk = expected !== null && secretsMatch(submitted, expected);

    if (submittedEmail !== configuredEmail || !passwordOk) {
      throw new SysError('UNAUTHENTICATED', 'Invalid dispatcher credentials');
    }

    const account = await this.ensureAccount(configuredEmail, 'dispatcher');
    return this.sessions.create(account.id, 'dispatcher');
  }

  /** Resolves a bearer value that may be either a session token or an integration key. */
  async resolveBearer(token: string): Promise<Actor | null> {
    return (await this.sessions.resolve(token)) ?? (await this.apiTokens.resolve(token));
  }

  async signOut(token: string): Promise<void> {
    await this.sessions.revoke(token);
  }

  /** Creates the account if needed and grants the role if it is not granted yet. */
  private async ensureAccount(email: string, role: Role): Promise<{ id: string }> {
    const now = BigInt(this.clock.nowSeconds());
    const account = await this.prisma.account.upsert({
      where: { email },
      update: {},
      create: { email, createdAt: now, updatedAt: now },
    });
    await this.prisma.accountRole.upsert({
      where: { accountId_role: { accountId: account.id, role } },
      update: {},
      create: { accountId: account.id, role, grantedAt: now },
    });
    return { id: account.id };
  }
}
