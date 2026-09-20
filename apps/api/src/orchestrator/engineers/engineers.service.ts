import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../common/config';
import { SysError } from '../../common/errors';
import type {
  Account,
  Availability,
  Engineer,
  EngineerDay,
  Skill,
  TransportType,
} from '../../generated/prisma/client';
import { NotificationsService } from '../../notifications';
import { assertWriteApplied, type OperationContext } from '../../operations';
import type { Tx } from '../../persistence';
import { PUBLICATION_TRIGGERS, SnapshotPublisher } from '../../routing/mount-data-eng';
import { assertLunchConditions, type LunchConditions, workDateOf } from './workday';

export interface CreateEngineerInput {
  readonly email?: string | null;
  readonly displayName: string;
  readonly skills: Skill[];
  readonly transportType: TransportType;
  readonly region?: string | null;
  readonly homeLat?: number | null;
  readonly homeLon?: number | null;
}

export interface UpdateEngineerInput {
  readonly displayName?: string;
  readonly skills?: Skill[];
  readonly transportType?: TransportType;
  readonly region?: string | null;
  readonly homeLat?: number | null;
  readonly homeLon?: number | null;
}

export interface WorkdayInput {
  readonly workDate: string;
  readonly shiftStartAt: number;
  readonly shiftEndAt: number;
  readonly lunch?: LunchConditions;
  readonly lunchRequired?: boolean;
  readonly attendanceOptOut?: boolean;
}

/**
 * A routing profile together with its login, when one has been linked to it. A profile
 * that arrived with an import has `account: null` until the dispatcher links an address
 * (context/37 section 3.1).
 */
export type EngineerWithAccount = Engineer & { account: Account | null };

/** Technical stop. The initial duration is 15 minutes (context/32 section 5.2). */
export const TECHNICAL_BREAK_SEC = 15 * 60;

/**
 * Engineers and their working days.
 *
 * Two levels on purpose: the profile holds what is stable about a person, and
 * `EngineerDay` holds the shift, the availability and the lunch facts of one day, so that
 * "already had lunch" can never become a permanent property of the person
 * (context/37 section 3.2).
 */
