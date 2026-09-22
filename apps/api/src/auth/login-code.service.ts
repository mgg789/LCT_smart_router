import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../common/config';
import { SysError } from '../common/errors';
import { Clock } from '../common/time';
import { PrismaService, type Tx } from '../persistence';
import { generateLoginCode, hashLoginCode, normalizeEmail } from './secrets';

export interface IssuedLoginCodeInternal {
  readonly email: string;
  readonly expiresAt: number;
  readonly issuedAt: number;
  readonly code: string;
}

export interface IssuedLoginCode {
  readonly email: string;
  readonly expiresAt: number;
  /**
   * Present only in local development (`AUTH_DEV_EXPOSE_CODES` and not `DEMO_STAND`).
   * Production refuses the flag. The SMTP-gateway delivers the same code by mail.
   */
  readonly devCode?: string;
}

/**
 * Issues and verifies the one-time email codes.
 *
 * The code itself is never stored, only a hash bound to the address it was issued for, so
 * a database dump cannot be replayed as a login and a code seen for one address cannot be
 * used against another.
 */
@Injectable()
export class LoginCodeService {
  private readonly logger = new Logger(LoginCodeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly config: AppConfigService,
  ) {}

  async issue(rawEmail: string): Promise<IssuedLoginCode> {
    const issued = await this.issueIn(this.prisma, rawEmail);
    return this.toPublic(issued);
  }

  /**
   * Issues a code inside the caller's transaction so the mail intent can be stored
   * with the hash in one commit. The plaintext code is returned only to that caller.
   */
  async issueIn(tx: Pick<Tx, 'loginCode'>, rawEmail: string): Promise<IssuedLoginCodeInternal> {
    const email = normalizeEmail(rawEmail);
    const now = this.clock.nowSeconds();
    const expiresAt = now + this.config.get('LOGIN_CODE_TTL_SEC');
    const code = generateLoginCode();

    // Any code still outstanding for this address is retired first, so a request for a
    // new code cannot leave two valid ones in circulation.
    await tx.loginCode.updateMany({
      where: { email, consumedAt: null },
      data: { consumedAt: BigInt(now) },
    });

    await tx.loginCode.create({
      data: {
        email,
        codeHash: hashLoginCode(email, code),
        issuedAt: BigInt(now),
        expiresAt: BigInt(expiresAt),
      },
    });

    // The code is never written to the log: logs are the one place it would survive.
    this.logger.log(`Login code issued for ${email}`);
    return { email, expiresAt, issuedAt: now, code };
  }

  toPublic(issued: IssuedLoginCodeInternal): IssuedLoginCode {
    // Public demo stand keeps code login, but never prints the code: the dispatcher
    // mailbox is synthetic and engineers receive a real SMTP message.
    const exposeCodes =
      this.config.get('AUTH_DEV_EXPOSE_CODES') &&
      this.config.get('NODE_ENV') !== 'production' &&
      !this.config.get('DEMO_STAND');
    return exposeCodes
      ? { email: issued.email, expiresAt: issued.expiresAt, devCode: issued.code }
      : { email: issued.email, expiresAt: issued.expiresAt };
  }

  /**
   * Consumes a code.
   *
   * A wrong code counts an attempt against that specific code rather than against the
   * address, so a third party cannot lock someone out by guessing at their address.
   * Expiry, exhaustion and a wrong value are all reported the same way: distinguishing
   * them would tell an attacker which addresses have codes outstanding.
   */
  async verify(rawEmail: string, code: string): Promise<{ email: string }> {
    const email = normalizeEmail(rawEmail);
    const now = this.clock.nowSeconds();
    const maxAttempts = this.config.get('LOGIN_CODE_MAX_ATTEMPTS');

    const candidate = await this.prisma.loginCode.findFirst({
      where: { email, consumedAt: null },
      orderBy: { issuedAt: 'desc' },
    });

    const invalid = (): never => {
      throw new SysError('UNAUTHENTICATED', 'The code is invalid or has expired');
    };

    if (!candidate || candidate.expiresAt < BigInt(now) || candidate.attempts >= maxAttempts) {
      return invalid();
    }

    if (candidate.codeHash !== hashLoginCode(email, code)) {
      await this.prisma.loginCode.update({
        where: { id: candidate.id },
        data: { attempts: { increment: 1 } },
      });
      return invalid();
    }

    // Marking it consumed in the same step is what makes the code single-use: a replay
    // of the same value finds nothing outstanding.
    const consumed = await this.prisma.loginCode.updateMany({
      where: { id: candidate.id, consumedAt: null },
      data: { consumedAt: BigInt(now) },
    });
    if (consumed.count === 0) {
      return invalid();
    }

    return { email };
  }
}
