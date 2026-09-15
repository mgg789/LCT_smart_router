import { Injectable } from '@nestjs/common';
import { Clock } from '../../common/time';
import { PrismaService } from '../../persistence';

/**
 * Voluntary collection of position reports.
 *
 * This is the whole of the geolocation feature in the current design. The observations
 * are stored and nothing else: they are not an input to routing, they do not confirm an
 * arrival, they do not reconstruct a track and they do not compute actual mileage
 * (context/37 section 5.1).
 *
 * An engineer may leave geolocation off entirely. Receiving work, marking facts and
 * moving through the day must not depend on it (context/42 DF-09).
 *
 * Deliberately outside the operation envelope: a position report is telemetry, not a
 * business change. It is not idempotent, it publishes nothing, and wrapping it would put
 * a row in the journal for every point.
 */
@Injectable()
export class GpsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  async record(accountId: string, observedAt: number, lat: number, lon: number): Promise<void> {
    await this.prisma.gpsObservation.create({
      data: {
        // The subject is the authorised caller, never a user id chosen in the payload
        // (context/37 section 5.2).
        accountId,
        // The time of the observation itself is kept separate from the time it arrived,
        // so a late report is never mistaken for a fresher position.
        observedAt: BigInt(observedAt),
        recordedAt: BigInt(this.clock.nowSeconds()),
        lat,
        lon,
      },
    });
  }

  /**
   * The last position that was actually observed.
   *
   * Returned together with its observation time, because an old row does not prove where
   * someone is now. A caller that wants "the current position" has to decide for itself
   * whether this observation is fresh enough; the System Layer will not guess
   * (context/37 section 5.2).
   */
  async lastKnown(
    accountId: string,
  ): Promise<{ lat: number; lon: number; observedAt: number } | null> {
    const observation = await this.prisma.gpsObservation.findFirst({
      where: { accountId },
      orderBy: { observedAt: 'desc' },
    });
    return observation
      ? { lat: observation.lat, lon: observation.lon, observedAt: Number(observation.observedAt) }
      : null;
  }
}