@Injectable()
export class EngineersService {
  constructor(
    private readonly config: AppConfigService,
    private readonly publisher: SnapshotPublisher,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * The dispatcher adds an engineer profile and may grant its login address immediately.
   *
   * Creating the access and having an engineer Router can plan for are two different
   * results. Skills, transport, shift and start point must come from the profile, an
   * import or an explicit entry; missing values are never filled with invented norms
   * (context/42 DF-03).
   */
  async create(
    context: OperationContext,
    input: CreateEngineerInput,
  ): Promise<EngineerWithAccount> {
    const now = BigInt(context.now);
    const email = input.email?.trim().toLowerCase() || null;
    let account: Account | null = null;
    if (email !== null) {
      account = await context.tx.account.upsert({
        where: { email },
        update: {},
        create: { email, createdAt: now, updatedAt: now },
      });
      // The role is granted here, by the dispatcher. Typing this address on the engineer
      // sign-in screen would never have produced it (context/36 section 7.2).
      await context.tx.accountRole.upsert({
        where: { accountId_role: { accountId: account.id, role: 'engineer' } },
        update: {},
        create: { accountId: account.id, role: 'engineer', grantedAt: now },
      });

      const existing = await context.tx.engineer.findUnique({
        where: { accountId: account.id },
        include: { account: true },
      });
      if (existing) {
        return existing;
      }
    }

    assertSkills(input.skills);

    const created = await context.tx.engineer.create({
      data: {
        accountId: account?.id ?? null,
        displayName: input.displayName,
        // Order of appearance, which the baseline iterates in (context/33 section 5).
        inputOrder: await nextInputOrder(context.tx),
        skills: input.skills,
        transportType: input.transportType,
        region: input.region ?? null,
        homeLat: input.homeLat ?? null,
        homeLon: input.homeLon ?? null,
        origin: 'manual',
        createdAt: now,
        updatedAt: now,
      },
    });

    await this.publisher.publishIfChanged(
      context.tx,
      context.now,
      PUBLICATION_TRIGGERS.ENGINEER_CREATED,
    );
    return context.tx.engineer.findUniqueOrThrow({
      where: { id: created.id },
      include: { account: true },
    });
  }

  /**
   * Removes an engineer from future routing without deleting historical plans or facts.
   *
   * An engineer currently on the LIVE line must first be taken offline. Any linked login
   * is revoked so an archived profile cannot keep using the Engineer App.
   */
  async archive(
    context: OperationContext,
    engineerId: string,
    expectedVersion: number | null | undefined,
  ): Promise<EngineerWithAccount> {
    const current = await context.tx.engineer.findUnique({
      where: { id: engineerId },
      include: { account: true },
    });
    if (!current) {
      throw SysError.notFound('Engineer', { engineerId });
    }
    if (current.archivedAt !== null) {
      return current;
    }

    const activeLine = await context.tx.liveEngineerState.findFirst({
      where: {
        engineerId,
        workday: { status: 'running' },
        lineStatus: { in: ['online', 'technical_break'] },
      },
      select: { id: true, lineStatus: true },
    });
    const activeWork = await context.tx.requestFact.findFirst({
      where: { engineerId, request: { lifecycle: 'in_progress' } },
      select: { requestId: true },
    });
    if (activeLine || activeWork) {
      throw new SysError(
        'VALIDATION_FAILED',
        'Take the engineer offline and finish active work before deleting the profile',
        {
          details: {
            engineerId,
            lineStatus: activeLine?.lineStatus ?? null,
            requestId: activeWork?.requestId ?? null,
          },
        },
      );
    }

    const now = BigInt(context.now);
    if (current.accountId !== null) {
      await context.tx.session.updateMany({
        where: { accountId: current.accountId, role: 'engineer', revokedAt: null },
        data: { revokedAt: now },
      });
      await context.tx.accountRole.deleteMany({
        where: { accountId: current.accountId, role: 'engineer' },
      });
    }
    const updated = await context.tx.engineer.updateMany({
      where: {
        id: engineerId,
        archivedAt: null,
        version: expectedVersion ?? current.version,
      },
      data: {
        accountId: null,
        archivedAt: now,
        updatedAt: now,
        version: { increment: 1 },
      },
    });
    assertWriteApplied('Engineer', updated.count, expectedVersion, current.version);

    await this.publisher.publishIfChanged(
      context.tx,
      context.now,
      PUBLICATION_TRIGGERS.ENGINEER_ARCHIVED,
    );
    return context.tx.engineer.findUniqueOrThrow({
      where: { id: engineerId },
      include: { account: true },
    });
  }

  /**
   * Gives a routing profile that exists without a login its address.
   *
   * A brigade that arrived with an import is a calculation profile with no account
   * (context/37 section 3.1); this explicit dispatcher act is what lets that person sign
   * in by email code afterwards. The role is granted here and never claimed by typing the
   * address on the sign-in screen (context/36 section 7.2). No planning parameter changes,
   * so there is nothing to republish to Router.
   */
  async linkAccount(
    context: OperationContext,
    engineerId: string,
    email: string,
  ): Promise<EngineerWithAccount> {
    const engineer = await this.load(context.tx, engineerId);
    if (engineer.accountId !== null) {
      throw new SysError('VALIDATION_FAILED', 'This engineer already has a login', {
        details: { engineerId },
      });
    }

    const normalized = email.trim().toLowerCase();
    const now = BigInt(context.now);
    const account = await context.tx.account.upsert({
      where: { email: normalized },
      update: {},
      create: { email: normalized, createdAt: now, updatedAt: now },
    });
    const taken = await context.tx.engineer.findUnique({ where: { accountId: account.id } });
    if (taken && taken.id !== engineerId) {
      throw new SysError(
        'VALIDATION_FAILED',
        'This address is already the login of another engineer',
        { details: { engineerId, linkedEngineerId: taken.id } },
      );
    }
    await context.tx.accountRole.upsert({
      where: { accountId_role: { accountId: account.id, role: 'engineer' } },
      update: {},
      create: { accountId: account.id, role: 'engineer', grantedAt: now },
    });

    // The `accountId: null` guard makes a concurrent second link match nothing instead of
    // pointing two profiles at one login.
    const updated = await context.tx.engineer.updateMany({
      where: { id: engineerId, accountId: null },
      data: { accountId: account.id, updatedAt: now, version: { increment: 1 } },
    });
    assertWriteApplied('Engineer', updated.count, engineer.version, engineer.version);

    return context.tx.engineer.findUniqueOrThrow({
      where: { id: engineerId },
      include: { account: true },
    });
  }

  /**
   * Replaces the login address the dispatcher granted to an engineer profile.
   *
   * The old engineer role and its live sessions are revoked atomically. Planning data
   * does not change, so the Router input is deliberately not republished.
   */
  async changeEmail(
    context: OperationContext,
    engineerId: string,
    expectedVersion: number | null | undefined,
    email: string,
  ): Promise<EngineerWithAccount> {
    const engineer = await this.load(context.tx, engineerId);
    if (engineer.accountId === null) {
      throw new SysError('VALIDATION_FAILED', 'This engineer has no login to replace', {
        details: { engineerId },
      });
    }
    if (expectedVersion !== null && expectedVersion !== undefined && expectedVersion !== engineer.version) {
      assertWriteApplied('Engineer', 0, expectedVersion, engineer.version);
    }

    const normalized = email.trim().toLowerCase();
    const currentAccount = await context.tx.account.findUniqueOrThrow({
      where: { id: engineer.accountId },
    });
    if (currentAccount.email === normalized) {
      return context.tx.engineer.findUniqueOrThrow({
        where: { id: engineerId },
        include: { account: true },
      });
    }

    const now = BigInt(context.now);
    const nextAccount = await context.tx.account.upsert({
      where: { email: normalized },
      update: {},
      create: { email: normalized, createdAt: now, updatedAt: now },
    });
    const taken = await context.tx.engineer.findUnique({
      where: { accountId: nextAccount.id },
    });
    if (taken && taken.id !== engineerId) {
      throw new SysError(
        'VALIDATION_FAILED',
        'This address is already the login of another engineer',
        { details: { engineerId, linkedEngineerId: taken.id } },
      );
    }

    await context.tx.accountRole.upsert({
      where: { accountId_role: { accountId: nextAccount.id, role: 'engineer' } },
      update: {},
      create: { accountId: nextAccount.id, role: 'engineer', grantedAt: now },
    });
    const updated = await context.tx.engineer.updateMany({
      where: {
        id: engineerId,
        accountId: engineer.accountId,
        version: expectedVersion ?? engineer.version,
      },
      data: {
        accountId: nextAccount.id,
        updatedAt: now,
        version: { increment: 1 },
      },
    });
    assertWriteApplied('Engineer', updated.count, expectedVersion, engineer.version);

    await context.tx.session.updateMany({
      where: { accountId: engineer.accountId, role: 'engineer', revokedAt: null },
      data: { revokedAt: now },
    });
    await context.tx.accountRole.deleteMany({
      where: { accountId: engineer.accountId, role: 'engineer' },
    });

    return context.tx.engineer.findUniqueOrThrow({
      where: { id: engineerId },
      include: { account: true },
    });
  }

  /**
   * Removes the login from a brigade without deleting the routing profile.
   *
   * The engineer role and live sessions go with the address, so a code sent to that
   * mailbox can no longer open the Engineer App. Planning parameters stay as they are:
   * this is the inverse of `linkAccount`, not a profile edit.
   */
  async unlinkAccount(context: OperationContext, engineerId: string): Promise<EngineerWithAccount> {
    const engineer = await this.load(context.tx, engineerId);
    if (engineer.accountId === null) {
      throw new SysError('VALIDATION_FAILED', 'This engineer has no login', {
        details: { engineerId },
      });
    }

    const now = BigInt(context.now);
    const accountId = engineer.accountId;
    await context.tx.session.updateMany({
      where: { accountId, role: 'engineer', revokedAt: null },
      data: { revokedAt: now },
    });
    await context.tx.accountRole.deleteMany({
      where: { accountId, role: 'engineer' },
    });
    const updated = await context.tx.engineer.updateMany({
      where: { id: engineerId, accountId },
      data: { accountId: null, updatedAt: now, version: { increment: 1 } },
    });
    assertWriteApplied('Engineer', updated.count, engineer.version, engineer.version);

    return context.tx.engineer.findUniqueOrThrow({
      where: { id: engineerId },
      include: { account: true },
    });
  }

  /**
   * Edits a profile.
   *
   * Both the engineer and the dispatcher reach this one handler, so their concurrent
   * edits meet the same version check and neither overwrites the other silently
   * (context/39 DB4). Which of them is allowed to change skills, transport and office is
   * explicitly still open (context/36 section 14.2); the rule is enforced in the
   * controller so it can change without touching this logic.
   */
  async updateProfile(
    context: OperationContext,
    engineerId: string,
    expectedVersion: number | null | undefined,
    input: UpdateEngineerInput,
  ): Promise<EngineerWithAccount> {
    const current = await this.load(context.tx, engineerId);
    if (input.skills) {
      assertSkills(input.skills);
    }

    const updated = await context.tx.engineer.updateMany({
      where: { id: engineerId, version: expectedVersion ?? current.version },
      data: {
        displayName: input.displayName ?? current.displayName,
        skills: input.skills ?? current.skills,
        transportType: input.transportType ?? current.transportType,
        region: input.region === undefined ? current.region : input.region,
        // Changing the usual start point does not prove the engineer physically moved
        // there; it is a planning parameter, not an observation (context/42 DF-06).
        homeLat: input.homeLat === undefined ? current.homeLat : input.homeLat,
        homeLon: input.homeLon === undefined ? current.homeLon : input.homeLon,
        updatedAt: BigInt(context.now),
        version: { increment: 1 },
      },
    });
    assertWriteApplied('Engineer', updated.count, expectedVersion, current.version);

    // Skills, transport and the start point are all parameters of the task.
    await this.publisher.publishIfChanged(
      context.tx,
      context.now,
      PUBLICATION_TRIGGERS.ENGINEER_PROFILE_CHANGED,
    );
    return context.tx.engineer.findUniqueOrThrow({
      where: { id: engineerId },
      include: { account: true },
    });
  }

  /** Sets or replaces the shift and lunch conditions of one working day. */
  async setWorkday(
    context: OperationContext,
    engineerId: string,
    input: WorkdayInput,
  ): Promise<EngineerDay> {
    await this.load(context.tx, engineerId);
    if (input.shiftEndAt <= input.shiftStartAt) {
      throw new SysError('VALIDATION_FAILED', 'A shift must have a positive duration');
    }
    const lunch = input.lunch ?? { enabled: false };
    assertLunchConditions(lunch, input.lunchRequired ?? false);

    const now = BigInt(context.now);
    const lunchData = {
      lunchEnabled: lunch.enabled,
      lunchDurationSec: lunch.enabled ? (lunch.durationSec ?? null) : null,
      lunchWindowStartAt: lunch.enabled ? bigIntOrNull(lunch.windowStartAt) : null,
      lunchWindowEndAt: lunch.enabled ? bigIntOrNull(lunch.windowEndAt) : null,
      lunchRequired: input.lunchRequired ?? false,
      ...(input.attendanceOptOut === undefined ? {} : { attendanceOptOut: input.attendanceOptOut }),
    };

    const day = await context.tx.engineerDay.upsert({
      where: { engineerId_workDate: { engineerId, workDate: input.workDate } },
      update: {
        shiftStartAt: BigInt(input.shiftStartAt),
        shiftEndAt: BigInt(input.shiftEndAt),
        ...lunchData,
        // `lunchTaken` is never touched here: turning the feature off and on again does
        // not give back a lunch that was already used (context/32 section 8).
        updatedAt: now,
        version: { increment: 1 },
      },
      create: {
        engineerId,
        workDate: input.workDate,
        shiftStartAt: BigInt(input.shiftStartAt),
        shiftEndAt: BigInt(input.shiftEndAt),
        ...lunchData,
        createdAt: now,
        updatedAt: now,
      },
    });

    await this.publisher.publishIfChanged(
      context.tx,
      context.now,
      PUBLICATION_TRIGGERS.ENGINEER_WORKDAY_CHANGED,
    );
    return day;
  }

  /**
   * Working availability.
   *
   * `online` means taking part in the work; it does not mean "free right now", and it is
   * not a statement about network connectivity. Going offline does not finish the work in
   * hand and does not reassign it (context/32 section 5.2).
   */
  async setAvailability(
    context: OperationContext,
    engineerId: string,
    availability: Availability,
    expectedOnlineAt: number | null,
  ): Promise<EngineerDay> {
    return this.applyAvailability(context, engineerId, availability, expectedOnlineAt, {
      daySummary: true,
    });
  }

  /**
   * The shared offline/online write.
   *
   * A technical stop is also an offline transition, but it is not the end of the working
   * day, so it closes without the day-summary letter; only a direct switch off does
   * (card #65, 2026-09-20 decision). The letter is deduplicated per work date, so
   * toggling offline and back on during the day never writes twice.
   */
  private async applyAvailability(
    context: OperationContext,
    engineerId: string,
    availability: Availability,
    expectedOnlineAt: number | null,
    options: { readonly daySummary: boolean },
  ): Promise<EngineerDay> {
    const day = await this.currentDay(context, engineerId);
    const updated = await context.tx.engineerDay.update({
      where: { id: day.id },
      data: {
        availability,
        // A forecast, not a promise: reaching this moment creates no online fact
        // (context/33 section 5).
        expectedOnlineAt: availability === 'offline' ? bigIntOrNull(expectedOnlineAt) : null,
        ...(context.actor.role === 'engineer' ? { lastAttendanceAt: BigInt(context.now) } : {}),
        updatedAt: BigInt(context.now),
        version: { increment: 1 },
      },
    });

    await this.publisher.publishIfChanged(
      context.tx,
      context.now,
      PUBLICATION_TRIGGERS.ENGINEER_AVAILABILITY_CHANGED,
      { businessTime: context.businessTime },
    );

    if (availability === 'offline' && options.daySummary) {
      await this.recordDaySummary(context, engineerId, day.workDate);
    }
    return updated;
  }

  /**
   * Composes the day-summary letter from confirmed execution facts only.
   *
   * Every number is a count of explicit marks the engineer made today; nothing is
   * inferred from schedules or timers (context/42 DF-07). The candidate window reaches
   * back 36 hours so that one calendar day in any configured zone is fully covered
   * without ever reading the whole table.
   */
  private async recordDaySummary(
    context: OperationContext,
    engineerId: string,
    workDate: string,
  ): Promise<void> {
    const engineer = await this.load(context.tx, engineerId);
    if (engineer.accountId === null) {
      // No login means no address and no letter; the day still closed normally.
      return;
    }
    const timeZone = this.config.get('APP_TIME_ZONE');
    const windowStart = context.now - 36 * 60 * 60;
    const facts = await context.tx.requestFact.findMany({
      where: {
        engineerId,
        kind: { in: ['started', 'finished', 'problem'] },
        occurredAt: { gte: BigInt(windowStart), lte: BigInt(context.now) },
      },
      orderBy: [{ occurredAt: 'asc' }, { recordedAt: 'asc' }],
    });

    let startedCount = 0;
    let finishedCount = 0;
    let problemCount = 0;
    let workSec = 0;
    const lastStartByRequest = new Map<string, number>();
    for (const fact of facts) {
      if (workDateOf(Number(fact.occurredAt), timeZone) !== workDate) {
        continue;
      }
      switch (fact.kind) {
        case 'started':
          if (!lastStartByRequest.has(fact.requestId)) {
            startedCount += 1;
          }
          lastStartByRequest.set(fact.requestId, Number(fact.occurredAt));
          break;
        case 'finished': {
          finishedCount += 1;
          const startedAt = lastStartByRequest.get(fact.requestId);
          if (startedAt !== undefined && Number(fact.occurredAt) > startedAt) {
            workSec += Number(fact.occurredAt) - startedAt;
          }
          break;
        }
        case 'problem':
          problemCount += 1;
          break;
        default:
          break;
      }
    }

    await this.notifications.record(context.tx, context.now, {
      category: 'engineer_day_summary',
      businessEventKey: `engineer_day_summary:${engineerId}:${workDate}`,
      recipientAccountId: engineer.accountId,
      payload: {
        engineerId,
        displayName: engineer.displayName,
        workDate,
        startedCount,
        finishedCount,
        problemCount,
        workMinutes: Math.round(workSec / 60),
      },
    });
  }

  /** A technical stop with an expected return, which is not a lunch. */
  async startTechnicalBreak(context: OperationContext, engineerId: string): Promise<EngineerDay> {
    // Offline without the day summary: a stop expects to return the same day.
    return this.applyAvailability(
      context,
      engineerId,
      'offline',
      context.now + TECHNICAL_BREAK_SEC,
      {
        daySummary: false,
      },
    );
  }

  /**
   * The engineer actually starts lunch.
   *
   * This is the only thing that sets `lunchTaken`. Publishing a schedule does not set it,
   * and the flag means the single lunch of the day has been used -- not that it has
   * finished (context/33 section 5).
   */
  async startLunch(context: OperationContext, engineerId: string): Promise<EngineerDay> {
    const day = await this.currentDay(context, engineerId);
    if (day.lunchTaken) {
      throw new SysError('VALIDATION_FAILED', 'The lunch of this day has already been used', {
        details: { engineerId, workDate: day.workDate },
      });
    }
    const started = await context.tx.engineerDay.update({
      where: { id: day.id },
      data: {
        lunchTaken: true,
        lunchStartedAt: BigInt(context.now),
        lastAttendanceAt: BigInt(context.now),
        updatedAt: BigInt(context.now),
        version: { increment: 1 },
      },
    });

    // The fact reaches Router so that no second lunch is ever planned for this day.
    await this.publisher.publishIfChanged(
      context.tx,
      context.now,
      PUBLICATION_TRIGGERS.ENGINEER_LUNCH_TAKEN,
    );
    return started;
  }

  /**
   * Back to work after lunch.
   *
   * Recorded separately from the start, and it does not clear `lunchTaken`: finishing a
   * lunch does not restore the right to a second one.
   */
  async finishLunch(context: OperationContext, engineerId: string): Promise<EngineerDay> {
    const day = await this.currentDay(context, engineerId);
    if (!day.lunchTaken) {
      throw new SysError('VALIDATION_FAILED', 'This engineer has not started lunch today');
    }
    return context.tx.engineerDay.update({
      where: { id: day.id },
      data: {
        lastAttendanceAt: BigInt(context.now),
        updatedAt: BigInt(context.now),
        version: { increment: 1 },
      },
    });
  }

  /**
   * The working day the engineer is currently in.
   *
   * Created on demand from the configured zone when it does not exist yet. The shift
   * bounds are left at the day's edges until the dispatcher sets real ones, and the
   * absence of a real shift is visible rather than papered over with a plausible default.
   */
  async currentDay(context: OperationContext, engineerId: string): Promise<EngineerDay> {
    const workDate = workDateOf(context.now, this.config.get('APP_TIME_ZONE'));
    const existing = await context.tx.engineerDay.findUnique({
      where: { engineerId_workDate: { engineerId, workDate } },
    });
    if (existing) {
      return existing;
    }
    await this.load(context.tx, engineerId);
    const now = BigInt(context.now);
    return context.tx.engineerDay.create({
      data: {
        engineerId,
        workDate,
        shiftStartAt: now,
        shiftEndAt: now,
        createdAt: now,
        updatedAt: now,
      },
    });
  }

  /** Explicit app heartbeat/check-in. Reading a screen never becomes an attendance fact. */
  async recordAttendance(context: OperationContext, engineerId: string): Promise<EngineerDay> {
    const day = await this.currentDay(context, engineerId);
    if (context.now < Number(day.shiftStartAt) || context.now > Number(day.shiftEndAt)) {
      throw new SysError('VALIDATION_FAILED', 'Attendance can only be recorded during the shift');
    }
    return context.tx.engineerDay.update({
      where: { id: day.id },
      data: {
        lastAttendanceAt: BigInt(context.now),
        updatedAt: BigInt(context.now),
        version: { increment: 1 },
      },
    });
  }

  async byAccount(tx: Tx, accountId: string): Promise<EngineerWithAccount> {
    const engineer = await tx.engineer.findUnique({
      where: { accountId },
      include: { account: true },
    });
    if (!engineer) {
      throw SysError.notFound('Engineer profile', { accountId });
    }
    return engineer;
  }

  /**
   * Loads an engineer by explicit id, for a caller that names its object instead of
   * signing in as it (context/41 section 3.2): an integration key has no account, so the
   * request carries the `engineerId` and this is the existence check on it.
   */
  async byId(tx: Tx, engineerId: string): Promise<EngineerWithAccount> {
    const engineer = await tx.engineer.findFirst({
      where: { id: engineerId, archivedAt: null },
      include: { account: true },
    });
    if (!engineer) {
      throw SysError.notFound('Engineer', { engineerId });
    }
    return engineer;
  }

  private async load(tx: Tx, engineerId: string): Promise<Engineer> {
    const engineer = await tx.engineer.findFirst({ where: { id: engineerId, archivedAt: null } });
    if (!engineer) {
      throw SysError.notFound('Engineer', { engineerId });
    }
    return engineer;
  }
}

/** One to three distinct skills, as the contract requires (context/33 section 5). */
function assertSkills(skills: Skill[]): void {
  const distinct = new Set(skills);
  if (distinct.size === 0 || distinct.size > 3 || distinct.size !== skills.length) {
    throw new SysError('VALIDATION_FAILED', 'An engineer has one to three distinct skills', {
      details: { skills },
    });
  }
}

function bigIntOrNull(value: number | null | undefined): bigint | null {
  return value === null || value === undefined ? null : BigInt(value);
}

async function nextInputOrder(tx: Tx): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ value: bigint }>>`
    SELECT nextval('engineer_input_order_seq') AS value
  `;
  const value = rows[0]?.value;
  if (value === undefined) {
    throw new SysError('INTERNAL_ERROR', 'Could not allocate an input order');
  }
  return Number(value);
}
