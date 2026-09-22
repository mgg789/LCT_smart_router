import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../common/config';
import { SysError } from '../../common/errors';
import { Clock } from '../../common/time';
import type { ConnectionType } from '../../generated/prisma/client';
import type { OperationContext } from '../../operations';
import { PrismaService, type Tx } from '../../persistence';
import { LiveService } from '../live';
import type { PassportWriteDto } from './passport.dto';
import {
  canonicalBuildingAddress,
  canonicalTextAddress,
  isCoordinateAddress,
  isStale,
  moscowMonth,
  moscowMonthBounds,
} from './passport-policy';

const POINTS_PER_UPDATE = 35;
const REVERSE_URL = 'https://eu1.locationiq.com/v1/reverse';

/** JSON-safe building facts; dates use Unix seconds. */
export interface PassportView {
  readonly id: string;
  readonly address: string;
  readonly connectionType: ConnectionType;
  readonly difficulty: number;
  readonly equipment: string;
  readonly accessNotes: string;
  readonly comment: string;
  readonly updatedAt: number;
  readonly stale: boolean;
}

/** Object passports and their bounded engineer reward. Network reverse-geocoding is
 * deliberately resolved before OperationsService opens its database transaction. */
@Injectable()
export class PassportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly clock: Clock,
    private readonly live: LiveService,
  ) {}

  /** Reads shared building facts only for the current or assigned request. */
  async engineerRead(engineerId: string, requestId: string) {
    const current = await this.isLiveCurrent(engineerId, requestId);
    if (!current) await this.assertAssigned(engineerId, requestId);
    const building = await this.resolveBuilding(requestId);
    const passport = building === null ? null : await this.passportFor(building.canonicalAddress);
    const stale = passport?.stale ?? true;
    return {
      passport: passport?.view ?? null,
      canFill: building !== null && current && stale,
      ...(building === null
        ? { unavailableReason: 'ADDRESS_NOT_RESOLVED' }
        : !current
          ? { unavailableReason: 'REQUEST_NOT_CURRENT' }
          : !stale
            ? { unavailableReason: 'PASSPORT_FRESH' }
            : {}),
    };
  }

  /** Reads the passport for an existing dispatcher-visible request. */
  async dispatcherRead(requestId: string) {
    await this.requireRequest(requestId);
    const building = await this.resolveBuilding(requestId);
    const passport = building === null ? null : await this.passportFor(building.canonicalAddress);
    return {
      passport: passport?.view ?? null,
      canFill: false,
      ...(building === null ? { unavailableReason: 'ADDRESS_NOT_RESOLVED' } : {}),
    };
  }

  /** Resolves the address before opening a business transaction; verifies the current visit. */
  async prepareSave(
    engineerId: string,
    requestId: string,
  ): Promise<{ canonicalAddress: string; requestVersion: number }> {
    if (!(await this.isLiveCurrent(engineerId, requestId))) {
      throw SysError.forbidden('Only the current LIVE request may receive a passport', {
        requestId,
      });
    }
    const request = await this.prisma.request.findUniqueOrThrow({
      where: { id: requestId },
      select: { version: true },
    });
    const building = await this.resolveBuilding(requestId);
    if (building === null)
      throw SysError.validationFailed(
        'The building address is unavailable; retry when reverse geocoding returns',
      );
    return { ...building, requestVersion: request.version };
  }

  /** Rechecks the current visit and saves facts plus one reward in the operation transaction. */
  async save(
    context: OperationContext,
    engineerId: string,
    requestId: string,
    input: PassportWriteDto,
    prepared: { canonicalAddress: string; requestVersion: number },
  ) {
    await this.live.assertCurrentRequestIn(context.tx, engineerId, requestId, context.now);
    const request = await context.tx.request.findUniqueOrThrow({
      where: { id: requestId },
      select: { version: true },
    });
    if (request.version !== prepared.requestVersion)
      throw new SysError('VERSION_CONFLICT', 'The request changed while opening its passport');
    const result = await this.writeCurrent(
      context.tx,
      context.now,
      prepared.canonicalAddress,
      engineerId,
      input,
    );
    const monthlyPoints = await this.monthlyPointsIn(context.tx, engineerId, context.now);
    return {
      ...result,
      canFill: false,
      unavailableReason: 'PASSPORT_FRESH',
      pointsAwarded: POINTS_PER_UPDATE,
      monthlyPoints,
    };
  }

  /** Sums the durable ledger for the Moscow month containing the wall-clock timestamp. */
  async monthlyPoints(engineerId: string, now = this.clock.nowSeconds()) {
    return {
      monthlyPoints: await this.monthlyPointsIn(this.prisma, engineerId, now),
      month: moscowMonth(now),
    };
  }

  private async writeCurrent(
    tx: Tx,
    now: number,
    address: string,
    engineerId: string,
    input: PassportWriteDto,
  ) {
    const building = await tx.building.upsert({
      where: { canonicalAddress: address },
      update: { updatedAt: BigInt(now) },
      create: { canonicalAddress: address, createdAt: BigInt(now), updatedAt: BigInt(now) },
    });
    await tx.$queryRaw`SELECT id FROM buildings WHERE id = ${building.id} FOR UPDATE`;
    const existing = await tx.objectPassport.findUnique({ where: { buildingId: building.id } });
    if (existing && !isStale(Number(existing.updatedAt), now)) {
      throw new SysError('VERSION_CONFLICT', 'The object passport is already fresh', {
        details: { updatedAt: Number(existing.updatedAt) },
      });
    }
    const data = {
      connectionType: input.connectionType,
      difficulty: input.difficulty,
      equipment: input.equipment,
      accessNotes: input.accessNotes,
      comment: input.comment,
      updatedAt: BigInt(now),
    };
    const passport = existing
      ? await tx.objectPassport.update({ where: { id: existing.id }, data })
      : await tx.objectPassport.create({ data: { buildingId: building.id, ...data } });
    await tx.engineerPassportPoint.create({
      data: {
        engineerId,
        operationId: input.operationId,
        points: POINTS_PER_UPDATE,
        awardedAt: BigInt(now),
      },
    });
    return { passport: this.toView(passport, address, now) };
  }

  private async passportFor(address: string) {
    const building = await this.prisma.building.findUnique({
      where: { canonicalAddress: address },
      include: { passport: true },
    });
    if (!building?.passport) return null;
    return {
      view: this.toView(building.passport, building.canonicalAddress, this.clock.nowSeconds()),
      stale: isStale(Number(building.passport.updatedAt), this.clock.nowSeconds()),
    };
  }

  private toView(
    passport: {
      id: string;
      connectionType: ConnectionType;
      difficulty: number;
      equipment: string | null;
      accessNotes: string | null;
      comment: string | null;
      updatedAt: bigint;
    },
    address: string,
    now: number,
  ): PassportView {
    return {
      id: passport.id,
      address,
      connectionType: passport.connectionType,
      difficulty: passport.difficulty,
      equipment: passport.equipment ?? '',
      accessNotes: passport.accessNotes ?? '',
      comment: passport.comment ?? '',
      updatedAt: Number(passport.updatedAt),
      stale: isStale(Number(passport.updatedAt), now),
    };
  }

  /** A request is visible to an engineer only through the currently applied plan. */
  private async assertAssigned(engineerId: string, requestId: string): Promise<void> {
    const current = await this.prisma.appliedPlanCurrent.findUnique({ where: { id: 'singleton' } });
    if (
      !current ||
      !(await this.prisma.appliedPlanAssignment.findFirst({
        where: { planId: current.planId, requestId, engineerId, status: 'assigned' },
        select: { id: true },
      }))
    ) {
      throw SysError.notFound('Request');
    }
  }

  private async requireRequest(requestId: string) {
    const request = await this.prisma.request.findUnique({
      where: { id: requestId },
      select: { id: true },
    });
    if (!request) throw SysError.notFound('Request');
  }

  /** Delegates current-stop calculation to the LIVE state machine; it intentionally
   * never accepts a client-supplied boolean or treats an assigned future stop as live. */
  private async isLiveCurrent(engineerId: string, requestId: string): Promise<boolean> {
    const running = await this.prisma.liveWorkday.findFirst({
      where: { status: 'running' },
      select: { id: true },
    });
    if (!running) return false;
    const view = await this.live.engineerView(engineerId);
    return view.current?.request.id === requestId;
  }

  /** Gets a provider-backed address or a durable cache result. No coordinate rounding
   * is ever used to invent an address; cache keys use six decimal places (sub-meter precision). */
  private async resolveBuilding(requestId: string): Promise<{ canonicalAddress: string } | null> {
    const request = await this.prisma.request.findUnique({
      where: { id: requestId },
      select: { addressText: true, lat: true, lon: true },
    });
    if (!request) return null;
    const explicit = canonicalTextAddress(request.addressText);
    if (explicit) return { canonicalAddress: explicit };
    // A street-level geocode may be far from the house the dispatcher entered.
    // Never overwrite that explicit address with a nearby building.
    if (!isCoordinateAddress(request.addressText) || request.lat === null || request.lon === null)
      return null;
    const key = `${request.lat.toFixed(6)},${request.lon.toFixed(6)}`;
    const cached = await this.prisma.reverseGeocodeCache.findUnique({
      where: { coordinateKey: key },
    });
    if (cached) return { canonicalAddress: cached.canonicalAddress };
    const token = this.config.get('LOCATION_IQ_TOKEN');
    if (!token) return null;
    const url = new URL(REVERSE_URL);
    url.searchParams.set('key', token);
    url.searchParams.set('lat', String(request.lat));
    url.searchParams.set('lon', String(request.lon));
    url.searchParams.set('format', 'json');
    url.searchParams.set('addressdetails', '1');
    url.searchParams.set('accept-language', 'ru');
    url.searchParams.set('normalizeaddress', '1');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4_000);
    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const value = (await response.json()) as { address?: unknown };
      const canonicalAddress = canonicalBuildingAddress(value.address);
      if (!canonicalAddress) return null;
      await this.prisma.reverseGeocodeCache.upsert({
        where: { coordinateKey: key },
        update: {
          canonicalAddress,
          provider: 'locationiq',
          resolvedAt: BigInt(this.clock.nowSeconds()),
        },
        create: {
          coordinateKey: key,
          canonicalAddress,
          provider: 'locationiq',
          resolvedAt: BigInt(this.clock.nowSeconds()),
        },
      });
      return { canonicalAddress };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async monthlyPointsIn(
    client: Pick<PrismaService, 'engineerPassportPoint'> | Pick<Tx, 'engineerPassportPoint'>,
    engineerId: string,
    now: number,
  ): Promise<number> {
    const [start, end] = moscowMonthBounds(now);
    const total = await client.engineerPassportPoint.aggregate({
      where: { engineerId, awardedAt: { gte: BigInt(start), lt: BigInt(end) } },
      _sum: { points: true },
    });
    return total._sum.points ?? 0;
  }
}
